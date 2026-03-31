/**
 * @file migration/rebuild-index.ts
 * @description 重建 MEMORY.md 索引
 *
 * 掃描記憶目錄下所有 .md 檔案（排除 _前綴目錄、MEMORY.md 本身），
 * 讀取每個 atom 的 Trigger / Confidence，重建 MEMORY.md 表格。
 *
 * 用途：
 * - 首次安裝後建立索引
 * - 手動新增 atom 後同步索引
 * - 索引損壞後修復
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { log } from "../logger.js";
import { resolveCatclawDir } from "../core/config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface RebuildOptions {
  /** 記憶根目錄（含 MEMORY.md 的目錄） */
  memoryDir: string;
  /** 乾跑：只計算，不寫入 */
  dryRun?: boolean;
}

export interface RebuildResult {
  indexPath: string;
  atomCount: number;
  /** 重建後的 MEMORY.md 內容 */
  content: string;
}

// ── 跳過清單 ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["_vectordb", "episodic", "_staging", "_reference"]);

// ── 工具 ─────────────────────────────────────────────────────────────────────

function walkAtoms(dir: string, base: string): { relPath: string; absPath: string }[] {
  const results: { relPath: string; absPath: string }[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      results.push(...walkAtoms(full, base));
    } else if (entry.endsWith(".md") && entry !== "MEMORY.md") {
      results.push({ relPath: relative(base, full), absPath: full });
    }
  }
  return results;
}

/**
 * 從 atom 檔讀取 Trigger / Confidence / 標題（第一行 # 後的文字）
 */
function parseAtomMeta(absPath: string): {
  name: string;
  trigger: string;
  confidence: string;
} {
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");

  // 標題
  const titleLine = lines.find(l => l.startsWith("# "));
  const name = titleLine ? titleLine.slice(2).trim() : basename(absPath, ".md");

  let trigger = "-";
  let confidence = "[臨]";
  for (const line of lines) {
    if (line.startsWith("- Trigger:")) {
      trigger = line.replace("- Trigger:", "").trim();
    } else if (line.startsWith("- Confidence:")) {
      confidence = line.replace("- Confidence:", "").trim();
    }
  }
  return { name, trigger, confidence };
}

// ── 主要函式 ─────────────────────────────────────────────────────────────────

export function rebuildIndex(opts: RebuildOptions): RebuildResult {
  const { memoryDir, dryRun = false } = opts;

  if (!existsSync(memoryDir)) {
    throw new Error(`記憶目錄不存在：${memoryDir}`);
  }

  const atoms = walkAtoms(memoryDir, memoryDir);

  // 建立索引表格
  const rows: string[] = [];
  for (const { relPath, absPath } of atoms) {
    try {
      const { name, trigger, confidence } = parseAtomMeta(absPath);
      rows.push(`| ${name} | ${relPath} | ${trigger} | ${confidence} |`);
    } catch (err) {
      log.warn(`[rebuild-index] 解析失敗 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const content = [
    "# Atom Index",
    "",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    ...rows,
    "",
  ].join("\n");

  const indexPath = join(memoryDir, "MEMORY.md");
  if (!dryRun) {
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    writeFileSync(indexPath, content, "utf-8");
    log.info(`[rebuild-index] 已重建 ${indexPath}（${rows.length} 個 atom）`);
  }

  return { indexPath, atomCount: rows.length, content };
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("rebuild-index.js") || process.argv[1]?.endsWith("rebuild-index.ts")) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const memoryDir = args.find(a => !a.startsWith("--"))
    ?? join(resolveCatclawDir(), "memory");

  console.log(`[rebuild-index] memoryDir=${memoryDir}  dryRun=${dryRun}`);

  try {
    const result = rebuildIndex({ memoryDir, dryRun });
    console.log(`✅ 重建完成：${result.atomCount} 個 atom → ${result.indexPath}`);
  } catch (err) {
    console.error("❌", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
