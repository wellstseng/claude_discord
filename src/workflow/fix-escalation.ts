/**
 * @file workflow/fix-escalation.ts
 * @description Fix Escalation — 同問題 retry ≥ 2 → 6 次序列精確修正
 *
 * 設計：
 *   - 追蹤 per-session retry 次數（同 session 內連續錯誤）
 *   - retry ≥ 2 → 觸發 escalation：6 次 agentLoop，各帶不同 system prompt
 *   - Early-exit：任一 turn 產出有效修正（無 error 且有 text）→ 提前結束
 *   - 連續 3 次 turn 無進展 → 中止
 *   - 獨立 timeout（預設 10 分鐘）
 *
 * 對應架構文件第 9 節「Fix Escalation（F1）」
 */

import { log } from "../logger.js";
import type { EscalationContext, EscalationAttempt } from "./types.js";

// ── 設定 ──────────────────────────────────────────────────────────────────────

const ESCALATION_THRESHOLD = 2;
const MAX_ESCALATION_TURNS = 6;
const MAX_NO_PROGRESS_TURNS = 3;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min

// ── 6 種 system prompt 變體 ───────────────────────────────────────────────────

const ESCALATION_PROMPTS = [
  // Turn 1: 精確診斷
  "你正在執行 Fix Escalation（第 1/6 輪）。先**只診斷**，不要修改程式碼。找出根本原因，列出假設，按可能性排序。",
  // Turn 2: 最小修正
  "你正在執行 Fix Escalation（第 2/6 輪）。**最小修正**：只改最可能的根本原因，不要連帶修改其他邏輯。",
  // Turn 3: 驗證
  "你正在執行 Fix Escalation（第 3/6 輪）。**驗證**：執行測試或 build，確認修正有效。若仍失敗，列出下一個可能原因。",
  // Turn 4: 替代方案
  "你正在執行 Fix Escalation（第 4/6 輪）。**替代方案**：若前幾輪方向錯誤，完全重新考慮。忽略之前的假設，從原始碼重新推導。",
  // Turn 5: 強制正確
  "你正在執行 Fix Escalation（第 5/6 輪）。**強制修正**：不論如何都要讓它通過，允許暫時性的折衷方案，之後再重構。",
  // Turn 6: 最終回報
  "你正在執行 Fix Escalation（第 6/6 輪）。**最終回報**：若問題仍未解決，詳細說明你嘗試過的方法、根本原因、以及為什麼無法修正，讓使用者決定下一步。",
];

// ── Per-session retry 追蹤 ────────────────────────────────────────────────────

/** sessionKey → retry count */
const _retryCounts = new Map<string, number>();

/** sessionKey → 是否正在 escalation 中 */
const _escalating = new Set<string>();

/**
 * 記錄一次失敗（通常在 tool:error 或 agent 回應含錯誤時呼叫）
 * @returns 是否超過閾值應觸發 escalation
 */
export function recordRetry(sessionKey: string): boolean {
  const count = (_retryCounts.get(sessionKey) ?? 0) + 1;
  _retryCounts.set(sessionKey, count);
  log.debug(`[fix-escalation] session=${sessionKey} retry=${count}`);
  return count >= ESCALATION_THRESHOLD && !_escalating.has(sessionKey);
}

/** 重置 session retry count（成功後呼叫） */
export function resetRetry(sessionKey: string): void {
  _retryCounts.set(sessionKey, 0);
}

/** 清除 session 狀態 */
export function clearSession(sessionKey: string): void {
  _retryCounts.delete(sessionKey);
  _escalating.delete(sessionKey);
}

// ── Escalation 執行器 ─────────────────────────────────────────────────────────

export interface EscalationRunnerDeps {
  /** 執行一次 agentLoop turn，回傳完整回覆文字（含 tool 執行）*/
  runTurn: (prompt: string, systemPromptExtra: string, signal: AbortSignal) => Promise<string>;
}

/**
 * 執行 escalation 流程（6 輪序列）
 *
 * @returns EscalationAttempt[] — 每輪結果
 */
export async function runFixEscalation(
  ctx: EscalationContext,
  deps: EscalationRunnerDeps,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EscalationAttempt[]> {
  if (_escalating.has(ctx.sessionKey)) {
    log.warn(`[fix-escalation] session=${ctx.sessionKey} 已在 escalation 中，跳過`);
    return [];
  }

  _escalating.add(ctx.sessionKey);
  log.info(`[fix-escalation] 開始 session=${ctx.sessionKey} retry=${ctx.retryCount}`);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const attempts: EscalationAttempt[] = [];
  let noProgressCount = 0;

  try {
    for (let i = 0; i < MAX_ESCALATION_TURNS; i++) {
      if (controller.signal.aborted) {
        log.warn(`[fix-escalation] 超時中止（turn ${i}）`);
        break;
      }

      const systemExtra = ESCALATION_PROMPTS[i] ?? "";
      const prompt = i === 0
        ? `[Fix Escalation] 問題重述：${ctx.failedPrompt}\n\n錯誤歷史：\n${ctx.errorHistory.slice(-3).join("\n")}`
        : ctx.failedPrompt;

      let result: string;
      let resolved = false;

      try {
        result = await deps.runTurn(prompt, systemExtra, controller.signal);
        resolved = result.length > 10 && !result.includes("錯誤") && !result.includes("Error");
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
        resolved = false;
      }

      const attempt: EscalationAttempt = {
        turnIndex: i,
        systemPromptVariant: systemExtra,
        result,
        resolved,
      };
      attempts.push(attempt);

      if (resolved) {
        log.info(`[fix-escalation] 第 ${i + 1} 輪成功，提前結束`);
        resetRetry(ctx.sessionKey);
        break;
      }

      // 無進展計數
      if (!result || result.length < 10) {
        noProgressCount++;
        if (noProgressCount >= MAX_NO_PROGRESS_TURNS) {
          log.warn(`[fix-escalation] 連續 ${MAX_NO_PROGRESS_TURNS} 輪無進展，中止`);
          break;
        }
      } else {
        noProgressCount = 0;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
    _escalating.delete(ctx.sessionKey);
  }

  return attempts;
}

/** 取得 session 的 retry 次數 */
export function getRetryCount(sessionKey: string): number {
  return _retryCounts.get(sessionKey) ?? 0;
}
