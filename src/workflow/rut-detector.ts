/**
 * @file workflow/rut-detector.ts
 * @description V2.17 覆轍偵測 — 跨 Session 同一問題反覆出現 → [Guardian:覆轍] 警告
 *
 * 機制：
 *   1. session:end → 從 TurnTracker 萃取 rut signals（same_file_3x, retry_escalation）
 *      → 寫入 rut-signals.jsonl
 *   2. platform:startup → 讀取 rut-signals.jsonl → 計數 → 超閾值 → emit workflow:rut
 *
 * 對應架構文件第 9 節「V2.17 覆轍偵測」
 */

import { join } from "node:path";
import { writeFile, readFile, appendFile, mkdir } from "node:fs/promises";
import { log } from "../logger.js";
import type { CatClawEvents, RutWarning } from "../core/event-bus.js";
import type { RutSignal } from "./types.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
  emit<K extends keyof CatClawEvents>(event: K, ...args: CatClawEvents[K]): boolean;
};

// ── 設定 ──────────────────────────────────────────────────────────────────────

/** 同一 pattern 出現幾次以上才觸發警告 */
const RUT_MIN_OCCURRENCES = 2;
/** 信號保留時間（毫秒，預設 14 天） */
const RUT_WINDOW_MS = 14 * 24 * 3600_000;
/** 最多保留的信號條數 */
const MAX_SIGNALS = 500;

// ── 狀態 ──────────────────────────────────────────────────────────────────────

let _signalsPath: string | null = null;

/**
 * 手動記錄 rut signal（供 agent-loop 在 turn 結束後呼叫）
 */
export async function recordRutSignals(sessionId: string, signals: string[]): Promise<void> {
  if (!_signalsPath || signals.length === 0) return;
  try {
    const dir = _signalsPath.split("/").slice(0, -1).join("/");
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    for (const pattern of signals) {
      const record: RutSignal = { pattern, sessionId, recordedAt: now };
      await appendFile(_signalsPath, JSON.stringify(record) + "\n", "utf-8");
    }
  } catch (err) {
    log.warn(`[rut-detector] 寫入信號失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 啟動掃描 ──────────────────────────────────────────────────────────────────

async function scanAndEmitWarnings(eventBus: EventBus): Promise<void> {
  if (!_signalsPath) return;

  let raw: string;
  try {
    raw = await readFile(_signalsPath, "utf-8");
  } catch {
    return; // 檔案不存在 → 無歷史
  }

  const now = Date.now();
  const lines = raw.trim().split("\n").filter(Boolean);
  const validSignals: RutSignal[] = [];

  for (const line of lines) {
    try {
      const signal = JSON.parse(line) as RutSignal;
      const age = now - new Date(signal.recordedAt).getTime();
      if (age <= RUT_WINDOW_MS) validSignals.push(signal);
    } catch { /* 忽略損壞的行 */ }
  }

  // 清理過期信號（重新寫入）
  if (validSignals.length < lines.length) {
    try {
      await writeFile(_signalsPath, validSignals.map(s => JSON.stringify(s)).join("\n") + "\n", "utf-8");
    } catch { /* 寫入失敗不影響主流程 */ }
  }

  // 計數 pattern
  const patternMap = new Map<string, RutSignal[]>();
  for (const signal of validSignals) {
    if (!patternMap.has(signal.pattern)) patternMap.set(signal.pattern, []);
    patternMap.get(signal.pattern)!.push(signal);
  }

  const warnings: RutWarning[] = [];
  for (const [pattern, signals] of patternMap) {
    if (signals.length >= RUT_MIN_OCCURRENCES) {
      warnings.push({
        pattern,
        count: signals.length,
        sessions: [...new Set(signals.map(s => s.sessionId))],
      });
    }
  }

  if (warnings.length > 0) {
    log.warn(`[rut-detector] 偵測到 ${warnings.length} 個覆轍模式`);
    for (const w of warnings) {
      log.warn(`[Guardian:覆轍] ${w.pattern}（${w.count} 次，${w.sessions.length} sessions）`);
    }
    eventBus.emit("workflow:rut", warnings);
  } else {
    log.debug("[rut-detector] 無覆轍模式");
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initRutDetector(eventBus: EventBus, dataDir: string): void {
  _signalsPath = join(dataDir, "rut-signals.jsonl");

  // platform:startup → 掃描歷史
  eventBus.on("platform:startup", () => {
    void scanAndEmitWarnings(eventBus);
  });

  log.info("[rut-detector] 初始化完成");
}

/** 直接觸發一次掃描（供測試或手動呼叫） */
export async function triggerRutScan(eventBus: EventBus): Promise<void> {
  await scanAndEmitWarnings(eventBus);
}

/** 公開 signals path 供測試用 */
export function getSignalsPath(): string | null {
  return _signalsPath;
}
