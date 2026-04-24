/**
 * @file core/log-error-monitor.ts
 * @description PM2 log 錯誤監控 — 偵測 error/crash，存 snapshot + 發 event bus 通知
 *
 * 獨立於 dashboard 的 SSE log watcher，啟動後持續監聽 PM2 log 檔案。
 * 偵測到錯誤時：
 *   1. 擷取 error 前後 context（ring buffer）
 *   2. 存到 ~/.catclaw/workspace/data/error-snapshots/
 *   3. 透過 eventBus 發送 "log:error" 事件（Discord 訂閱後通知）
 *   4. 同一 error message hash 30 分鐘內不重複通知（dedup）
 */

import { existsSync, statSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { eventBus } from "./event-bus.js";

// ── Config ──────────────────────────────────────────────────────────────────

const RING_BUFFER_SIZE = 30;         // 保留最近 N 行 context
const CONTEXT_AFTER_LINES = 5;       // error 後再收集 N 行
const DEDUP_WINDOW_MS = 30 * 60_000; // 同一 error 30 分鐘內不重複
const WATCH_INTERVAL_MS = 1000;      // 檔案變化偵測間隔

/** 錯誤行偵測 pattern */
const ERROR_PATTERNS = [
  /\[error\]/i,
  /\berror[:\s]/i,
  /\bunhandledRejection\b/i,
  /\buncaughtException\b/i,
  /\bFATAL\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  /\bECONNREFUSED\b/,
  /\bENOENT\b.*(?:spawn|exec)/i,
  /\bstack trace\b/i,
  /^\s+at\s+.*\(.*:\d+:\d+\)/,  // stack trace 行
];

/** 忽略的 false positive */
const IGNORE_PATTERNS = [
  /\[reply-handler\].*streaming edit 失敗/,  // rate limit, 非真正錯誤
  /\[cli-bridge-reply\].*streaming edit 失敗/,
  /rate.?limit/i,
  /\bDEBUG\b/i,  // debug 訊息帶 "error" 字樣
];

// ── State ───────────────────────────────────────────────────────────────────

let _watchPath: string | null = null;
let _lastSize = 0;
const _ringBuffer: string[] = [];
const _dedup = new Map<string, number>(); // hash → timestamp
let _afterCount = 0;  // error 後繼續收集的行數計數
let _currentError: { message: string; contextBefore: string[] } | null = null;
let _snapshotDir: string | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function findLogFile(): string | null {
  const candidates = [
    join(homedir(), ".pm2", "logs", "catclaw-out.log"),
    join(homedir(), ".pm2", "logs", "catclaw-test-out.log"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function hashError(msg: string): string {
  // 移除時間戳和動態部分，只取核心 error 訊息
  const normalized = msg
    .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, "")
    .replace(/\b\d{4,}\b/g, "N") // 長數字歸一
    .trim();
  return createHash("md5").update(normalized).digest("hex").slice(0, 12);
}

function isErrorLine(line: string): boolean {
  if (IGNORE_PATTERNS.some(p => p.test(line))) return false;
  return ERROR_PATTERNS.some(p => p.test(line));
}

function isStackTraceLine(line: string): boolean {
  return /^\s+at\s+/.test(line);
}

function saveSnapshot(errorMsg: string, contextLines: string[]): string {
  if (!_snapshotDir) {
    _snapshotDir = join(
      process.env.CATCLAW_WORKSPACE ?? join(homedir(), ".catclaw", "workspace"),
      "data", "error-snapshots",
    );
    mkdirSync(_snapshotDir, { recursive: true });
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = hashError(errorMsg);
  const fileName = `${ts}_${hash}.log`;
  const filePath = join(_snapshotDir, fileName);

  const content = [
    `=== Error Snapshot ===`,
    `Time: ${now.toISOString()}`,
    `Error: ${errorMsg}`,
    `Hash: ${hash}`,
    ``,
    `=== Context ===`,
    ...contextLines,
  ].join("\n");

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function flushError(): void {
  if (!_currentError) return;

  const { message, contextBefore } = _currentError;
  _currentError = null;
  _afterCount = 0;

  const hash = hashError(message);
  const now = Date.now();
  const lastSeen = _dedup.get(hash);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return; // dedup
  }
  _dedup.set(hash, now);

  // 清理過期 dedup
  for (const [k, t] of _dedup) {
    if (now - t > DEDUP_WINDOW_MS) _dedup.delete(k);
  }

  const snapshotPath = saveSnapshot(message, contextBefore);
  log.info(`[log-error-monitor] 偵測到錯誤，snapshot: ${snapshotPath}`);

  eventBus.emit("log:error", {
    timestamp: new Date().toISOString(),
    message,
    context: contextBefore.slice(-15).join("\n"),
    snapshotPath,
  });
}

function processLine(line: string): void {
  // 加入 ring buffer
  _ringBuffer.push(line);
  if (_ringBuffer.length > RING_BUFFER_SIZE) _ringBuffer.shift();

  // 正在收集 error 後續行
  if (_currentError) {
    _currentError.contextBefore.push(line);
    // stack trace 行不算 afterCount
    if (isStackTraceLine(line)) return;
    _afterCount++;
    if (_afterCount >= CONTEXT_AFTER_LINES) {
      flushError();
    }
    return;
  }

  // 偵測新的 error
  if (isErrorLine(line)) {
    _currentError = {
      message: line,
      contextBefore: [..._ringBuffer], // 含 error 本身
    };
    _afterCount = 0;
  }
}

function processChunk(chunk: string): void {
  const lines = chunk.split("\n").filter(l => l.length > 0);
  for (const line of lines) {
    processLine(line);
  }
  // 如果有掛著的 error 但沒有後續行了（檔案靜止），延遲 flush
  if (_currentError) {
    setTimeout(() => {
      if (_currentError) flushError();
    }, 3000);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function initLogErrorMonitor(): void {
  const logPath = findLogFile();
  if (!logPath) {
    log.debug("[log-error-monitor] PM2 log 檔案不存在，跳過");
    return;
  }

  _watchPath = logPath;
  try { _lastSize = statSync(logPath).size; } catch { _lastSize = 0; }

  watchFile(logPath, { interval: WATCH_INTERVAL_MS }, () => {
    try {
      const newSize = statSync(logPath).size;
      if (newSize <= _lastSize) { _lastSize = newSize; return; }
      const readLen = newSize - _lastSize;
      const buf = Buffer.alloc(readLen);
      const fd = openSync(logPath, "r");
      readSync(fd, buf, 0, readLen, _lastSize);
      closeSync(fd);
      _lastSize = newSize;
      processChunk(buf.toString("utf-8"));
    } catch { /* 檔案暫時不可讀，下次再試 */ }
  });

  log.info(`[log-error-monitor] 啟動，監聽 ${logPath}`);
}

export function stopLogErrorMonitor(): void {
  if (_watchPath) {
    unwatchFile(_watchPath);
    _watchPath = null;
    log.info("[log-error-monitor] 已停止");
  }
}
