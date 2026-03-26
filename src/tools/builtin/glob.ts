/**
 * @file tools/builtin/glob.ts
 * @description glob 工具 — 按模式搜尋檔案路徑（tier=elevated）
 *
 * 支援：** (任意層級)、* (單層萬用)、? (單字元)、{a,b} (選擇)
 * 結果按修改時間降序排列（最新在前）
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { log } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

// ── 模式轉換 ──────────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/[.+^$|[\]\\]/g, "\\$&")              // escape 特殊 regex 字元（保留 {}?*）
    .replace(/\{([^}]+)\}/g, (_, g) => `(${(g as string).split(",").map((s: string) => s.trim().replace(/[.+^$|[\]\\]/g, "\\$&")).join("|")})`)
    .replace(/\*\*\//g, "__DS_SLASH__")              // **/ 暫存（可對應零個目錄層）
    .replace(/\*\*/g, "__DS__")                      // ** 暫存（任意字串）
    .replace(/\*/g, "[^/]*")                         // * = 不含 /
    .replace(/\?/g, "[^/]")                          // ? = 不含 /
    .replace(/__DS_SLASH__/g, "(.*/)?")              // **/ = 零到多層目錄
    .replace(/__DS__/g, ".*");                       // ** = 任意字串

  return new RegExp(`^${regexStr}$`);
}

// ── 遞迴掃描 ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "dist", ".cache"]);
const MAX_FILES = 1000;

async function scanDir(
  dir: string,
  baseDir: string,
  re: RegExp,
  results: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  if (results.length >= MAX_FILES) return;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    const fullPath = join(dir, entry);
    const relPath = relative(baseDir, fullPath);

    let st;
    try { st = await stat(fullPath); } catch { continue; }

    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) await scanDir(fullPath, baseDir, re, results);
    } else if (re.test(relPath)) {
      results.push({ path: fullPath, mtimeMs: st.mtimeMs });
    }
  }
}

// ── Tool 定義 ─────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "glob",
  description: "按 glob 模式搜尋檔案路徑。支援 **、*、?、{a,b}。結果按修改時間降序排列，上限 1000 筆。",
  tier: "elevated",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "glob 模式，例如 **/*.ts 或 src/**/*.{ts,js}",
      },
      path: {
        type: "string",
        description: "搜尋的根目錄（絕對路徑，預設為當前工作目錄）",
      },
    },
    required: ["pattern"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(params["pattern"] ?? "");
    const baseDir = String(params["path"] ?? process.cwd());

    if (!pattern) return { error: "pattern 不能為空" };

    const re = globToRegex(pattern);
    const results: Array<{ path: string; mtimeMs: number }> = [];

    try {
      await scanDir(baseDir, baseDir, re, results);
    } catch (err) {
      return { error: `掃描失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    // 按修改時間降序
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const paths = results.map(r => r.path);

    log.debug(`[glob] pattern=${pattern} base=${baseDir} → ${paths.length} 筆`);

    return { result: paths };
  },
};
