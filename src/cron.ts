/**
 * @file cron.ts
 * @description 排程服務 — 仿 OpenClaw 的 timer loop + job 持久化
 *
 * 核心機制：
 * 1. setTimeout loop 輪詢到期 job（2-60s 間隔）
 * 2. croner 解析 cron 表達式、計算下次執行時間
 * 3. 兩種 action：message（直接發訊息）/ claude（spawn Claude turn）
 * 4. Job 定義 + 狀態統一持久化到 data/cron-jobs.json
 * 5. fs.watch() 監聽 cron-jobs.json 變更，自動 hot-reload
 * 6. 重試 + 指數退避
 * 7. 併發限制
 *
 * 對外 API：startCron(client) / stopCron()
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, watch, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { Cron } from "croner";
import type { Client, SendableChannels } from "discord.js";
import { config, resolveWorkspaceDir } from "./config.js";
import type { CronSchedule, CronAction } from "./config.js";
import { runClaudeTurn } from "./acp.js";
import { log } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** cron-jobs.json 中每個 job 的完整結構（定義 + 狀態合併） */
interface CronJobEntry {
  // ── 定義（使用者設定）──
  name: string;
  enabled?: boolean;
  schedule: CronSchedule;
  action: CronAction;
  /** 一次性 job 執行後自動刪除 */
  deleteAfterRun?: boolean;
  /** 重試次數上限，預設 3 */
  maxRetries?: number;

  // ── 狀態（系統追蹤）──
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastResult?: "success" | "error";
  lastError?: string;
  retryCount?: number;
}

/** cron-jobs.json 的完整結構 */
interface CronStore {
  version: 1;
  jobs: Record<string, CronJobEntry>;
}

/** 運行時 job（id + entry 引用） */
interface CronJobRuntime {
  id: string;
  entry: CronJobEntry;
}

// ── 常數 ────────────────────────────────────────────────────────────────────

// 存在 workspace/data/ 下，讓 cron 資料跟著 workspace 走
const STORE_PATH = join(resolveWorkspaceDir(), "data", "cron-jobs.json");
const MIN_TIMER_MS = 2_000;
const MAX_TIMER_MS = 60_000;
const IS_WIN = platform() === "win32";

/** 重試退避時間表（毫秒） */
const BACKOFF_SCHEDULE_MS = [
  30_000,      // 第 1 次 → 30s
  60_000,      // 第 2 次 → 1 min
  300_000,     // 第 3 次 → 5 min
];

// ── Shell 偵測 ─────────────────────────────────────────────────────────────

/** shell 名稱 → 執行資訊 */
interface ShellInfo {
  /** 完整路徑或指令名 */
  bin: string;
  /** 傳入指令的 args 格式（command 會被 append） */
  args: (cmd: string) => string[];
}

/**
 * 啟動時偵測可用 shell，快取結果
 * Windows 優先順序：bash（Git Bash）→ powershell → cmd
 * Unix 優先順序：sh → bash
 */
function detectShells(): Map<string, ShellInfo> {
  const found = new Map<string, ShellInfo>();

  if (IS_WIN) {
    // Git Bash — 從常見路徑探測
    const gitBashCandidates = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "usr", "bin", "bash.exe"),
    ];
    for (const p of gitBashCandidates) {
      if (existsSync(p)) {
        found.set("bash", { bin: p, args: (cmd) => ["-c", cmd] });
        break;
      }
    }
    // PowerShell（幾乎一定存在）
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(ps)) {
      found.set("powershell", { bin: ps, args: (cmd) => ["-NoProfile", "-Command", cmd] });
    }
    // cmd（一定存在）
    const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    found.set("cmd", { bin: cmd, args: (c) => ["/c", c] });
  } else {
    // Unix
    found.set("sh", { bin: "/bin/sh", args: (cmd) => ["-c", cmd] });
    if (existsSync("/usr/bin/bash") || existsSync("/bin/bash")) {
      found.set("bash", { bin: existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "/bin/bash", args: (cmd) => ["-c", cmd] });
    }
  }

  return found;
}

/** 可用 shell 快取（啟動時偵測一次） */
const availableShells = detectShells();

/** 預設 shell：Windows=bash>powershell>cmd, Unix=sh */
const defaultShell: ShellInfo | undefined =
  IS_WIN
    ? (availableShells.get("bash") ?? availableShells.get("powershell") ?? availableShells.get("cmd"))
    : (availableShells.get("sh") ?? availableShells.get("bash"));

// ── 內部狀態 ────────────────────────────────────────────────────────────────

let discordClient: Client | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** 當前載入的 store（記憶體中的 source of truth） */
let store: CronStore = { version: 1, jobs: {} };
/** 防止自己寫入觸發 watch 的 flag */
let selfWriting = false;

// ── Schedule 計算 ───────────────────────────────────────────────────────────

/**
 * 計算 schedule 的下次執行時間
 * @returns epoch ms，若無法計算回傳 Infinity
 */
function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number {
  switch (schedule.kind) {
    case "cron": {
      try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        const next = cron.nextRun();
        return next ? next.getTime() : Infinity;
      } catch {
        log.warn(`[cron] 無效的 cron 表達式：${schedule.expr}`);
        return Infinity;
      }
    }
    case "every":
      return nowMs + schedule.everyMs;
    case "at": {
      const ts = new Date(schedule.at).getTime();
      return isNaN(ts) ? Infinity : ts;
    }
  }
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

/** 從磁碟載入 store */
function loadStore(): CronStore {
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as CronStore;
    if (parsed.version !== 1 || !parsed.jobs) {
      log.warn("[cron] cron-jobs.json 格式不正確，使用空 store");
      return { version: 1, jobs: {} };
    }
    return parsed;
  } catch {
    return { version: 1, jobs: {} };
  }
}

/**
 * 將 store 寫入磁碟（原子寫入）
 * 寫入時設定 selfWriting flag，避免 watch 觸發重複 reload
 */
function saveStore(): void {
  try {
    const dir = dirname(STORE_PATH);
    mkdirSync(dir, { recursive: true });
    const tmpFile = STORE_PATH + ".tmp";
    selfWriting = true;
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpFile, STORE_PATH);
    // 延遲重置 flag，讓 watch 的 debounce 有機會過濾掉
    setTimeout(() => { selfWriting = false; }, 1000);
  } catch (err) {
    selfWriting = false;
    log.warn(`[cron] 儲存 cron-jobs.json 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Job 初始化 ──────────────────────────────────────────────────────────────

/**
 * 從 cron-jobs.json 載入所有 job，補齊缺少的狀態欄位
 */
function initJobs(): void {
  store = loadStore();
  const nowMs = Date.now();

  for (const [id, entry] of Object.entries(store.jobs)) {
    // 補齊狀態欄位預設值
    entry.retryCount ??= 0;
    entry.nextRunAtMs ??= computeNextRunAtMs(entry.schedule, nowMs);

    // 若 nextRunAtMs 已過期（例如 bot 離線期間），立即排到下一次
    if (entry.nextRunAtMs < nowMs && entry.schedule.kind !== "at") {
      entry.nextRunAtMs = computeNextRunAtMs(entry.schedule, nowMs);
    }

    log.debug(`[cron] 載入 job: ${entry.name} (${id}), next: ${new Date(entry.nextRunAtMs).toISOString()}`);
  }

  log.info(`[cron] 已載入 ${Object.keys(store.jobs).length} 個 job`);
  saveStore();
}

/**
 * Hot-reload：重新載入 cron-jobs.json，保留正在執行中的 job 狀態
 */
function reloadJobs(): void {
  const newStore = loadStore();
  const nowMs = Date.now();

  // 合併：新 store 的定義為主，保留舊 store 中仍在跑的 job 狀態
  for (const [id, entry] of Object.entries(newStore.jobs)) {
    const existing = store.jobs[id];
    if (existing) {
      // 保留執行狀態，用新的定義覆蓋
      entry.nextRunAtMs ??= existing.nextRunAtMs;
      entry.lastRunAtMs ??= existing.lastRunAtMs;
      entry.lastResult ??= existing.lastResult;
      entry.lastError ??= existing.lastError;
      entry.retryCount ??= existing.retryCount;
    } else {
      // 新 job，初始化狀態
      entry.retryCount ??= 0;
      entry.nextRunAtMs ??= computeNextRunAtMs(entry.schedule, nowMs);
    }
  }

  store = newStore;
  log.info(`[cron] hot-reload 完成，${Object.keys(store.jobs).length} 個 job`);

  // 重新 arm timer（schedule 可能變了）
  if (running) {
    if (timer) clearTimeout(timer);
    armTimer();
  }
}

// ── Hot-Reload Watcher ──────────────────────────────────────────────────────

/**
 * 監聽 cron-jobs.json 變更，自動 reload（500ms debounce）
 */
function watchCronJobs(): void {
  if (!existsSync(STORE_PATH)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    watch(STORE_PATH, () => {
      // 自己寫入的不觸發 reload
      if (selfWriting) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        log.info("[cron] 偵測到 cron-jobs.json 變動，重新載入...");
        reloadJobs();
      }, 500);
    });
    log.info("[cron] 已啟動 cron-jobs.json 監聽（hot-reload）");
  } catch (err) {
    log.warn(`[cron] 無法監聽 cron-jobs.json：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Job 執行 ────────────────────────────────────────────────────────────────

/**
 * 執行 message action：直接發訊息到頻道
 */
async function execMessage(channelId: string, text: string): Promise<void> {
  if (!discordClient) throw new Error("Discord client 未初始化");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`找不到頻道或無法發送：${channelId}`);
  }
  await (channel as SendableChannels).send(text);
}

/**
 * 執行 claude action：spawn Claude turn，收集回覆文字，發送到頻道
 */
async function execClaude(channelId: string, prompt: string): Promise<void> {
  if (!discordClient) throw new Error("Discord client 未初始化");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`找不到頻道或無法發送：${channelId}`);
  }

  // 收集 Claude 回覆
  // cwd 和 binary 路徑由 runClaudeTurn 內部從環境變數取得
  let responseText = "";
  for await (const event of runClaudeTurn(
    null, // 不 resume，每次獨立 session
    prompt,
    channelId, // 排程 job 的目標頻道
  )) {
    if (event.type === "text_delta") {
      responseText += event.text;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }

  // 送出結果
  if (responseText.trim()) {
    const sendable = channel as SendableChannels;
    // 分段送出（2000 字上限）
    let remaining = responseText.trim();
    while (remaining.length > 0) {
      await sendable.send(remaining.slice(0, 2000));
      remaining = remaining.slice(2000);
    }
  }
}

/**
 * 執行 exec action：直接跑 shell 指令
 *
 * Shell 選擇邏輯：
 * 1. job 指定 shell（"bash"/"sh"/"cmd"/"powershell"）→ 直接使用
 * 2. 未指定 → 自動偵測（Windows: bash>powershell>cmd, Unix: sh>bash）
 *
 * 可選將 stdout 結果送到 channelId，失敗時也會回報錯誤
 */
async function execCommand(command: string, channelId?: string, silent?: boolean, timeoutSec?: number, shellOverride?: string): Promise<void> {
  const cwd = resolveWorkspaceDir();
  const timeout = (timeoutSec ?? 120) * 1000;

  // shell 選擇：job 指定 > 自動偵測
  const shell = shellOverride
    ? availableShells.get(shellOverride)
    : defaultShell;

  if (!shell) {
    const available = [...availableShells.keys()].join(", ") || "(none)";
    throw new Error(`找不到 shell${shellOverride ? ` "${shellOverride}"` : ""}（可用: ${available}）`);
  }

  const env = {
    ...process.env,
    // 強制 Python/子程序 UTF-8 輸出，避免 Windows cp950 亂碼
    ...(IS_WIN ? { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } : {}),
  };

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(shell.bin, shell.args(command), { cwd, timeout, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        const detail = (err as NodeJS.ErrnoException & { killed?: boolean; signal?: string });
        const reason = detail.killed
          ? `timeout (${detail.signal ?? "SIGTERM"}) after ${timeout / 1000}s`
          : `exit ${err.code ?? "unknown"}: ${stderr.trim() || err.message}`;
        reject(new Error(reason));
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });

  if (result.stderr) {
    log.warn(`[cron/exec] stderr: ${result.stderr}`);
  }

  // 有 channelId 且非 silent → 回報結果
  if (channelId && !silent && discordClient) {
    const channel = await discordClient.channels.fetch(channelId);
    if (channel && "send" in channel) {
      const output = result.stdout || "(no output)";
      let remaining = output;
      const sendable = channel as SendableChannels;
      while (remaining.length > 0) {
        await sendable.send(remaining.slice(0, 2000));
        remaining = remaining.slice(2000);
      }
    }
  }

  log.info(`[cron/exec] 完成: ${command}${result.stdout ? ` → ${result.stdout.slice(0, 100)}` : ""}`);
}

/**
 * 執行單一 job
 */
async function runJob(job: CronJobRuntime): Promise<void> {
  const { id, entry } = job;
  log.info(`[cron] 執行 job: ${entry.name} (${id})`);

  try {
    if (entry.action.type === "message") {
      await execMessage(entry.action.channelId, entry.action.text);
    } else if (entry.action.type === "exec") {
      await execCommand(entry.action.command, entry.action.channelId, entry.action.silent, entry.action.timeoutSec, entry.action.shell);
    } else {
      await execClaude(entry.action.channelId, entry.action.prompt);
    }

    // 成功
    entry.lastResult = "success";
    entry.lastError = undefined;
    entry.retryCount = 0;
    entry.lastRunAtMs = Date.now();

    // 一次性 job → 移除
    if (entry.deleteAfterRun || entry.schedule.kind === "at") {
      log.info(`[cron] 一次性 job 完成，移除：${entry.name}`);
      delete store.jobs[id];
    } else {
      // 計算下次執行時間
      entry.nextRunAtMs = computeNextRunAtMs(entry.schedule, Date.now());
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[cron] job 執行失敗：${entry.name} — ${message}`);

    entry.lastResult = "error";
    entry.lastError = message;
    entry.lastRunAtMs = Date.now();

    const maxRetries = entry.maxRetries ?? 3;
    const retryCount = entry.retryCount ?? 0;
    const isLastAttempt = retryCount >= maxRetries;

    // 只在最後一次重試失敗時才回報頻道（避免重試期間連續洗版）
    if (isLastAttempt) {
      const actionChannelId = "channelId" in entry.action ? (entry.action as { channelId?: string }).channelId : undefined;
      if (actionChannelId && !(entry.action as { silent?: boolean }).silent && discordClient) {
        try {
          const ch = await discordClient.channels.fetch(actionChannelId);
          if (ch && "send" in ch) {
            const retryInfo = maxRetries > 0 ? `（已重試 ${maxRetries} 次）` : "";
            const errorMsg = `⚠️ 排程 **${entry.name}** 執行失敗${retryInfo}：${message}`.slice(0, 2000);
            await (ch as SendableChannels).send(errorMsg);
          }
        } catch {
          // 發送失敗不影響流程
        }
      }
    }

    if (retryCount < maxRetries) {
      // 重試：指數退避
      const backoffMs = BACKOFF_SCHEDULE_MS[Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1)];
      entry.retryCount = retryCount + 1;
      entry.nextRunAtMs = Date.now() + backoffMs;
      log.info(`[cron] 排程重試 #${entry.retryCount}（${Math.round(backoffMs / 1000)}s 後）：${entry.name}`);
    } else {
      // 超過重試上限，跳到下次正常排程
      entry.retryCount = 0;
      if (entry.schedule.kind !== "at") {
        entry.nextRunAtMs = computeNextRunAtMs(entry.schedule, Date.now());
      } else {
        log.warn(`[cron] 一次性 job 重試用盡，移除：${entry.name}`);
        delete store.jobs[id];
      }
    }
  }

  saveStore();
}

// ── Timer Loop（仿 OpenClaw） ───────────────────────────────────────────────

/**
 * 找出所有到期的 job
 */
function collectRunnableJobs(nowMs: number): CronJobRuntime[] {
  const due: CronJobRuntime[] = [];
  for (const [id, entry] of Object.entries(store.jobs)) {
    if (entry.enabled !== false && (entry.nextRunAtMs ?? Infinity) <= nowMs) {
      due.push({ id, entry });
    }
  }
  return due;
}

/**
 * timer tick：找到期 job → 並行執行（受 maxConcurrentRuns 限制）→ 重新 arm
 */
async function onTimer(): Promise<void> {
  const nowMs = Date.now();
  const dueJobs = collectRunnableJobs(nowMs);

  if (dueJobs.length > 0) {
    const concurrency = Math.min(config.cron.maxConcurrentRuns, dueJobs.length);
    let cursor = 0;

    // Worker pool pattern（仿 OpenClaw）
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= dueJobs.length) return;
        await runJob(dueJobs[index]);
      }
    });

    await Promise.all(workers);
  }

  // 重新 arm timer
  armTimer();
}

/**
 * 計算下一個 timer 到期時間，設定 setTimeout
 */
function armTimer(): void {
  if (!running) return;

  // 找最近的 nextRunAtMs
  let earliest = Infinity;
  for (const entry of Object.values(store.jobs)) {
    if (entry.enabled !== false && (entry.nextRunAtMs ?? Infinity) < earliest) {
      earliest = entry.nextRunAtMs!;
    }
  }

  const nowMs = Date.now();
  const delayMs = earliest === Infinity
    ? MAX_TIMER_MS
    : Math.max(MIN_TIMER_MS, Math.min(earliest - nowMs, MAX_TIMER_MS));

  timer = setTimeout(() => {
    void onTimer().catch((err) => {
      log.error(`[cron] timer tick 失敗：${err instanceof Error ? err.message : String(err)}`);
      armTimer(); // 出錯也要繼續
    });
  }, delayMs);
}

// ── 對外 API ────────────────────────────────────────────────────────────────

/**
 * 啟動排程服務
 * @param client Discord Client（用於發送訊息）
 */
export function startCron(client: Client): void {
  if (!config.cron.enabled) {
    log.info("[cron] 排程服務未啟用（cron.enabled = false）");
    return;
  }

  discordClient = client;
  running = true;

  initJobs();
  watchCronJobs();
  armTimer();

  const shellNames = [...availableShells.keys()].join(", ");
  const defaultName = defaultShell ? [...availableShells.entries()].find(([, v]) => v === defaultShell)?.[0] ?? "?" : "none";
  log.info(`[cron] 排程服務已啟動（${Object.keys(store.jobs).length} 個 job，max concurrent: ${config.cron.maxConcurrentRuns}，shells: [${shellNames}]，default: ${defaultName}）`);
}

/**
 * 停止排程服務
 */
export function stopCron(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log.info("[cron] 排程服務已停止");
}
