/**
 * @file cli-bridge/bridge.ts
 * @description CliBridge — 生命週期管理 + 訊息直送
 *
 * 管理一個 CliProcess 的完整生命週期：
 * - 自動重啟（指數退避）
 * - Keep-alive（定期 ping）
 * - 訊息直送 stdin（不排隊，CLI 自己管內部 queue）
 * - Turn 追蹤 + 中斷
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import { resolveCatclawDir } from "../core/config.js";
import { CliProcess } from "./process.js";
import { StdoutLogger } from "./stdout-log.js";
import type {
  CliBridgeConfig,
  CliBridgeChannelConfig,
  CliProcessConfig,
  CliBridgeEvent,
  TurnHandle,
  TurnRecord,
  BridgeStatus,
  StdoutLogEntry,
  StdinImageBlock,
} from "./types.js";
import type { BridgeSender } from "./discord-sender.js";

// ── 預設值 ──────────────────────────────────────────────────────────────────

const DEFAULT_KEEP_ALIVE_MS = 60_000; // 60s 送一次 ping 保活

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const INTERRUPT_TIMEOUT_MS = 5000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000; // 5 分鐘

// ── CliBridge ───────────────────────────────────────────────────────────────

export class CliBridge {
  private process: CliProcess | null = null;
  private stdoutLogger: StdoutLogger;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private restartAttempt = 0;
  private _status: BridgeStatus = "suspended";
  private sessionId: string | null = null;
  /** "already in use" 連續重試次數 */
  private _alreadyInUseCount = 0;
  /** 最近一次 spawn 時間（偵測快速死亡） */
  private _lastSpawnTime = 0;
  /** 最後一次使用時間（idle suspend 判定用） */
  private _lastUsedAt = Date.now();
  /** ensureAlive mutex — 防止多訊息同時觸發雙 spawn */
  private _ensureAliveLock: Promise<void> | null = null;

  // Turn 追蹤
  private activeTurnId: string | null = null;
  private turnListeners = new Map<string, {
    resolve: ((event: CliBridgeEvent) => void) | null;
    queue: CliBridgeEvent[];
    done: boolean;
  }>();

  // Turn timeout
  private turnTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // 累積中的 turn 資訊（recordTurn 用）
  private pendingTurns = new Map<string, {
    record: TurnRecord;
    textParts: string[];
  }>();

  // Discord 發送器（由 index.ts 注入）
  private _sender: BridgeSender | null = null;

  constructor(
    public readonly label: string,
    public readonly channelId: string,
    private bridgeConfig: CliBridgeConfig,
    private readonly channelConfig: CliBridgeChannelConfig,
  ) {
    const logDir = bridgeConfig.logDir ?? "~/.catclaw/data/cli-bridge";
    this.stdoutLogger = new StdoutLogger(logDir, label);
  }

  // ── 啟動 ──────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._status === "busy" || this._status === "idle") {
      log.warn(`[cli-bridge:${this.label}] start: 已在執行中 (${this._status})`);
      return;
    }

    this._status = "restarting";
    this.restartAttempt = 0;

    try {
      await this.spawnProcess();
      this._status = "idle";
      this.restartAttempt = 0;
      this.startKeepAlive();
      log.info(`[cli-bridge:${this.label}] started`);
      // CliBridgeSpawn hook（observer）
      try {
        const { getHookRegistry } = await import("../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("CliBridgeSpawn") > 0) {
          await hookReg.runCliBridgeSpawn({
            event: "CliBridgeSpawn",
            bridgeLabel: this.label,
            cwd: this.bridgeConfig.workingDir,
            resumedSessionId: this.channelConfig.sessionId ?? undefined,
          });
        }
      } catch { /* hook 系統未就緒 */ }

      // ── 上線通知 ──
      void this.sendStartupNotification();

      // ── 補處理 inbound history（離線期間累積的訊息）──
      // 排在「已上線」之後 fire；Discord 先看到 ✅ 再看到 CLI 處理離線訊息
      void this.drainInboundHistoryOnStartup();

      // ── 依 workingDir 自動更新頻道 / 討論串名稱（fire-and-forget）──
      void this.applyAutoChannelName();
    } catch (err) {
      log.error(`[cli-bridge:${this.label}] start failed: ${err instanceof Error ? err.message : String(err)}`);
      // 進入自動重啟迴路（session ID 衝突等暫態問題可自動恢復）
      void this.handleCrash();
    }
  }

  // ── 送訊息（直送 stdin，不排隊）──────────────────────────────────────────

  send(text: string, source: "discord" | "dashboard", meta?: { user?: string; ts?: string; imageBlocks?: StdinImageBlock[]; sourceChannelId?: string }): TurnHandle {
    this._lastUsedAt = Date.now();
    const turnId = randomUUID();

    if (!this.process?.alive) {
      // process 不在 → 觸發重啟，但先回傳 error handle
      void this.handleCrash();
      return this.createErrorHandle(turnId, "CLI process 未啟動，正在重啟...");
    }

    // 建立 turn 追蹤
    const turnState = {
      resolve: null as ((event: CliBridgeEvent) => void) | null,
      queue: [] as CliBridgeEvent[],
      done: false,
    };
    this.turnListeners.set(turnId, turnState);

    // 建立 pending turn record（存原始 text，不污染日誌）
    this.pendingTurns.set(turnId, {
      record: {
        turnId,
        startedAt: new Date().toISOString(),
        source,
        userInput: text,
        toolCalls: [],
        assistantReply: "",
        discordDelivery: source === "dashboard" ? "skipped" : "pending",
      },
      textParts: [],
    });

    // 如果有前一個 turn 還在等 → abort 它（插話場景：CLI 內部會中斷舊 turn，但 listener 不知道）
    if (this.activeTurnId && this.activeTurnId !== turnId) {
      const prevTurnId = this.activeTurnId;
      const prevListener = this.turnListeners.get(prevTurnId);
      if (prevListener && !prevListener.done) {
        prevListener.done = true;
        const abortEvt: CliBridgeEvent = { type: "result", is_error: false, text: "" };
        if (prevListener.resolve) prevListener.resolve(abortEvt);
        else prevListener.queue.push(abortEvt);
        log.debug(`[cli-bridge:${this.label}] 插話：abort 前一個 turn=${prevTurnId.slice(0, 8)}`);
      }
      // 清 pending turn record
      const prev = this.pendingTurns.get(prevTurnId);
      if (prev) {
        prev.record.completedAt = new Date().toISOString();
        prev.record.assistantReply = prev.textParts.join("") || "(interrupted)";
        this.stdoutLogger.recordTurn(prev.record);
        this.pendingTurns.delete(prevTurnId);
      }
      const timer = this.turnTimeouts.get(prevTurnId);
      if (timer) { clearTimeout(timer); this.turnTimeouts.delete(prevTurnId); }
    }

    // 標記 busy
    this.activeTurnId = turnId;
    this._status = "busy";

    // Per-turn meta tag 注入：讓 CLI 每 turn 重新知道部署脈絡，不怕 context 壓縮
    const wrappedText = this.wrapWithChannelTag(text, source, meta);

    // 送 stdin（有圖片時改送 content block 陣列，讓 CLI 直接把 base64 圖傳給 API）
    const imageBlocks = meta?.imageBlocks;
    const content = imageBlocks && imageBlocks.length > 0
      ? [{ type: "text" as const, text: wrappedText }, ...imageBlocks]
      : wrappedText;
    try {
      this.process.send({
        type: "user",
        message: { role: "user", content },
      });
    } catch (err) {
      this.turnListeners.delete(turnId);
      this.pendingTurns.delete(turnId);
      this._status = this.process?.alive ? "idle" : "dead";
      return this.createErrorHandle(turnId, `stdin 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(`[cli-bridge:${this.label}] turn=${turnId.slice(0, 8)} source=${source} sent`);

    // Idle timeout — 連續無事件才觸發，每收到事件重置
    this.resetTurnTimeout(turnId);

    // 回傳 TurnHandle
    const events = this.createTurnGenerator(turnId);
    return {
      turnId,
      events,
      abort: () => this.abortTurn(turnId),
    };
  }

  // ── control_request 回覆 ──────────────────────────────────────────────────

  sendControlResponse(requestId: string, allowed: boolean): void {
    if (!this.process?.alive) return;
    try {
      this.process.send({
        type: "control_response",
        permission_request_id: requestId,
        allowed,
      });
      log.info(`[cli-bridge:${this.label}] control_response ${requestId} allowed=${allowed}`);
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] control_response 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── timeout 行為執行（reply handler 呼叫）─────────────────────────────────

  executeTimeoutAction(turnId: string, action: "wait" | "interrupt" | "restart"): void {
    if (action === "wait") {
      // 繼續等 — 重新啟動 idle timeout
      this.resetTurnTimeout(turnId);
      log.info(`[cli-bridge:${this.label}] turn=${turnId.slice(0, 8)} timeout → 使用者選擇繼續等待`);
      return;
    }

    // interrupt / restart — 結束 turn
    const listener = this.turnListeners.get(turnId);
    if (listener && !listener.done) {
      listener.done = true;
      if (listener.resolve) listener.resolve({ type: "error", message: `使用者選擇${action === "interrupt" ? "中斷" : "重啟"}` });
      else listener.queue.push({ type: "error", message: `使用者選擇${action === "interrupt" ? "中斷" : "重啟"}` });
    }

    if (action === "restart") {
      void this.restart();
    } else {
      void this.interrupt();
    }
  }

  // ── 中斷 ──────────────────────────────────────────────────────────────────

  async interrupt(): Promise<void> {
    if (!this.process?.alive) return;

    log.info(`[cli-bridge:${this.label}] interrupt requested`);
    this.process.sendInterrupt();

    // 等待 result event（最多 INTERRUPT_TIMEOUT_MS）
    const interrupted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
      const onEvent = (evt: CliBridgeEvent) => {
        if (evt.type === "result") {
          clearTimeout(timer);
          this.process?.removeListener("event", onEvent);
          resolve(true);
        }
      };
      this.process?.on("event", onEvent);
    });

    if (!interrupted) {
      log.warn(`[cli-bridge:${this.label}] interrupt timeout, restarting`);
      await this.restart();
    }
  }

  // ── 重啟 / 關閉 ──────────────────────────────────────────────────────────

  async restart(): Promise<void> {
    log.info(`[cli-bridge:${this.label}] restart`);
    this._status = "restarting";
    this.stopKeepAlive();

    // 清理正在等待的 turn
    this.failAllPendingTurns("bridge 重啟中");

    if (this.process?.alive) {
      await this.process.shutdown();
    }

    this.restartAttempt = 0;
    try {
      await this.spawnProcess();
      this._status = "idle";
      this.startKeepAlive();
    } catch (err) {
      this._status = "dead";
      log.error(`[cli-bridge:${this.label}] restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get workingDir(): string {
    return this.bridgeConfig.workingDir;
  }

  /** 清除 runtime + 持久化 sessionId（僅 /session new 使用） */
  clearSessionId(): void {
    this.sessionId = null;
    (this.channelConfig as { sessionId?: string | null }).sessionId = null;
    // 同步清除 json
    try {
      const configPath = join(resolveCatclawDir(), "cli-bridges.json");
      const raw = readFileSync(configPath, "utf-8");
      const configs = JSON.parse(raw) as CliBridgeConfig[];
      if (Array.isArray(configs)) {
        const cfg = configs.find(c => c.label === this.bridgeConfig.label);
        const chCfg = cfg?.channels[this.channelId];
        if (chCfg && chCfg.sessionId) {
          delete chCfg.sessionId;
          writeFileSync(configPath, JSON.stringify(configs, null, 2), "utf-8");
        }
      }
    } catch { /* 靜默 */ }
    // 同步清理日誌：stdout 全清 + turns 合併（保留統計）+ TTL 60 天
    try {
      this.stdoutLogger.truncateStdout();
      const { merged, expired } = this.stdoutLogger.compactTurns(60);
      log.info(`[cli-bridge:${this.label}] 日誌清理：stdout 已清空、turns merged=${merged} expired=${expired}`);
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] 日誌清理失敗：${err instanceof Error ? err.message : String(err)}`);
    }
    log.info(`[cli-bridge:${this.label}] sessionId 已清除（runtime + json）`);
  }

  /** 將 sessionId 持久化到 cli-bridges.json 的 channel config */
  private persistSessionId(sid: string): void {
    try {
      const configPath = join(resolveCatclawDir(), "cli-bridges.json");
      const raw = readFileSync(configPath, "utf-8");
      const configs = JSON.parse(raw) as CliBridgeConfig[];
      if (!Array.isArray(configs)) return;

      const cfg = configs.find(c => c.label === this.bridgeConfig.label);
      if (!cfg) return;

      const chCfg = cfg.channels[this.channelId];
      if (!chCfg) return;

      if (chCfg.sessionId === sid) return; // 已是同一個，不寫
      chCfg.sessionId = sid;
      writeFileSync(configPath, JSON.stringify(configs, null, 2), "utf-8");
      log.info(`[cli-bridge:${this.label}] sessionId 已持久化：${sid}`);
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] sessionId 持久化失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    log.info(`[cli-bridge:${this.label}] shutdown`);
    this.stopKeepAlive();
    this.failAllPendingTurns("bridge 關閉中", true);

    if (this.process?.alive) {
      await this.process.shutdown();
    }
    if (this._sender) {
      await this._sender.destroy();
      this._sender = null;
    }
    this._status = "dead";
  }

  // ── Idle Suspend / Resume ──────────────────────────────────────────────────

  async ensureAlive(): Promise<void> {
    if (this._status === "idle" || this._status === "busy") return;
    if (this._ensureAliveLock) return this._ensureAliveLock;
    this._ensureAliveLock = (async () => {
      try {
        this._sender?.sendTyping();
        log.info(`[cli-bridge:${this.label}] 喚醒中（status=${this._status}）`);
        await this.start();
      } finally {
        this._ensureAliveLock = null;
      }
    })();
    return this._ensureAliveLock;
  }

  async suspend(): Promise<void> {
    if (this._status === "suspended" || this._status === "dead") return;
    const idleMs = Date.now() - this._lastUsedAt;
    log.info(`[cli-bridge:${this.label}] idle suspend`);
    this.stopKeepAlive();
    this.failAllPendingTurns("bridge idle suspend");
    if (this.process?.alive) {
      await this.process.shutdown();
    }
    this.process = null;
    this._status = "suspended";
    // CliBridgeSuspend hook（observer）
    try {
      const { getHookRegistry } = await import("../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("CliBridgeSuspend") > 0) {
        await hookReg.runCliBridgeSuspend({
          event: "CliBridgeSuspend",
          bridgeLabel: this.label,
          idleMs,
        });
      }
    } catch { /* ignore */ }
  }

  // ── 狀態查詢 ──────────────────────────────────────────────────────────────

  get status(): BridgeStatus {
    return this._status;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  getTurnHistory(limit = 50): TurnRecord[] {
    return this.stdoutLogger.getTurnHistory(limit);
  }

  getRecentLogs(limit = 100): StdoutLogEntry[] {
    return this.stdoutLogger.getRecentEvents(limit);
  }

  getStdoutLogger(): StdoutLogger {
    return this.stdoutLogger;
  }

  getSender(): BridgeSender {
    if (!this._sender) throw new Error(`[cli-bridge:${this.label}] sender 尚未初始化`);
    return this._sender;
  }

  setSender(sender: BridgeSender): void {
    this._sender = sender;
  }

  getChannelConfig(): CliBridgeChannelConfig {
    return this.channelConfig;
  }

  // ── 上線通知 ──────────────────────────────────────────────────────────────

  private async sendStartupNotification(): Promise<void> {
    try {
      const { config: cfg } = await import("../core/config.js");
      if (cfg.restartNotify?.enabled === false) return;
    } catch { /* config 未就緒 */ return; }

    if (!this._sender) return;

    try {
      let text = `✅ CLI Bridge **${this.label}** 已上線`;

      // 未完成任務摘要
      try {
        const { getTaskStore } = await import("../core/task-store.js");
        const sessionKey = `discord:ch:${this.channelId}`;
        const store = getTaskStore(sessionKey);
        const pending = store.list().filter(t => t.status !== "completed");
        if (pending.length > 0) {
          text += `\n📋 有 ${pending.length} 個未完成任務：`;
          for (const t of pending.slice(0, 5)) {
            text += `\n  • [${t.status}] ${t.subject}`;
          }
          if (pending.length > 5) text += `\n  …還有 ${pending.length - 5} 個`;
        }
      } catch { /* task store 未初始化 */ }

      await this._sender.send(text);
      log.debug(`[cli-bridge:${this.label}] 上線通知已送出`);
    } catch (err) {
      log.debug(`[cli-bridge:${this.label}] 上線通知失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 依 workingDir 自動更新頻道名 ────────────────────────────────────────
  private async applyAutoChannelName(): Promise<void> {
    if (!this._sender) return;
    try {
      const { applyAutoChannelName } = await import("./channel-naming.js");
      await applyAutoChannelName(this, this._sender);
    } catch (err) {
      log.debug(`[cli-bridge:${this.label}] auto-name 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 補處理離線期 inbound history ────────────────────────────────────────
  //
  // 上線後自動 drain 本 bridge scope 的 inbound entries，直接丟進 CLI 處理。
  // 不需要使用者再送一次訊息觸發 consumeBridgeInboundHistory。
  // 無 entries 時 noop；consumeForInjection 會清空 JSONL 避免重複消費。
  private async drainInboundHistoryOnStartup(): Promise<void> {
    try {
      const { getInboundHistoryStore } = await import("../discord/inbound-history.js");
      const store = getInboundHistoryStore();
      if (!store) return;
      const result = await store.consumeForInjection(
        this.channelId,
        { enabled: true, fullWindowHours: 24, decayWindowHours: 168, bucketBTokenCap: 600, decayIITokenCap: 300, inject: { enabled: true } },
        undefined,
        `bridge:${this.label}`,
      );
      if (!result || result.entriesCount === 0) return;

      log.info(`[cli-bridge:${this.label}] 上線後補處理 inbound: ${result.entriesCount} 則（bucketA=${result.bucketA} bucketB=${result.bucketB}）`);

      // 加前綴讓 CLI 知道這批是離線期累積的，而非使用者當下意圖
      const prefixed = `[bridge 上線補處理：以下是你離線期間累積的頻道訊息，請當成要回應的使用者請求處理]\n\n${result.text}`;
      this.send(prefixed, "discord", { user: "system-inbound-replay", ts: new Date().toISOString() });
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] drainInboundHistoryOnStartup 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getBridgeConfig(): CliBridgeConfig {
    return this.bridgeConfig;
  }

  // ── 內部：訊息包裝（per-turn meta 注入）─────────────────────────────────

  /**
   * 把使用者訊息包在 `<channel>` tag 裡，每 turn 重新提供部署脈絡。
   *
   * 效果：
   * - CLI 內的 Claude 每 turn 都能從 tag 讀到自己的 bridge label / chat_id / user
   * - 不怕 context 被壓縮（下一 turn 又會重新注入）
   * - 包含使用 `catclaw-bridge-discord` MCP 的提示，避免誤用官方 plugin 撞 Missing Access
   */
  private wrapWithChannelTag(
    text: string,
    source: "discord" | "dashboard",
    meta?: { user?: string; ts?: string; sourceChannelId?: string },
  ): string {
    const ts = meta?.ts ?? new Date().toISOString();
    const escape = (v: string): string => v.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const isCrossChannel = meta?.sourceChannelId && meta.sourceChannelId !== this.channelId;
    const chatId = isCrossChannel ? meta.sourceChannelId! : this.channelId;

    const attrs: string[] = [
      `source="catclaw_cli_bridge"`,
      `bridge_label="${escape(this.label)}"`,
      `chat_id="${escape(chatId)}"`,
      `origin="${source}"`,
      `ts="${ts}"`,
    ];
    if (meta?.user) attrs.push(`user="${escape(meta.user)}"`);
    if (isCrossChannel) attrs.push(`home_channel="${escape(this.channelId)}"`);

    const hint = isCrossChannel
      ? `這是跨頻道 mention。回覆會自動送到來源頻道 ${chatId}。` +
        `要操作該頻道請用 mcp__catclaw-bridge-discord__* 工具並指定 channelId="${chatId}"。`
      : "要主動操作 Discord 請用 mcp__catclaw-bridge-discord__* 工具（走 Bridge 自己的 bot token，限定本頻道）。" +
        "官方 plugin:discord:discord 的 bot 可能無權限存取本頻道，會撞 Missing Access。" +
        "一般回覆直接用 stdout 即可，CatClaw 會自動轉送到 Discord。";

    return `<channel ${attrs.join(" ")}>\n<!-- ${hint} -->\n${text}\n</channel>`;
  }

  // ── 內部：process 建立 ────────────────────────────────────────────────────

  private async spawnProcess(): Promise<void> {
    const procConfig: CliProcessConfig = {
      claudeBin: this.bridgeConfig.claudeBin ?? "claude",
      workingDir: this.bridgeConfig.workingDir,
      sessionId: this.sessionId ?? this.channelConfig.sessionId ?? undefined,
      dangerouslySkipPermissions: this.channelConfig.dangerouslySkipPermissions ?? false,
      label: this.label,
      botToken: this.bridgeConfig.botToken,
      channelId: this.channelId,
    };

    this.process = new CliProcess(procConfig);
    this._lastSpawnTime = Date.now();

    // 綁定事件
    this.process.on("event", (evt) => this.handleEvent(evt));
    this.process.on("raw", (line) => {
      this.stdoutLogger.append(
        { type: "status", subtype: "raw", raw: line },
        line,
      );
    });
    this.process.on("close", (code) => this.handleClose(code));
    this.process.on("error", (err) => {
      log.error(`[cli-bridge:${this.label}] process error: ${err.message}`);
    });

    await this.process.spawn();
  }

  // ── 內部：事件處理 ────────────────────────────────────────────────────────

  private handleEvent(evt: CliBridgeEvent): void {
    this._lastUsedAt = Date.now();
    // 記錄到 logger
    this.stdoutLogger.append(evt);

    // session_init → 記住 session ID + 持久化
    if (evt.type === "session_init") {
      this.sessionId = evt.sessionId;
      log.info(`[cli-bridge:${this.label}] session_id=${evt.sessionId}`);
      this.persistSessionId(evt.sessionId);
    }

    // result 事件也帶 session_id（Claude CLI -p 模式不發 session_init）
    if (evt.type === "result" && evt.session_id && evt.session_id !== this.sessionId) {
      this.sessionId = evt.session_id;
      log.info(`[cli-bridge:${this.label}] session_id=${evt.session_id} (from result)`);
      this.persistSessionId(evt.session_id);
    }

    // 收到事件 → 重置 idle timeout
    const turnId = this.activeTurnId;
    if (turnId && this.turnTimeouts.has(turnId)) {
      this.resetTurnTimeout(turnId);
    }

    // 累積 turn 資料
    if (turnId) {
      const pending = this.pendingTurns.get(turnId);
      if (pending) {
        if (evt.type === "text_delta") {
          pending.textParts.push(evt.text);
        } else if (evt.type === "tool_call") {
          pending.record.toolCalls.push({ name: evt.title, preview: "" });
        } else if (evt.type === "tool_result") {
          const last = pending.record.toolCalls[pending.record.toolCalls.length - 1];
          if (last) {
            last.preview = evt.title;
            last.durationMs = evt.duration_ms;
          }
        }
      }
    }

    // result → 完成 turn
    if (evt.type === "result") {
      this.completeTurn(evt);
    }

    // 分發給 turn listener
    if (turnId) {
      const listener = this.turnListeners.get(turnId);
      if (listener && !listener.done) {
        if (listener.resolve) {
          const r = listener.resolve;
          listener.resolve = null;
          r(evt);
        } else {
          listener.queue.push(evt);
        }

        if (evt.type === "result" || evt.type === "error") {
          listener.done = true;
        }
      }
    }
  }

  private completeTurn(evt: CliBridgeEvent & { type: "result" }): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;

    // 清除 timeout
    const timer = this.turnTimeouts.get(turnId);
    if (timer) { clearTimeout(timer); this.turnTimeouts.delete(turnId); }

    const pending = this.pendingTurns.get(turnId);
    let durationMs = 0;
    if (pending) {
      pending.record.completedAt = new Date().toISOString();
      pending.record.assistantReply = pending.textParts.join("");
      durationMs = Date.parse(pending.record.completedAt) - Date.parse(pending.record.startedAt);
      this.stdoutLogger.recordTurn(pending.record);
      this.pendingTurns.delete(turnId);
    }

    this.activeTurnId = null;
    this._status = this.process?.alive ? "idle" : "dead";

    // CliBridgeTurn hook（observer）
    void (async () => {
      try {
        const { getHookRegistry } = await import("../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("CliBridgeTurn") > 0) {
          await hookReg.runCliBridgeTurn({
            event: "CliBridgeTurn",
            bridgeLabel: this.label,
            turnId,
            durationMs,
          });
        }
      } catch { /* ignore */ }
    })();
  }

  // ── 內部：idle timeout ────────────────────────────────────────────────────

  private resetTurnTimeout(turnId: string): void {
    const existing = this.turnTimeouts.get(turnId);
    if (existing) clearTimeout(existing);

    const timeoutMs = this.bridgeConfig.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (timeoutMs <= 0) return; // 0 or negative = disabled
    const action = this.bridgeConfig.turnTimeoutAction ?? "ask";
    const timer = setTimeout(() => {
      log.warn(`[cli-bridge:${this.label}] turn=${turnId.slice(0, 8)} idle timeout (${timeoutMs}ms 無事件) action=${action}`);
      this.turnTimeouts.delete(turnId);

      if (action === "warn" || action === "ask") {
        // 送 status event 給 reply handler（ask 模式由 reply handler 顯示按鈕）
        const listener = this.turnListeners.get(turnId);
        if (listener && !listener.done) {
          const evt: CliBridgeEvent = {
            type: "status",
            subtype: action === "ask" ? "idle_timeout_ask" : "idle_timeout_warn",
            raw: { timeoutMs },
          };
          if (listener.resolve) {
            listener.resolve(evt);
            listener.resolve = () => {};
          } else {
            listener.queue.push(evt);
          }
        }
        // 不結束 turn — 等使用者決定（ask）或繼續等待（warn 重新計時）
        if (action === "warn") this.resetTurnTimeout(turnId);
        return;
      }

      // interrupt / restart — 結束 turn
      const listener = this.turnListeners.get(turnId);
      if (listener && !listener.done) {
        listener.done = true;
        const errEvt: CliBridgeEvent = { type: "error", message: `turn idle 超時（連續 ${Math.round(timeoutMs / 1000)}s 無事件）` };
        if (listener.resolve) listener.resolve(errEvt);
        else listener.queue.push(errEvt);
      }

      if (action === "restart") {
        void this.restart();
      } else {
        void this.interrupt();
      }
    }, timeoutMs);
    this.turnTimeouts.set(turnId, timer);
  }

  // ── 內部：process crash 處理 ──────────────────────────────────────────────

  private handleClose(code: number | null): void {
    // 無論狀態如何，先清理 pending turns（防止 typing 永遠不停）
    const hadPending = this.turnListeners.size > 0;
    if (hadPending) {
      this.failAllPendingTurns(`process 關閉 (code=${code})`);
    }

    if (this._status === "dead" || this._status === "restarting") return;
    if (this._crashHandling) return; // handleCrash 正在管理重試，不重複觸發

    if (code === 0 && !hadPending) {
      log.info(`[cli-bridge:${this.label}] process 正常退出，靜默重啟`);
    } else {
      log.warn(`[cli-bridge:${this.label}] process 意外關閉 code=${code} hadPending=${hadPending}`);
    }
    void this.handleCrash();
  }

  private _crashHandling = false;
  private async handleCrash(): Promise<void> {
    if (this._crashHandling) return; // 防止多條 crash 鏈並行
    this._crashHandling = true;
    this.stopKeepAlive();

    // Session ID 衝突偵測（含快速死亡偵測：spawn 後 5s 內死 + stderr = "already in use"）
    const lastStderr = this.process?.lastStderr ?? "";
    const sid = this.sessionId || this.channelConfig.sessionId;
    const isAlreadyInUse = lastStderr.includes("already in use") && !!sid;
    // 快速死亡：spawn 後不到 5 秒就死了（500ms spawn check 通過但 stderr 延遲到達）
    const isQuickDeath = (Date.now() - this._lastSpawnTime) < 5000;

    if (isAlreadyInUse || (isQuickDeath && sid && this._alreadyInUseCount > 0)) {
      this._status = "restarting";
      this._alreadyInUseCount++;

      // 殺本地孤兒
      try {
        const { execSync } = await import("node:child_process");
        const pids = execSync(`pgrep -f "session-id ${sid}"`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try { process.kill(Number(pid), "SIGTERM"); } catch { /* 已死 */ }
        }
        if (pids.length > 0) log.info(`[cli-bridge:${this.label}] 已殺 ${pids.length} 個孤兒 process`);
      } catch { /* pgrep 找不到 */ }

      // --resume 已取代 --session-id，理論上不會再觸發 "already in use"
      // 保險：若仍發生，清除 runtime session 讓 fallthrough 用新 session 啟動
      log.warn(`[cli-bridge:${this.label}] session "${sid}" 被佔用（不預期），清除 session 改用新 session`);
      this.sessionId = null;
      (this.channelConfig as { sessionId?: string | null }).sessionId = null;
      this._alreadyInUseCount = 0;
      // fallthrough 到正常重啟流程（不帶 session ID）
    }

    const backoffMs = this.bridgeConfig.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoffMs[Math.min(this.restartAttempt, backoffMs.length - 1)]!;
    this.restartAttempt++;
    this._status = "restarting";

    log.info(`[cli-bridge:${this.label}] 自動重啟 attempt=${this.restartAttempt} delay=${delay}ms`);

    await new Promise(r => setTimeout(r, delay));

    try {
      await this.spawnProcess();
      this._status = "idle";
      this.restartAttempt = 0;
      this._alreadyInUseCount = 0;
      this._crashHandling = false;
      this.startKeepAlive();
      log.info(`[cli-bridge:${this.label}] 重啟成功`);
    } catch (err) {
      log.error(`[cli-bridge:${this.label}] 重啟失敗: ${err instanceof Error ? err.message : String(err)}`);
      // 繼續嘗試
      if (this.restartAttempt < backoffMs.length + 3) {
        this._crashHandling = false; // 允許下一輪 handleCrash 進入
        void this.handleCrash();
      } else {
        this._status = "dead";
        this._crashHandling = false;
        log.error(`[cli-bridge:${this.label}] 重啟次數超限，放棄`);
      }
    }
  }

  // ── 內部：keep-alive ──────────────────────────────────────────────────────

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const interval = this.bridgeConfig.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_MS;
    if (interval <= 0) return; // 0 = 不送 ping
    this.keepAliveTimer = setInterval(() => {
      if (!this.process?.ping()) {
        log.warn(`[cli-bridge:${this.label}] keep-alive 失敗`);
        void this.handleCrash();
      }
    }, interval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // ── 內部：turn generator ──────────────────────────────────────────────────

  private async *createTurnGenerator(turnId: string): AsyncGenerator<CliBridgeEvent> {
    const listener = this.turnListeners.get(turnId);
    if (!listener) return;

    try {
      while (!listener.done) {
        // 先消費 queue 裡已有的
        while (listener.queue.length > 0) {
          const evt = listener.queue.shift()!;
          yield evt;
          if (evt.type === "result" || evt.type === "error") return;
        }

        // 等待下一個事件
        const evt = await new Promise<CliBridgeEvent>((resolve) => {
          listener.resolve = resolve;
        });
        yield evt;
        if (evt.type === "result" || evt.type === "error") return;
      }

      // 消費殘留
      while (listener.queue.length > 0) {
        yield listener.queue.shift()!;
      }
    } finally {
      this.turnListeners.delete(turnId);
    }
  }

  private abortTurn(turnId: string): void {
    // 清除 idle timer，避免 orphan timer 5 分鐘後才跑
    const timer = this.turnTimeouts.get(turnId);
    if (timer) { clearTimeout(timer); this.turnTimeouts.delete(turnId); }

    const listener = this.turnListeners.get(turnId);
    if (listener && !listener.done) {
      listener.done = true;
      const errEvt: CliBridgeEvent = { type: "error", message: "turn 已取消" };
      if (listener.resolve) listener.resolve(errEvt);
      else listener.queue.push(errEvt);
    }
    if (this.activeTurnId === turnId) {
      void this.interrupt();
    }
  }

  private createErrorHandle(turnId: string, message: string): TurnHandle {
    async function* errorGen(): AsyncGenerator<CliBridgeEvent> {
      yield { type: "error", message };
    }
    return {
      turnId,
      events: errorGen(),
      abort: () => {},
    };
  }

  /**
   * @param reason 失敗原因
   * @param silent true 時不送 error event 到 reply handler（用於 graceful shutdown，避免在 Discord 顯示紅色錯誤）
   */
  private failAllPendingTurns(reason: string, silent = false): void {
    // 清除所有 turn timeout
    for (const [, timer] of this.turnTimeouts) clearTimeout(timer);
    this.turnTimeouts.clear();

    if (!silent) {
      for (const [turnId, listener] of this.turnListeners) {
        if (!listener.done) {
          listener.done = true;
          const errEvt: CliBridgeEvent = { type: "error", message: reason };
          if (listener.resolve) listener.resolve(errEvt);
          else listener.queue.push(errEvt);
        }
      }
    } else {
      // silent：直接標記 done，不送 error（reply handler 會因 generator return 自然結束）
      for (const [turnId, listener] of this.turnListeners) {
        if (!listener.done) {
          listener.done = true;
          const doneEvt: CliBridgeEvent = { type: "result", is_error: false };
          if (listener.resolve) listener.resolve(doneEvt);
          else listener.queue.push(doneEvt);
        }
      }
    }
    for (const [turnId, pending] of this.pendingTurns) {
      pending.record.completedAt = new Date().toISOString();
      pending.record.assistantReply = pending.textParts.join("");
      pending.record.discordDelivery = silent ? "success" : "failed";
      pending.record.failedReason = silent ? undefined : reason;
      this.stdoutLogger.recordTurn(pending.record);
    }
    this.pendingTurns.clear();
    this.activeTurnId = null;
  }
}
