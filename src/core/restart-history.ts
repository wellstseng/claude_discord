/**
 * @file core/restart-history.ts
 * @description 主進程啟動/關閉歷史紀錄
 *
 * 用途：追蹤 CatClaw 主進程最近 N 次啟動/關閉，協助排查「不明原因重啟」。
 *
 * 機制：
 * - recordStartup 在啟動時呼叫；若偵測到上一筆沒有 stoppedAt（表示上次沒走到 recordShutdown），
 *   補記為 unexpected_termination（可能 OOM / kill -9 / 系統重啟）。
 * - recordShutdown 在 SIGTERM/SIGINT/主動退出時呼叫。
 * - recordUncaughtException 在 uncaughtException handler 呼叫。
 *
 * 檔案位置：`{catclawDir}/logs/restart-history.json`
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCatclawDir } from "./config.js";
import { log } from "../logger.js";

export type RestartReason =
  | "running"
  | "SIGTERM"
  | "SIGINT"
  | "uncaughtException"
  | "unexpected_termination"
  | "manual_restart"
  | "api_restart"
  | string;

export interface RestartEntry {
  pid: number;
  startedAt: string;
  stoppedAt?: string;
  uptimeMs?: number;
  reason: RestartReason;
  signal?: string;
  clean: boolean;
  version?: string;
  note?: string;
  stack?: string;
}

const MAX_ENTRIES = 20;

/** 計畫中的關閉原因（例如從 dashboard API 觸發的 api_restart）。shutdown 時優先採用。 */
let _pendingReason: RestartReason | null = null;
export function setPendingReason(reason: RestartReason): void {
  _pendingReason = reason;
}
export function getPendingReason(): RestartReason | null {
  return _pendingReason;
}

function getHistoryPath(): string {
  return join(resolveCatclawDir(), "logs", "restart-history.json");
}

function readHistory(): RestartEntry[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn(`[restart-history] 讀取失敗（視為空）：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function writeHistory(entries: RestartEntry[]): void {
  const path = getHistoryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const trimmed = entries.slice(-MAX_ENTRIES);
    writeFileSync(path, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[restart-history] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 啟動時呼叫。若上一筆沒走正常 shutdown，補記為 unexpected_termination。
 * 接著 append 本次啟動（clean=false，等 recordShutdown 補齊）。
 */
export function recordStartup(opts?: { version?: string }): void {
  const history = readHistory();

  const last = history[history.length - 1];
  if (last && !last.stoppedAt) {
    last.stoppedAt = new Date().toISOString();
    last.reason = "unexpected_termination";
    last.clean = false;
    last.note = "啟動時偵測到上次沒走 graceful shutdown（可能 OOM / kill -9 / 系統重啟）";
    if (last.startedAt) {
      last.uptimeMs = Date.parse(last.stoppedAt) - Date.parse(last.startedAt);
    }
  }

  history.push({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    reason: "running",
    clean: false,
    version: opts?.version,
  });

  writeHistory(history);
  log.info(`[restart-history] startup recorded pid=${process.pid}${last && !last.clean ? "（上次非 clean shutdown）" : ""}`);
}

/**
 * Graceful shutdown 時呼叫。更新當前 entry 的 stoppedAt / uptimeMs / clean。
 */
export function recordShutdown(reason: RestartReason, signal?: string): void {
  const history = readHistory();
  const current = history[history.length - 1];
  if (!current || current.pid !== process.pid) {
    log.warn(`[restart-history] recordShutdown 找不到本次 pid=${process.pid} 的 entry，新增一筆`);
    history.push({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
      uptimeMs: 0,
      reason,
      signal,
      clean: true,
    });
  } else {
    current.stoppedAt = new Date().toISOString();
    current.uptimeMs = Date.parse(current.stoppedAt) - Date.parse(current.startedAt);
    current.reason = reason;
    current.signal = signal;
    current.clean = true;
  }
  writeHistory(history);
  log.info(`[restart-history] shutdown recorded reason=${reason} signal=${signal ?? "-"}`);
}

/**
 * uncaughtException handler 呼叫。標記為非 clean，附 stack。
 */
export function recordUncaughtException(err: Error): void {
  const history = readHistory();
  const current = history[history.length - 1];
  const now = new Date().toISOString();
  if (!current || current.pid !== process.pid) {
    history.push({
      pid: process.pid,
      startedAt: now,
      stoppedAt: now,
      uptimeMs: 0,
      reason: "uncaughtException",
      clean: false,
      note: err.message,
      stack: (err.stack ?? "").slice(0, 3000),
    });
  } else {
    current.stoppedAt = now;
    current.uptimeMs = Date.parse(now) - Date.parse(current.startedAt);
    current.reason = "uncaughtException";
    current.clean = false;
    current.note = err.message;
    current.stack = (err.stack ?? "").slice(0, 3000);
  }
  writeHistory(history);
}

/**
 * 取得最近 N 筆紀錄（由新到舊）。
 */
export function getRecentRestarts(n = 5): RestartEntry[] {
  const history = readHistory();
  return history.slice(-n).reverse();
}
