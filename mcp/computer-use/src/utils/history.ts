/**
 * @file utils/history.ts
 * @description 操作歷程記錄 — 每步操作的截圖 + 參數 + 時間戳
 */

import { writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const HISTORY_DIR = process.env["COMPUTER_USE_HISTORY_DIR"] ?? "/tmp/computer-use-history";
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  id: number;
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  /** 操作前截圖（base64，縮圖） */
  screenshotBefore?: string;
  /** 操作後截圖（base64，縮圖） */
  screenshotAfter?: string;
  result?: Record<string, unknown>;
  durationMs?: number;
}

let entries: HistoryEntry[] = [];
let nextId = 1;
let initialized = false;

async function ensureDir(): Promise<void> {
  if (initialized) return;
  await mkdir(HISTORY_DIR, { recursive: true });
  initialized = true;
}

/**
 * 記錄一筆操作
 */
export async function recordOperation(
  tool: string,
  params: Record<string, unknown>,
  result?: Record<string, unknown>,
  screenshotBefore?: string,
  durationMs?: number,
): Promise<HistoryEntry> {
  await ensureDir();

  const entry: HistoryEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    tool,
    params,
    screenshotBefore,
    result,
    durationMs,
  };

  entries.push(entry);

  // 淘汰舊紀錄
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }

  // 非同步寫入檔案（不阻塞）
  const filename = `${String(entry.id).padStart(5, "0")}_${tool}.json`;
  const filePath = join(HISTORY_DIR, filename);
  // 不寫截圖到 JSON（太大），只寫 metadata
  const { screenshotBefore: _sb, screenshotAfter: _sa, ...meta } = entry;
  writeFile(filePath, JSON.stringify(meta, null, 2)).catch(() => {});

  return entry;
}

/**
 * 取得最近 N 筆操作摘要
 */
export function getRecentHistory(count: number = 10): HistoryEntry[] {
  return entries.slice(-count).map(e => {
    // 移除截圖資料，只回傳 metadata
    const { screenshotBefore: _sb, screenshotAfter: _sa, ...meta } = e;
    return meta as HistoryEntry;
  });
}

/**
 * 匯出 Markdown 報告
 */
export function exportMarkdownReport(): string {
  const lines: string[] = [
    "# Computer Use 操作歷程",
    "",
    `> 產生時間：${new Date().toISOString()}`,
    `> 共 ${entries.length} 筆操作`,
    "",
    "| # | 時間 | Tool | 參數摘要 | 耗時 |",
    "|---|------|------|---------|------|",
  ];

  for (const e of entries) {
    const paramStr = Object.entries(e.params)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 20) : JSON.stringify(v)}`)
      .join(", ")
      .slice(0, 60);
    const dur = e.durationMs != null ? `${e.durationMs}ms` : "-";
    const time = e.timestamp.split("T")[1]?.split(".")[0] ?? "";
    lines.push(`| ${e.id} | ${time} | ${e.tool} | ${paramStr} | ${dur} |`);
  }

  return lines.join("\n");
}

/**
 * 清除歷程
 */
export async function clearHistory(): Promise<void> {
  entries = [];
  nextId = 1;
  try {
    await ensureDir();
    const files = await readdir(HISTORY_DIR);
    for (const f of files) {
      if (f.endsWith(".json")) await unlink(join(HISTORY_DIR, f)).catch(() => {});
    }
  } catch { /* ignore */ }
}
