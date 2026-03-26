/**
 * @file memory/episodic.ts
 * @description Episodic 記憶 — Session 自動摘要，TTL 24d
 *
 * EP1: session:idle / platform:shutdown 觸發
 * EP2: 門檻：modified_files ≥ 1 + session ≥ 2min；或 read_files ≥ 5
 * EP3: 閱讀軌跡壓縮（「讀 N 檔: area (count)」）
 * F3:  覆轍信號（same_file_3x / retry_escalation）— 寫入 episodic
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface SessionStats {
  sessionKey: string;
  accountId: string;
  projectId?: string;
  startedAt: number;   // timestamp ms
  modifiedFiles: string[];
  readFiles: string[];
  turnCount: number;
  retryCount: number;
}

export interface RutWarning {
  type: "same_file_3x" | "retry_escalation";
  file?: string;
  count: number;
  message: string;
}

// ── 覆轍偵測（F3） ────────────────────────────────────────────────────────────

function detectRuts(stats: SessionStats): RutWarning[] {
  const warnings: RutWarning[] = [];

  // same_file_3x：同一檔案修改 ≥ 3 次
  const fileCounts = new Map<string, number>();
  for (const f of stats.modifiedFiles) {
    fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
  }
  for (const [file, count] of fileCounts) {
    if (count >= 3) {
      warnings.push({
        type: "same_file_3x",
        file,
        count,
        message: `${basename(file)} 本 session 修改 ${count} 次，可能在打轉`,
      });
    }
  }

  // retry_escalation：turnCount 高但 retryCount 也高
  if (stats.retryCount >= 2) {
    warnings.push({
      type: "retry_escalation",
      count: stats.retryCount,
      message: `本 session 修正 ${stats.retryCount} 次，建議啟動 Fix Escalation`,
    });
  }

  return warnings;
}

// ── 閱讀軌跡壓縮（EP3） ──────────────────────────────────────────────────────

function compressReadTrack(readFiles: string[]): string {
  if (!readFiles.length) return "";

  // 按目錄分組
  const areas = new Map<string, number>();
  for (const f of readFiles) {
    const parts = f.split("/");
    // 取路徑最後第 2 層作為 area（e.g. src/memory → memory）
    const area = parts.length >= 2 ? parts[parts.length - 2] : "root";
    areas.set(area, (areas.get(area) ?? 0) + 1);
  }

  const summary = Array.from(areas.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => `${area}(${count})`)
    .join(", ");

  return `讀 ${readFiles.length} 檔: ${summary}`;
}

// ── 生成 Episodic ─────────────────────────────────────────────────────────────

function shouldGenerate(stats: SessionStats): boolean {
  const durationMin = (Date.now() - stats.startedAt) / 60_000;
  const hasModified = stats.modifiedFiles.length >= 1;
  const longEnough = durationMin >= 2;
  const manyRead = stats.readFiles.length >= 5;
  return (hasModified && longEnough) || manyRead;
}

function formatEpisodic(stats: SessionStats, ruts: RutWarning[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const durationMin = Math.round((Date.now() - stats.startedAt) / 60_000);
  const readSummary = compressReadTrack(stats.readFiles);

  const lines = [
    `# Episodic: ${date} [${stats.sessionKey}]`,
    "",
    `- Date: ${date}`,
    `- Duration: ${durationMin}m`,
    `- Account: ${stats.accountId}`,
    ...(stats.projectId ? [`- Project: ${stats.projectId}`] : []),
    `- Turns: ${stats.turnCount}`,
    "",
    "## 修改軌跡",
    "",
    ...(stats.modifiedFiles.length
      ? stats.modifiedFiles.map(f => `- ${f}`)
      : ["（無）"]),
    "",
    "## 閱讀軌跡",
    "",
    readSummary ? `- ${readSummary}` : "（無）",
    "",
    ...(ruts.length > 0 ? [
      "## 覆轍信號",
      "",
      ...ruts.map(r => `- [${r.type}] ${r.message}`),
      "",
    ] : []),
  ];

  return lines.join("\n");
}

// ── TTL 清理 ──────────────────────────────────────────────────────────────────

function cleanExpired(episodicDir: string, ttlDays: number): void {
  if (!existsSync(episodicDir)) return;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

  try {
    const files = readdirSync(episodicDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(episodicDir, f);
      // 從檔名取日期（格式 episodic-YYYY-MM-DD-xxx.md）
      const match = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (match) {
        const fileDate = new Date(match[1]).getTime();
        if (fileDate < cutoff) {
          unlinkSync(filePath);
          log.debug(`[episodic] 刪除過期 ${f}`);
        }
      }
    }
  } catch (err) {
    log.warn(`[episodic] TTL 清理失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export interface EpisodicOpts {
  episodicDir: string;
  ttlDays: number;
}

/**
 * 生成並寫入 episodic 記憶
 * 觸發點：session:idle / platform:shutdown
 */
export async function generateEpisodic(
  stats: SessionStats,
  opts: EpisodicOpts
): Promise<string | null> {
  if (!shouldGenerate(stats)) {
    log.debug(`[episodic] 不符合生成門檻 (modified=${stats.modifiedFiles.length}, read=${stats.readFiles.length})`);
    return null;
  }

  // TTL 清理
  cleanExpired(opts.episodicDir, opts.ttlDays);

  // 覆轍偵測
  const ruts = detectRuts(stats);

  // 生成內容
  const content = formatEpisodic(stats, ruts);
  const date = new Date().toISOString().slice(0, 10);
  const hash = Math.random().toString(36).slice(2, 6);
  const fileName = `episodic-${date}-${hash}.md`;

  try {
    mkdirSync(opts.episodicDir, { recursive: true });
    const filePath = join(opts.episodicDir, fileName);
    writeFileSync(filePath, content, "utf-8");
    log.info(`[episodic] 生成 ${fileName}${ruts.length ? `（${ruts.length} 覆轍信號）` : ""}`);
    return filePath;
  } catch (err) {
    log.warn(`[episodic] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 偵測 RUT 模式（供 session:start 時掃描注入警告）
 * 掃描近期 episodic，找到相同覆轍信號
 */
export function detectRutPatterns(
  episodicDir: string,
  currentFile?: string
): RutWarning[] {
  if (!existsSync(episodicDir)) return [];

  const warnings: RutWarning[] = [];
  const fileRutCounts = new Map<string, number>();
  let retryEscalationCount = 0;

  try {
    const files = readdirSync(episodicDir)
      .filter(f => f.endsWith(".md") && f !== basename(currentFile ?? ""))
      .sort()
      .slice(-10); // 只看最近 10 個

    for (const f of files) {
      const filePath = join(episodicDir, f);
      const content = readFileSync(filePath, "utf-8");

      // 解析 same_file_3x
      const sameFileMatch = content.matchAll(/\[same_file_3x\] (.+?) 本 session 修改 (\d+) 次/g);
      for (const m of sameFileMatch) {
        const file = m[1];
        fileRutCounts.set(file, (fileRutCounts.get(file) ?? 0) + 1);
      }

      // 解析 retry_escalation
      if (content.includes("[retry_escalation]")) retryEscalationCount++;
    }

    for (const [file, count] of fileRutCounts) {
      if (count >= 2) {
        warnings.push({ type: "same_file_3x", file, count, message: `跨 session 反覆修改 ${file}（${count} 次）` });
      }
    }
    if (retryEscalationCount >= 2) {
      warnings.push({ type: "retry_escalation", count: retryEscalationCount, message: `跨 session 反覆 retry escalation（${retryEscalationCount} 次）` });
    }
  } catch { /* 靜默 */ }

  return warnings;
}
