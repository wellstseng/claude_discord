/**
 * @file discord/bot-circuit-breaker.ts
 * @description Bot-to-Bot 對話防呆機制
 *
 * 偵測同頻道 bot 互相回覆過度活躍，超過閾值暫停等人介入。
 * 觸發條件（任一）：連續 bot 互動來回 N 輪 OR 持續超過 M 毫秒。
 */

import { log } from "../logger.js";
import type { BotCircuitBreakerConfig } from "../core/config.js";

// ── 預設值 ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  maxRounds: 10,
  maxDurationMs: 180_000, // 3 分鐘
} as const;

// ── Per-channel 追蹤狀態 ────────────────────────────────────────────────────

interface ChannelState {
  /** 連續 bot 互動起始時間 */
  startTs: number;
  /** 來回輪數（每次 bot 訊息被處理 +1） */
  rounds: number;
  /** 是否已觸發暫停（等待人類介入） */
  tripped: boolean;
}

const states = new Map<string, ChannelState>();

// ── 公開 API ────────────────────────────────────────────────────────────────

/**
 * 檢查是否允許處理此 bot 訊息。
 * @returns `true` = 允許處理，`false` = 已觸發 circuit breaker，應暫停
 */
export function checkBotMessage(
  channelId: string,
  cfg?: BotCircuitBreakerConfig,
): boolean {
  const enabled = cfg?.enabled ?? DEFAULTS.enabled;
  if (!enabled) return true;

  const maxRounds = cfg?.maxRounds ?? DEFAULTS.maxRounds;
  const maxDurationMs = cfg?.maxDurationMs ?? DEFAULTS.maxDurationMs;

  let state = states.get(channelId);
  if (!state) {
    state = { startTs: Date.now(), rounds: 0, tripped: false };
    states.set(channelId, state);
  }

  if (state.tripped) return false;

  state.rounds++;
  const elapsed = Date.now() - state.startTs;

  if (state.rounds >= maxRounds || elapsed >= maxDurationMs) {
    state.tripped = true;
    log.warn(
      `[bot-circuit-breaker] 觸發：channel=${channelId} rounds=${state.rounds} elapsed=${Math.round(elapsed / 1000)}s`,
    );
    return false;
  }

  return true;
}

/**
 * 人類訊息進入 → 重置該頻道的 circuit breaker 狀態。
 */
export function resetOnHumanMessage(channelId: string): void {
  if (states.has(channelId)) {
    states.delete(channelId);
  }
}

/**
 * 手動重置（Dashboard / 指令用）。
 */
export function resetChannel(channelId: string): void {
  states.delete(channelId);
  log.info(`[bot-circuit-breaker] 手動重置：channel=${channelId}`);
}

/**
 * 取得所有頻道狀態（Dashboard 顯示用）。
 */
export function getAllStates(): Array<{
  channelId: string;
  rounds: number;
  elapsedMs: number;
  tripped: boolean;
}> {
  return Array.from(states.entries()).map(([channelId, s]) => ({
    channelId,
    rounds: s.rounds,
    elapsedMs: Date.now() - s.startTs,
    tripped: s.tripped,
  }));
}

/**
 * 取得預設值（Dashboard 表單用）。
 */
export const BOT_CB_DEFAULTS = DEFAULTS;
