/**
 * @file migration/import-claude.ts
 * @description 將 ~/.claude/memory/ 的原子記憶遷移到 ~/.catclaw/memory/global/
 *
 * 策略：
 * - 複製 atom .md 檔（不覆寫已存在的，除非加 --force）
 * - 合併 MEMORY.md 索引（去重後附加新條目）
 * - 不刪除來源檔案（非破壞性操作）
 * - episodic/ + _vectordb/ 不遷移（TTL 自然過期，vector 重建）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { resolveCatclawDir } from "../core/config.js";
import { getBootAgentDataDir } from "../core/agent-loader.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** 來源：~/.claude/memory/ */
  sourcePath: string;
  /** 目標：~/.catclaw/memory/global/ */
  destPath: string;
  /** 已存在的 atom 是否覆寫（預設 false） */
  force?: boolean;
  /** 乾跑模式：只列出動作，不執行 */
  dryRun?: boolean;
}

export interface ImportResult {
  copied: string[];
  skipped: string[];
  errors: string[];
  mergedIndexEntries: number;
}

// ── 跳過目錄 ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["_vectordb", "episodic", "_staging"]);

// ── 工具 ─────────────────────────────────────────────────────────────────────

function walkMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith("_") || SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkMdFiles(full));
    } else if (entry.endsWith(".md") && entry !== "MEMORY.md") {
      results.push(full);
    }
  }
  return results;
}

/**
 * 解析 MEMORY.md 索引，回傳現有的 atom name set
 */
function parseMemoryIndex(indexPath: string): Map<string, string> {
  /** name → 完整列（含 path / trigger / confidence） */
  const entries = new Map<string, string>();
  if (!existsSync(indexPath)) return entries;
  const lines = readFileSync(indexPath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map(s => s.trim()).filter(Boolean);
    if (cells.length >= 2 && cells[0] !== "Atom" && cells[0] !== "---") {
      entries.set(cells[0]!, line);
    }
  }
  return entries;
}

/**
 * 從 atom 檔案讀取 Trigger 和 Confidence
 */
function parseAtomMeta(filePath: string): { trigger: string; confidence: string } {
  if (!existsSync(filePath)) return { trigger: "-", confidence: "[臨]" };
  const lines = readFileSync(filePath, "utf-8").split("\n");
  let trigger = "-";
  let confidence = "[臨]";
  for (const line of lines) {
    if (line.startsWith("- Trigger:")) {
      trigger = line.replace("- Trigger:", "").trim();
    }
    if (line.startsWith("- Confidence:")) {
      confidence = line.replace("- Confidence:", "").trim();
    }
  }
  return { trigger, confidence };
}

// ── 主要函式 ─────────────────────────────────────────────────────────────────

export async function importFromClaude(opts: ImportOptions): Promise<ImportResult> {
  const { sourcePath, destPath, force = false, dryRun = false } = opts;
  const result: ImportResult = { copied: [], skipped: [], errors: [], mergedIndexEntries: 0 };

  if (!existsSync(sourcePath)) {
    throw new Error(`來源路徑不存在：${sourcePath}`);
  }

  if (!dryRun) mkdirSync(destPath, { recursive: true });

  // ── 1. 複製 atom 檔案 ─────────────────────────────────────────────────────
  const sourceFiles = walkMdFiles(sourcePath);
  for (const srcFile of sourceFiles) {
    const rel = relative(sourcePath, srcFile);
    const destFile = join(destPath, rel);

    if (!dryRun) mkdirSync(dirname(destFile), { recursive: true });

    if (existsSync(destFile) && !force) {
      result.skipped.push(rel);
      log.debug(`[import-claude] skip（已存在）${rel}`);
      continue;
    }

    try {
      if (!dryRun) copyFileSync(srcFile, destFile);
      result.copied.push(rel);
      log.debug(`[import-claude] 複製 ${rel}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rel}: ${msg}`);
      log.warn(`[import-claude] 複製失敗 ${rel}: ${msg}`);
    }
  }

  // ── 2. 合併 MEMORY.md 索引 ────────────────────────────────────────────────
  const sourceIndexPath = join(sourcePath, "MEMORY.md");
  const destIndexPath = join(destPath, "MEMORY.md");

  if (existsSync(sourceIndexPath)) {
    const srcEntries = parseMemoryIndex(sourceIndexPath);
    const destEntries = parseMemoryIndex(destIndexPath);

    const newEntries: string[] = [];
    for (const [name, line] of srcEntries) {
      if (!destEntries.has(name)) {
        newEntries.push(line);
        result.mergedIndexEntries++;
      }
    }

    if (newEntries.length > 0 && !dryRun) {
      // 讀取或初始化 dest MEMORY.md
      let destContent = existsSync(destIndexPath)
        ? readFileSync(destIndexPath, "utf-8")
        : "# Atom Index\n\n| Atom | Path | Trigger | Confidence |\n|------|------|---------|------------|\n";

      // 確保結尾有換行
      if (!destContent.endsWith("\n")) destContent += "\n";
      destContent += newEntries.join("\n") + "\n";
      writeFileSync(destIndexPath, destContent, "utf-8");
      log.info(`[import-claude] 合併 MEMORY.md：新增 ${newEntries.length} 條`);
    }
  }

  log.info(`[import-claude] 完成：複製 ${result.copied.length}，跳過 ${result.skipped.length}，錯誤 ${result.errors.length}`);
  return result;
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("import-claude.js") || process.argv[1]?.endsWith("import-claude.ts")) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  const sourcePath = args.find(a => a.startsWith("--source="))?.slice(9)
    ?? join(homedir(), ".claude", "memory");
  const destPath = args.find(a => a.startsWith("--dest="))?.slice(7)
    ?? join(getBootAgentDataDir(), "memory", "global");

  console.log(`[import-claude] source=${sourcePath}  dest=${destPath}  force=${force}  dryRun=${dryRun}`);

  try {
    const result = await importFromClaude({ sourcePath, destPath, force, dryRun });
    console.log(`✅ 完成：複製 ${result.copied.length} 個，跳過 ${result.skipped.length} 個，合併索引 ${result.mergedIndexEntries} 條`);
    if (result.errors.length > 0) {
      console.error(`❌ 錯誤 ${result.errors.length} 個：`);
      result.errors.forEach(e => console.error("  ", e));
    }
  } catch (err) {
    console.error("❌", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
