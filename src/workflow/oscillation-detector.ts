/**
 * @file workflow/oscillation-detector.ts
 * @description V2.16 Oscillation 偵測 — 同 atom 反覆修改 → [Guardian:Oscillation] 警告
 *
 * 觸發：file:modified（write/edit atom 檔案）
 * 閾值：同一檔案在同一 session 編輯 ≥ OSCILLATION_THRESHOLD 次
 * 輸出：eventBus.emit("workflow:oscillation", atom, count)
 *
 * 對應架構文件第 9 節「V2.16 Oscillation」
 */

import { join } from "node:path";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";
import type { OscillationRecord } from "./types.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
  emit<K extends keyof CatClawEvents>(event: K, ...args: CatClawEvents[K]): boolean;
};

// ── 設定 ──────────────────────────────────────────────────────────────────────

const OSCILLATION_THRESHOLD = 3;

// ── 狀態 ──────────────────────────────────────────────────────────────────────

/** sessionKey → Map<filePath, count> */
const _sessionEditCounts = new Map<string, Map<string, number>>();

/** 已發出警告的 (sessionKey, filePath) 組合（避免重複警告） */
const _warned = new Set<string>();

let _persistPath: string | null = null;

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initOscillationDetector(eventBus: EventBus, dataDir?: string): void {
  if (dataDir) _persistPath = join(dataDir, "oscillation-state.json");

  // 追蹤 turn context 以取得 sessionKey（file:modified 無 sessionKey）
  let _currentSessionKey = "_global";
  eventBus.on("turn:before", (ctx) => { _currentSessionKey = ctx.sessionKey; });

  eventBus.on("file:modified", (path, _tool, _accountId) => {
    const key = _currentSessionKey;

    if (!_sessionEditCounts.has(key)) _sessionEditCounts.set(key, new Map());
    const counts = _sessionEditCounts.get(key)!;
    const newCount = (counts.get(path) ?? 0) + 1;
    counts.set(path, newCount);

    if (newCount >= OSCILLATION_THRESHOLD) {
      const warnKey = `${key}:${path}`;
      if (!_warned.has(warnKey)) {
        _warned.add(warnKey);
        log.warn(`[oscillation] 偵測到振盪：${path}（編輯 ${newCount} 次）`);
        eventBus.emit("workflow:oscillation", path, newCount);
        void persistRecord({ atom: path, editCount: newCount, sessionKey: key, lastEditAt: new Date().toISOString() });
      }
    }
  });

  // session:end 後清理
  eventBus.on("session:end", (sessionId) => {
    _sessionEditCounts.delete(sessionId);
    // 清理 warned 記錄
    for (const k of [..._warned]) {
      if (k.startsWith(`${sessionId}:`)) _warned.delete(k);
    }
  });

  log.info("[oscillation-detector] 初始化完成");
}

// ── 持久化 ────────────────────────────────────────────────────────────────────

async function persistRecord(record: OscillationRecord): Promise<void> {
  if (!_persistPath) return;
  try {
    const dir = _persistPath.split("/").slice(0, -1).join("/");
    await mkdir(dir, { recursive: true });
    let records: OscillationRecord[] = [];
    try {
      const raw = await readFile(_persistPath, "utf-8");
      records = JSON.parse(raw) as OscillationRecord[];
    } catch { /* 檔案不存在 → 從空陣列開始 */ }
    records.push(record);
    // 保留最近 200 筆
    if (records.length > 200) records = records.slice(-200);
    await writeFile(_persistPath, JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[oscillation-detector] 持久化失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 取得 session 的 oscillation 統計（供測試用） */
export function getSessionOscillationStats(sessionKey: string): Map<string, number> {
  return _sessionEditCounts.get(sessionKey) ?? new Map();
}
