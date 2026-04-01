/**
 * @file workflow/consolidate-scheduler.ts
 * @description 定時觸發記憶 consolidate（促進 / 歸檔候選評估）
 *
 * 首次：5 分鐘後執行
 * 之後：每 6 小時
 */

import { log } from "../logger.js";

const DELAY_MS    = 5 * 60_000;    // 首次 5 分鐘後執行
const INTERVAL_MS = 6 * 3600_000;  // 之後每 6 小時

async function run(): Promise<void> {
  try {
    const { getMemoryEngine } = await import("../memory/engine.js");
    const engine = getMemoryEngine();
    const result = await engine.evaluatePromotions();
    log.info(`[consolidate-scheduler] 完成：promoted=${result.promoted.length} archive=${result.archiveCandidates.length}`);
  } catch (err) {
    log.warn(`[consolidate-scheduler] 執行失敗（graceful）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function scheduleConsolidate(): void {
  const t = setTimeout(() => {
    void run();
    setInterval(() => void run(), INTERVAL_MS).unref();
  }, DELAY_MS);
  t.unref();

  log.info("[consolidate-scheduler] 排程已設定（首次 5 分鐘後，之後每 6 小時）");
}
