/**
 * @file session.ts
 * @description Claude session 管理 + per-channel 串行佇列 + 磁碟持久化
 *
 * 職責：
 * 1. 維護 channelId → session_id（UUID）的快取
 *    首次對話由 claude CLI 建立 session，從 session_init event 取得 ID
 *    後續對話帶 --resume <session_id> 延續上下文
 * 2. 以 Promise chain 實作 per-channel 串行佇列
 *    （同一 channel 的 turn 必須串行，不同 channel 完全並行）
 * 3. 磁碟持久化：sessionCache 寫入 data/sessions.json，重啟不遺失
 * 4. TTL 機制：超過 sessionTtlHours 的 session 自動開新（不帶 --resume）
 * 5. 錯誤處理：錯誤時保留 session，下次訊息繼續 --resume 同一 session
 * 6. 對外只暴露 enqueue() + loadSessions()，呼叫方不需要關心 session 細節
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { runClaudeTurn, type AcpEvent } from "./acp.js";
import { resolveWorkspaceDir } from "./config.js";
import { log } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** enqueue 收到的 event 回呼 */
export type OnEvent = (event: AcpEvent) => void | Promise<void>;

/** sessions.json 內每個 channel 的資料 */
interface SessionRecord {
  sessionId: string;
  updatedAt: number;
}

/** sessions.json 的完整結構 */
type SessionStore = Record<string, SessionRecord>;

/** active-turns/{channelId}.json 的結構 */
export interface ActiveTurnRecord {
  /** turn 開始時間（用於過期判斷） */
  startedAt: number;
  /** 使用者 prompt 前 200 字（重啟後顯示給使用者確認） */
  prompt: string;
}

// ── 持久化路徑 ──────────────────────────────────────────────────────────────

// 存在 workspace/data/ 下，讓 session 資料跟著 workspace 走，不依賴 process.cwd()
const SESSION_FILE = join(resolveWorkspaceDir(), "data", "sessions.json");

/** active-turn 追蹤目錄：每個頻道一個檔案，用於 crash recovery */
const ACTIVE_TURNS_DIR = join(resolveWorkspaceDir(), "data", "active-turns");

// ── 內部狀態 ────────────────────────────────────────────────────────────────

/** channelId → session_id（UUID，由 claude CLI 產生） */
const sessionCache = new Map<string, string>();

/** channelId → updatedAt timestamp */
const sessionUpdatedAt = new Map<string, number>();

/**
 * channelId → Promise chain 尾端
 * per-channel 串行佇列核心：每個新 turn 接在上一個 Promise 後面
 */
const queues = new Map<string, Promise<void>>();

// ── 磁碟 I/O ────────────────────────────────────────────────────────────────

/**
 * 啟動時從 data/sessions.json 載入 session 快取
 * 檔案不存在或格式錯誤時靜默忽略（視為首次啟動）
 */
export function loadSessions(): void {
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const store = JSON.parse(raw) as SessionStore;
    let loaded = 0;
    for (const [channelId, record] of Object.entries(store)) {
      if (record?.sessionId && record?.updatedAt) {
        sessionCache.set(channelId, record.sessionId);
        sessionUpdatedAt.set(channelId, record.updatedAt);
        loaded++;
      }
    }
    log.info(`[session] 從磁碟載入 ${loaded} 個 session`);
  } catch {
    // 檔案不存在或 JSON 格式錯誤，靜默忽略
    log.debug("[session] sessions.json 不存在或無法解析，從空白狀態啟動");
  }
}

/**
 * 將 sessionCache 寫入磁碟（原子寫入：write tmp → rename）
 * 寫入前清理超過 TTL 的過期項目
 *
 * @param ttlMs 過期門檻（毫秒），超過此時間的 session 不寫入
 */
function saveSessions(ttlMs: number): void {
  const now = Date.now();
  const store: SessionStore = {};

  for (const [channelId, sessionId] of sessionCache) {
    const updatedAt = sessionUpdatedAt.get(channelId) ?? now;
    // 清理過期 session（不寫入檔案，也從記憶體清除）
    if (now - updatedAt > ttlMs) {
      sessionCache.delete(channelId);
      sessionUpdatedAt.delete(channelId);
      log.debug(`[session] 清理過期 session channel=${channelId}`);
      continue;
    }
    store[channelId] = { sessionId, updatedAt };
  }

  try {
    const dir = dirname(SESSION_FILE);
    mkdirSync(dir, { recursive: true });

    // 原子寫入：先寫暫存檔，再 rename 覆蓋
    const tmpFile = SESSION_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpFile, SESSION_FILE);
    log.debug(`[session] 已儲存 ${Object.keys(store).length} 個 session 到磁碟`);
  } catch (err) {
    log.warn(`[session] 儲存 sessions.json 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 取得最近活躍的 channel ID 列表（用於重啟通知等）
 * 只回傳 TTL 內的 channel
 *
 * @param ttlMs 過期門檻（毫秒）
 * @returns 最近活躍的 channel ID 陣列
 */
export function getRecentChannelIds(ttlMs: number): string[] {
  const now = Date.now();
  const result: string[] = [];
  for (const [channelId] of sessionCache) {
    const updatedAt = sessionUpdatedAt.get(channelId) ?? 0;
    if (now - updatedAt <= ttlMs) {
      result.push(channelId);
    }
  }
  return result;
}

// ── Active-turn 追蹤 ─────────────────────────────────────────────────────────
// turn 執行中寫入 data/active-turns/{channelId}.json，結束時刪除
// 若 crash 後殘留，index.ts 啟動時掃描並向使用者確認是否接續

/**
 * 標記 turn 開始（寫入 active-turn file）
 * @param channelId Discord channel ID
 * @param prompt 使用者 prompt（截斷至 200 字）
 */
function markTurnActive(channelId: string, prompt: string): void {
  try {
    mkdirSync(ACTIVE_TURNS_DIR, { recursive: true });
    const record: ActiveTurnRecord = {
      startedAt: Date.now(),
      prompt: prompt.slice(0, 200),
    };
    writeFileSync(
      join(ACTIVE_TURNS_DIR, `${channelId}.json`),
      JSON.stringify(record),
      "utf-8"
    );
  } catch (err) {
    log.warn(`[session] markTurnActive 失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 標記 turn 結束（刪除 active-turn file）
 * @param channelId Discord channel ID
 */
function markTurnDone(channelId: string): void {
  try {
    unlinkSync(join(ACTIVE_TURNS_DIR, `${channelId}.json`));
  } catch {
    // 檔案不存在時靜默忽略
  }
}

/**
 * 掃描 active-turns 目錄，回傳未過期的中斷 turn 列表
 * 掃描後清理所有檔案（無論是否過期）
 *
 * @param maxAgeMs 過期門檻（毫秒），超過此時間的視為過期不接續
 * @returns 未過期的 { channelId, record } 陣列
 */
export function scanAndCleanActiveTurns(maxAgeMs: number = 10 * 60_000): Array<{ channelId: string; record: ActiveTurnRecord }> {
  const result: Array<{ channelId: string; record: ActiveTurnRecord }> = [];

  if (!existsSync(ACTIVE_TURNS_DIR)) return result;

  try {
    const files = readdirSync(ACTIVE_TURNS_DIR).filter(f => f.endsWith(".json"));
    const now = Date.now();

    for (const file of files) {
      const filePath = join(ACTIVE_TURNS_DIR, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const record = JSON.parse(raw) as ActiveTurnRecord;
        const channelId = file.replace(".json", "");
        const age = now - record.startedAt;

        if (age <= maxAgeMs) {
          result.push({ channelId, record });
          log.info(`[session] 偵測到中斷 turn channel=${channelId} age=${Math.round(age / 1000)}s prompt="${record.prompt.slice(0, 50)}"`);
        } else {
          log.debug(`[session] 忽略過期 active-turn channel=${channelId} age=${Math.round(age / 1000)}s`);
        }

        // 無論是否過期都清理
        unlinkSync(filePath);
      } catch (err) {
        log.warn(`[session] 讀取 active-turn ${file} 失敗: ${err instanceof Error ? err.message : String(err)}`);
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    log.warn(`[session] 掃描 active-turns 失敗: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ── 內部函式 ────────────────────────────────────────────────────────────────

/**
 * 取得有效的 session ID（檢查 TTL，過期則清除）
 *
 * @param channelId Discord channel ID
 * @param ttlMs 過期門檻（毫秒）
 * @returns session ID 或 null（需開新 session）
 */
function getValidSessionId(channelId: string, ttlMs: number): string | null {
  const sessionId = sessionCache.get(channelId);
  if (!sessionId) return null;

  const updatedAt = sessionUpdatedAt.get(channelId) ?? 0;
  if (Date.now() - updatedAt > ttlMs) {
    log.info(`[session] session 已過期 channel=${channelId}，將開新 session`);
    sessionCache.delete(channelId);
    sessionUpdatedAt.delete(channelId);
    return null;
  }

  return sessionId;
}

/**
 * 記錄 session 並持久化到磁碟
 *
 * @param channelId Discord channel ID
 * @param sessionId Claude session ID
 * @param ttlMs 過期門檻（毫秒，寫入時順便清理過期項目）
 */
function recordSession(channelId: string, sessionId: string, ttlMs: number): void {
  sessionCache.set(channelId, sessionId);
  sessionUpdatedAt.set(channelId, Date.now());
  saveSessions(ttlMs);
}

/**
 * 執行單一 turn 的完整流程：串流 event → 逐一回呼 + 攔截 session_init
 * 錯誤時保留 session，下次訊息繼續 --resume 同一 session
 *
 * cwd 和 claudeCmd 已由 acp.ts 內部從環境變數取得，不再從這裡傳入。
 *
 * @param channelId Discord channel ID
 * @param text 使用者訊息文字
 * @param onEvent event 回呼（由 reply.ts 建立，用於更新 Discord 回覆）
 * @param ttlMs session 過期門檻（毫秒）
 * @param signal AbortSignal（可選）
 */
async function runTurn(
  channelId: string,
  text: string,
  onEvent: OnEvent,
  ttlMs: number,
  signal?: AbortSignal
): Promise<void> {
  const existingSessionId = getValidSessionId(channelId, ttlMs);
  log.debug(`[session] runTurn channel=${channelId} sessionId=${existingSessionId ?? "NEW"} text="${text.slice(0, 50)}"`);

  // 標記 turn 開始（crash recovery 用）
  markTurnActive(channelId, text);

  let hasError = false;

  try {
    for await (const event of runClaudeTurn(
      existingSessionId,
      text,
      channelId,
      signal
    )) {
      log.debug(`[session] event: ${event.type}`);

      // 攔截 session_init event：記錄 session ID + 持久化，不轉發給 reply handler
      if (event.type === "session_init") {
        log.info(`[session] session_init: ${event.sessionId}`);
        recordSession(channelId, event.sessionId, ttlMs);
        continue;
      }

      if (event.type === "error") {
        hasError = true;
      }

      await onEvent(event);
    }

    // 錯誤不清除 session：下次訊息繼續 --resume 同一 session
    if (hasError) {
      log.warn(`[session] turn 發生錯誤，保留 session channel=${channelId}`);
    }

    // turn 完成後更新 updatedAt（即使沒有 session_init，表示 resume 成功）
    if (sessionCache.has(channelId)) {
      recordSession(channelId, sessionCache.get(channelId)!, ttlMs);
    }
  } finally {
    // 無論成功或錯誤，turn 結束都清理 active-turn 標記
    markTurnDone(channelId);
  }
}

// ── 對外 API ────────────────────────────────────────────────────────────────

/** enqueue 的選項 */
export interface EnqueueOptions {
  // cwd 和 claudeCmd 已移除，由 acp.ts 從環境變數取得
  /** 回應超時毫秒數，超時自動 abort */
  turnTimeoutMs: number;
  /** session 閒置超時毫秒數 */
  sessionTtlMs: number;
}

/**
 * 將一個 turn 加入指定 channel 的串行佇列
 *
 * 同一 channelId 的呼叫會依序執行，不同 channelId 完全並行。
 *
 * @param channelId Discord channel ID（佇列 key）
 * @param text 使用者訊息文字
 * @param onEvent ACP event 回呼
 * @param opts 設定選項
 */
export function enqueue(
  channelId: string,
  text: string,
  onEvent: OnEvent,
  opts: EnqueueOptions
): void {
  const tail = queues.get(channelId) ?? Promise.resolve();

  // 建立帶 timeout 的 AbortController
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.turnTimeoutMs);

  // 將新 turn 接在尾端，錯誤不向上傳播（避免 Promise chain 中斷）
  const next = tail.then(() =>
    runTurn(channelId, text, onEvent, opts.sessionTtlMs, ac.signal)
      .catch((err: unknown) => {
        const message = ac.signal.aborted
          ? `回應超時（${Math.round(opts.turnTimeoutMs / 1000)}s），已取消`
          : err instanceof Error ? err.message : String(err);
        void onEvent({ type: "error", message });
      })
      .finally(() => clearTimeout(timer))
  );

  queues.set(channelId, next);

  // 佇列完成後清理 Map，避免記憶體洩漏
  next.finally(() => {
    if (queues.get(channelId) === next) {
      queues.delete(channelId);
    }
  });
}
