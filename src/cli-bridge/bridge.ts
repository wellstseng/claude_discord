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
import { log } from "../logger.js";
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
} from "./types.js";

// ── 預設值 ──────────────────────────────────────────────────────────────────

const DEFAULT_KEEP_ALIVE_MS = 60_000;
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const INTERRUPT_TIMEOUT_MS = 5000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000; // 5 分鐘

// ── CliBridge ───────────────────────────────────────────────────────────────

export class CliBridge {
  private process: CliProcess | null = null;
  private stdoutLogger: StdoutLogger;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private restartAttempt = 0;
  private _status: BridgeStatus = "dead";
  private sessionId: string | null = null;

  // Turn 追蹤
  private activeTurnId: string | null = null;
  private turnListeners = new Map<string, {
    resolve: (event: CliBridgeEvent) => void;
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

  constructor(
    public readonly label: string,
    public readonly channelId: string,
    private readonly bridgeConfig: CliBridgeConfig,
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
    } catch (err) {
      this._status = "dead";
      log.error(`[cli-bridge:${this.label}] start failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  // ── 送訊息（直送 stdin，不排隊）──────────────────────────────────────────

  send(text: string, source: "discord" | "dashboard"): TurnHandle {
    const turnId = randomUUID();

    if (!this.process?.alive) {
      // process 不在 → 觸發重啟，但先回傳 error handle
      void this.handleCrash();
      return this.createErrorHandle(turnId, "CLI process 未啟動，正在重啟...");
    }

    // 建立 turn 追蹤
    const turnState = {
      resolve: (_event: CliBridgeEvent) => {},
      queue: [] as CliBridgeEvent[],
      done: false,
    };
    this.turnListeners.set(turnId, turnState);

    // 建立 pending turn record
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

    // 標記 busy
    this.activeTurnId = turnId;
    this._status = "busy";

    // 送 stdin
    try {
      this.process.send({
        type: "user",
        message: { role: "user", content: text },
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
      listener.resolve({ type: "error", message: `使用者選擇${action === "interrupt" ? "中斷" : "重啟"}` });
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

  async shutdown(): Promise<void> {
    log.info(`[cli-bridge:${this.label}] shutdown`);
    this.stopKeepAlive();
    this.failAllPendingTurns("bridge 關閉中");

    if (this.process?.alive) {
      await this.process.shutdown();
    }
    this._status = "dead";
  }

  // ── 狀態查詢 ──────────────────────────────────────────────────────────────

  get status(): BridgeStatus {
    return this._status;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
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

  // ── 內部：process 建立 ────────────────────────────────────────────────────

  private async spawnProcess(): Promise<void> {
    const procConfig: CliProcessConfig = {
      claudeBin: this.bridgeConfig.claudeBin ?? "claude",
      workingDir: this.bridgeConfig.workingDir,
      sessionId: this.channelConfig.sessionId ?? this.sessionId ?? undefined,
      dangerouslySkipPermissions: this.channelConfig.dangerouslySkipPermissions ?? true,
      label: this.label,
    };

    this.process = new CliProcess(procConfig);

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
    // 記錄到 logger
    this.stdoutLogger.append(evt);

    // session_init → 記住 session ID
    if (evt.type === "session_init") {
      this.sessionId = evt.sessionId;
      log.info(`[cli-bridge:${this.label}] session_id=${evt.sessionId}`);
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
          listener.resolve(evt);
          listener.resolve = () => {};
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
    if (pending) {
      pending.record.completedAt = new Date().toISOString();
      pending.record.assistantReply = pending.textParts.join("");
      this.stdoutLogger.recordTurn(pending.record);
      this.pendingTurns.delete(turnId);
    }

    this.activeTurnId = null;
    this._status = this.process?.alive ? "idle" : "dead";
  }

  // ── 內部：idle timeout ────────────────────────────────────────────────────

  private resetTurnTimeout(turnId: string): void {
    const existing = this.turnTimeouts.get(turnId);
    if (existing) clearTimeout(existing);

    const timeoutMs = this.bridgeConfig.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
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
        listener.resolve({ type: "error", message: `turn idle 超時（連續 ${Math.round(timeoutMs / 1000)}s 無事件）` });
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
    if (this._status === "dead" || this._status === "restarting") return;

    log.warn(`[cli-bridge:${this.label}] process 意外關閉 code=${code}`);
    this.failAllPendingTurns(`process 意外退出 (code=${code})`);
    void this.handleCrash();
  }

  private async handleCrash(): Promise<void> {
    this.stopKeepAlive();

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
      this.startKeepAlive();
      log.info(`[cli-bridge:${this.label}] 重啟成功`);
    } catch (err) {
      log.error(`[cli-bridge:${this.label}] 重啟失敗: ${err instanceof Error ? err.message : String(err)}`);
      // 繼續嘗試
      if (this.restartAttempt < backoffMs.length + 3) {
        void this.handleCrash();
      } else {
        this._status = "dead";
        log.error(`[cli-bridge:${this.label}] 重啟次數超限，放棄`);
      }
    }
  }

  // ── 內部：keep-alive ──────────────────────────────────────────────────────

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const interval = this.bridgeConfig.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_MS;
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
    const listener = this.turnListeners.get(turnId);
    if (listener && !listener.done) {
      listener.done = true;
      listener.resolve({ type: "error", message: "turn 已取消" });
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

  private failAllPendingTurns(reason: string): void {
    // 清除所有 turn timeout
    for (const [, timer] of this.turnTimeouts) clearTimeout(timer);
    this.turnTimeouts.clear();

    for (const [turnId, listener] of this.turnListeners) {
      if (!listener.done) {
        listener.done = true;
        listener.resolve({ type: "error", message: reason });
      }
    }
    for (const [turnId, pending] of this.pendingTurns) {
      pending.record.completedAt = new Date().toISOString();
      pending.record.assistantReply = pending.textParts.join("");
      pending.record.discordDelivery = "failed";
      pending.record.failedReason = reason;
      this.stdoutLogger.recordTurn(pending.record);
    }
    this.pendingTurns.clear();
    this.activeTurnId = null;
  }
}
