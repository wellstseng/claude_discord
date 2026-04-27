/**
 * @file core/health-monitor.ts
 * @description Component-level 健康追蹤 — 反「靜默失敗」設計
 *
 * 解決問題：CatClaw 大量子系統採 graceful skip（不掛主流程），
 * 但少了通報層後變成靜默失敗——錯了沒人知道。
 *
 * 機制：
 *   - 每個 component 維護 (連續成功/失敗計數, 最近錯誤訊息, 狀態)
 *   - 連續失敗達 degraded 門檻 → emit "health:degraded"（warn log）
 *   - 連續失敗達 critical 門檻 → emit "health:critical"（error log + Discord 通報）
 *   - 任何成功 → reset 計數，若先前是 degraded/unhealthy → emit "health:recovered"
 *   - 通報節流：同 component 1 小時內 critical 只 emit 一次
 *
 * 用法：
 *   import { recordSuccess, recordFailure } from "./health-monitor.js";
 *   recordSuccess("embedding:ollama");
 *   recordFailure("embedding:ollama", "timeout 5000ms");
 *
 * Startup 階段：
 *   reportStartupSummary([{ name: "ollama-embedding", ok: false, detail: "model not found" }, ...])
 */

import { log } from "../logger.js";
import { eventBus } from "./event-bus.js";

// ── Config ──────────────────────────────────────────────────────────────────

const DEGRADED_THRESHOLD = 2;          // 連續 N 次失敗 → degraded
const CRITICAL_THRESHOLD = 5;          // 連續 N 次失敗 → critical（會通報）
const NOTIFY_DEDUP_MS = 60 * 60_000;   // 同 component critical 1 小時內只通報一次

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  consecutiveFailures: number;
  lastSuccess?: number;
  lastFailure?: number;
  lastError?: string;
  totalSuccess: number;
  totalFailure: number;
}

// ── State ───────────────────────────────────────────────────────────────────

const _components = new Map<string, ComponentHealth>();
const _notifyDedup = new Map<string, number>();
let _startupResults: Array<{ name: string; ok: boolean; detail: string }> = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureComponent(name: string): ComponentHealth {
  let c = _components.get(name);
  if (!c) {
    c = {
      name,
      status: "unknown",
      consecutiveFailures: 0,
      totalSuccess: 0,
      totalFailure: 0,
    };
    _components.set(name, c);
  }
  return c;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** 紀錄一次成功操作。會 reset 連續失敗計數。從 degraded/unhealthy 恢復時 emit recovered。 */
export function recordSuccess(name: string): void {
  const c = ensureComponent(name);
  const wasUnhealthy = c.status === "degraded" || c.status === "unhealthy";
  c.totalSuccess++;
  c.lastSuccess = Date.now();
  c.consecutiveFailures = 0;
  c.status = "healthy";
  if (wasUnhealthy) {
    log.info(`[health] ${name} 已恢復（連續失敗計數重置）`);
    _notifyDedup.delete(name);
    eventBus.emit("health:recovered", name);
  }
}

/** 紀錄一次失敗操作。連續達 degraded/critical 門檻會 emit 對應事件 + 升級 log level。 */
export function recordFailure(name: string, error: string): void {
  const c = ensureComponent(name);
  c.totalFailure++;
  c.lastFailure = Date.now();
  c.lastError = error;
  c.consecutiveFailures++;

  // critical 升級
  if (c.consecutiveFailures === CRITICAL_THRESHOLD) {
    c.status = "unhealthy";
    log.error(`[health] ${name} 連續失敗 ${CRITICAL_THRESHOLD} 次 → CRITICAL：${error}`);
    notifyOnce(name, error, "critical");
    return;
  }

  // degraded 升級（門檻達到那一刻才 emit，避免每次失敗都 emit）
  if (c.consecutiveFailures === DEGRADED_THRESHOLD) {
    c.status = "degraded";
    log.warn(`[health] ${name} 連續失敗 ${DEGRADED_THRESHOLD} 次 → DEGRADED：${error}`);
    eventBus.emit("health:degraded", name, error);
    return;
  }

  // 已是 critical 仍持續失敗 → 不再 emit（節流由 notifyOnce 處理）
  if (c.status === "unhealthy") {
    notifyOnce(name, error, "critical");
  }
}

function notifyOnce(name: string, error: string, level: "critical"): void {
  const now = Date.now();
  const last = _notifyDedup.get(name) ?? 0;
  if (now - last < NOTIFY_DEDUP_MS) return;
  _notifyDedup.set(name, now);
  if (level === "critical") {
    eventBus.emit("health:critical", name, error);
  }
}

/** 取得所有 component 的當前健康狀態（給 dashboard /api/health 用）。 */
export function getAllHealth(): ComponentHealth[] {
  return [..._components.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 取得單一 component 健康狀態。 */
export function getHealth(name: string): ComponentHealth | undefined {
  return _components.get(name);
}

// ── Startup Health Summary ──────────────────────────────────────────────────

/**
 * Startup 階段呼叫一次，把所有關鍵組件的 verify 結果集中印出 + 寫入 component map。
 * 同時 emit "health:startup" 事件供 Discord/Dashboard 訂閱。
 */
export function reportStartupSummary(items: Array<{ name: string; ok: boolean; detail: string }>): void {
  _startupResults = [...items];
  const okCount = items.filter(i => i.ok).length;
  const failCount = items.length - okCount;

  // 寫入 component map（startup 失敗者初始化為 unhealthy）
  for (const item of items) {
    const c = ensureComponent(item.name);
    if (item.ok) {
      c.status = "healthy";
      c.lastSuccess = Date.now();
      c.totalSuccess++;
    } else {
      c.status = "unhealthy";
      c.lastFailure = Date.now();
      c.lastError = item.detail;
      c.totalFailure++;
      c.consecutiveFailures = CRITICAL_THRESHOLD; // 視為已達 critical
    }
  }

  // 集中印出（明顯的紅綠燈）
  log.info(`[health] ━━━━━━━━━━━━━━━ Startup Health Summary ━━━━━━━━━━━━━━━`);
  for (const item of items) {
    if (item.ok) {
      log.info(`[health] ✓ ${item.name}：${item.detail}`);
    } else {
      log.error(`[health] ✗ ${item.name}：${item.detail}`);
    }
  }
  log.info(`[health] ━━━━━━━━━━━━━━━ ${okCount} OK / ${failCount} FAIL ━━━━━━━━━━━━━━━`);

  eventBus.emit("health:startup", items);
}

/** 取得最近一次 startup summary 結果（給 dashboard 用）。 */
export function getStartupResults(): Array<{ name: string; ok: boolean; detail: string }> {
  return [..._startupResults];
}

// ── 測試用 reset（不對外暴露生產用途）────────────────────────────────────────

export function _resetForTest(): void {
  _components.clear();
  _notifyDedup.clear();
  _startupResults = [];
}
