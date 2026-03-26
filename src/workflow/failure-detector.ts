/**
 * @file workflow/failure-detector.ts
 * @description 失敗偵測器 — tool:error 自動寫入 failures/ atom
 *
 * 觸發：tool:error
 * 輸出：~/.catclaw/memory/failures/{toolName}-{date}.md append
 *
 * 對應架構文件第 9 節「Failure detection」
 */

import { join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

// ── 設定 ──────────────────────────────────────────────────────────────────────

/** 單次 session 內同一 tool 失敗幾次後才記錄（避免刷重複記錄） */
const RECORD_THRESHOLD = 2;

// ── 狀態 ──────────────────────────────────────────────────────────────────────

/** toolName → errorMessage → count */
const _failureCounts = new Map<string, Map<string, number>>();

let _memoryDir: string | null = null;

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initFailureDetector(eventBus: EventBus, memoryDir: string): void {
  _memoryDir = memoryDir;

  eventBus.on("tool:error", (call, error) => {
    const toolName = call.name;
    const errorMsg = error.message;

    if (!_failureCounts.has(toolName)) _failureCounts.set(toolName, new Map());
    const counts = _failureCounts.get(toolName)!;
    const newCount = (counts.get(errorMsg) ?? 0) + 1;
    counts.set(errorMsg, newCount);

    if (newCount >= RECORD_THRESHOLD) {
      log.warn(`[failure-detector] tool=${toolName} 同錯誤 ${newCount} 次：${errorMsg.slice(0, 80)}`);
      void appendFailureRecord(toolName, errorMsg, call.params, newCount);
    }
  });

  log.info("[failure-detector] 初始化完成");
}

// ── 記錄寫入 ──────────────────────────────────────────────────────────────────

async function appendFailureRecord(
  toolName: string,
  errorMsg: string,
  params: unknown,
  count: number,
): Promise<void> {
  if (!_memoryDir) return;

  try {
    const failuresDir = join(_memoryDir, "failures");
    await mkdir(failuresDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const fileName = `${toolName}-failures.md`;
    const filePath = join(failuresDir, fileName);

    const entry = [
      "",
      `## [${new Date().toISOString()}] ${toolName} 失敗 #${count}`,
      `- **錯誤**：${errorMsg}`,
      `- **參數**：${JSON.stringify(params, null, 0).slice(0, 200)}`,
      `- **日期**：${date}`,
    ].join("\n");

    await appendFile(filePath, entry + "\n", "utf-8");
    log.debug(`[failure-detector] 已記錄到 ${fileName}`);
  } catch (err) {
    log.warn(`[failure-detector] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
