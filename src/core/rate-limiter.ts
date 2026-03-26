/**
 * @file core/rate-limiter.ts
 * @description 請求速率限制器（滑動視窗，per-account）
 *
 * 策略：固定 60s 視窗，每個 accountId 維護一條時間戳記清單。
 * 呼叫 check() 不消費配額；record() 才計入。
 * 可配合 roleLimit 做每角色不同上限。
 */

import { log } from "../logger.js";
import type { RateLimitConfig } from "./config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** 剩餘可用次數（-1 = 無限制） */
  remaining: number;
  /** 距離視窗重置的毫秒數（allowed=false 時有意義） */
  retryAfterMs: number;
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000; // 1 分鐘滑動視窗

export class RateLimiter {
  /** accountId → 過去 60s 內各次請求的時間戳記 */
  private readonly timestamps = new Map<string, number[]>();
  private readonly limits: RateLimitConfig;

  constructor(limits: RateLimitConfig) {
    this.limits = limits;
  }

  /**
   * 檢查帳號是否還在配額內（不消費）
   */
  check(accountId: string, role: string): RateLimitResult {
    const rpm = this.limits[role]?.requestsPerMinute;
    if (rpm === undefined || rpm <= 0) {
      return { allowed: true, remaining: -1, retryAfterMs: 0 };
    }

    const now = Date.now();
    const window = this.getWindow(accountId, now);

    if (window.length < rpm) {
      return { allowed: true, remaining: rpm - window.length, retryAfterMs: 0 };
    }

    // 視窗已滿 → 計算最早一筆過期後距現在多久
    const oldest = window[0]!;
    const retryAfterMs = WINDOW_MS - (now - oldest);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  /**
   * 記錄一次請求（消費配額）
   */
  record(accountId: string): void {
    const now = Date.now();
    const key = accountId;
    let ts = this.timestamps.get(key) ?? [];
    ts = ts.filter(t => now - t < WINDOW_MS);
    ts.push(now);
    this.timestamps.set(key, ts);
  }

  /** 清除超過視窗的過期記錄（可由外部定期呼叫） */
  evict(): void {
    const now = Date.now();
    for (const [key, ts] of this.timestamps.entries()) {
      const fresh = ts.filter(t => now - t < WINDOW_MS);
      if (fresh.length === 0) {
        this.timestamps.delete(key);
      } else {
        this.timestamps.set(key, fresh);
      }
    }
    log.debug(`[rate-limiter] evict 完成，剩 ${this.timestamps.size} 個 key`);
  }

  private getWindow(accountId: string, now: number): number[] {
    const ts = this.timestamps.get(accountId) ?? [];
    return ts.filter(t => now - t < WINDOW_MS);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _limiter: RateLimiter | null = null;

export function initRateLimiter(limits: RateLimitConfig): RateLimiter {
  _limiter = new RateLimiter(limits);
  log.info("[rate-limiter] 已初始化");
  return _limiter;
}

export function getRateLimiter(): RateLimiter {
  if (!_limiter) throw new Error("[rate-limiter] 尚未初始化，請先呼叫 initRateLimiter()");
  return _limiter;
}

export function resetRateLimiter(): void {
  _limiter = null;
}
