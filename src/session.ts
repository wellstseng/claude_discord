/**
 * @file session.ts
 * @description Claude session 管理 + per-channel 串行佇列
 *
 * 職責：
 * 1. 維護 channelId → session_id（UUID）的快取
 *    首次對話由 claude CLI 建立 session，從 session_init event 取得 ID
 *    後續對話帶 --resume <session_id> 延續上下文
 * 2. 以 Promise chain 實作 per-channel 串行佇列
 *    （同一 channel 的 turn 必須串行，不同 channel 完全並行）
 * 3. 對外只暴露 enqueue()，呼叫方不需要關心 session 細節
 */

import { runClaudeTurn, type AcpEvent } from "./acp.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** enqueue 收到的 event 回呼 */
export type OnEvent = (event: AcpEvent) => void | Promise<void>;

// ── 內部狀態 ────────────────────────────────────────────────────────────────

/** channelId → session_id（UUID，由 claude CLI 產生） */
const sessionCache = new Map<string, string>();

/**
 * channelId → Promise chain 尾端
 * per-channel 串行佇列核心：每個新 turn 接在上一個 Promise 後面
 */
const queues = new Map<string, Promise<void>>();

// ── 內部函式 ────────────────────────────────────────────────────────────────

/**
 * 執行單一 turn 的完整流程：串流 event → 逐一回呼 + 攔截 session_init
 *
 * @param channelId Discord channel ID
 * @param text 使用者訊息文字
 * @param onEvent event 回呼（由 reply.ts 建立，用於更新 Discord 回覆）
 * @param cwd Claude session 工作目錄
 * @param claudeCmd claude binary 路徑
 * @param signal AbortSignal（可選）
 */
async function runTurn(
  channelId: string,
  text: string,
  onEvent: OnEvent,
  cwd: string,
  claudeCmd: string,
  signal?: AbortSignal
): Promise<void> {
  // 取得快取的 session ID（首次為 null，claude CLI 會自動建立新 session）
  const existingSessionId = sessionCache.get(channelId) ?? null;

  for await (const event of runClaudeTurn(
    existingSessionId,
    text,
    cwd,
    claudeCmd,
    signal
  )) {
    // 攔截 session_init event：快取 session ID，不轉發給 reply handler
    if (event.type === "session_init") {
      sessionCache.set(channelId, event.sessionId);
      continue;
    }

    await onEvent(event);
  }
}

// ── 對外 API ────────────────────────────────────────────────────────────────

/** enqueue 的選項 */
export interface EnqueueOptions {
  /** Claude session 工作目錄 */
  cwd: string;
  /** claude CLI binary 路徑 */
  claudeCmd: string;
  /** AbortSignal（可選，用於取消） */
  signal?: AbortSignal;
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

  // 將新 turn 接在尾端，錯誤不向上傳播（避免 Promise chain 中斷）
  const next = tail.then(() =>
    runTurn(channelId, text, onEvent, opts.cwd, opts.claudeCmd, opts.signal).catch(
      (err: unknown) => {
        const message =
          err instanceof Error ? err.message : String(err);
        void onEvent({ type: "error", message });
      }
    )
  );

  queues.set(channelId, next);

  // 佇列完成後清理 Map，避免記憶體洩漏
  next.finally(() => {
    if (queues.get(channelId) === next) {
      queues.delete(channelId);
    }
  });
}
