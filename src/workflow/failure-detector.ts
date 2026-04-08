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
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
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

// ── Failure Recall（跨 session 錯誤學習）────────────────────────────────────

interface FailureEntry {
  tool: string;
  error: string;
  count: number;
  date: string;
}

/**
 * 掃描 failures/ 目錄，回傳最近 N 天內出現次數 ≥ minCount 的失敗摘要。
 * 供 prompt-assembler 注入 system prompt。
 */
export async function getRecentFailureSummary(opts?: {
  days?: number;
  minCount?: number;
  maxEntries?: number;
}): Promise<string> {
  if (!_memoryDir) return "";

  const days = opts?.days ?? 7;
  const minCount = opts?.minCount ?? 2;
  const maxEntries = opts?.maxEntries ?? 5;
  const failuresDir = join(_memoryDir, "failures");

  try {
    const files = await readdir(failuresDir).catch(() => [] as string[]);
    if (files.length === 0) return "";

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 解析所有 failure 記錄，統計 tool+error 組合
    const stats = new Map<string, FailureEntry>();

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(join(failuresDir, file), "utf-8").catch(() => "");
      // 解析格式：## [ISO] toolName 失敗 #N  \n - **錯誤**：msg \n - **日期**：YYYY-MM-DD
      const blocks = content.split(/^## /m).filter(Boolean);
      for (const block of blocks) {
        const dateMatch = block.match(/\*\*日期\*\*：(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch || dateMatch[1]! < cutoffStr) continue;

        const errorMatch = block.match(/\*\*錯誤\*\*：(.+)/);
        const countMatch = block.match(/失敗 #(\d+)/);
        const toolMatch = file.match(/^(.+)-failures\.md$/);
        if (!errorMatch || !toolMatch) continue;

        const tool = toolMatch[1]!;
        const error = errorMatch[1]!.slice(0, 100);
        const count = parseInt(countMatch?.[1] ?? "1", 10);
        const key = `${tool}::${error}`;

        const existing = stats.get(key);
        if (!existing || count > existing.count) {
          stats.set(key, { tool, error, count, date: dateMatch[1]! });
        }
      }
    }

    // 過濾 + 排序
    const entries = [...stats.values()]
      .filter(e => e.count >= minCount)
      .sort((a, b) => b.count - a.count)
      .slice(0, maxEntries);

    if (entries.length === 0) return "";

    const lines = entries.map(e => `- ${e.tool}: ${e.error}（${e.count} 次，${e.date}）`);
    return `⚠️ 已知 tool 陷阱（自動偵測，近 ${days} 天）：\n${lines.join("\n")}`;
  } catch (err) {
    log.debug(`[failure-detector] recall 失敗：${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// ── 記錄寫入 ──────────────────────────────────────────────────────────────

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
