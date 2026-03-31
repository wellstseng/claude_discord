/**
 * @file skills/builtin/migrate.ts
 * @description /migrate 記憶遷移管理 skill（tier=admin）
 *
 * 子命令：
 *   /migrate import [--force] [--dry-run]  — 從 ~/.claude 匯入記憶
 *   /migrate rebuild [<memoryDir>]          — 重建 MEMORY.md 索引
 *   /migrate seed [--dry-run]              — 將 atom 嵌入至 LanceDB
 *   /migrate status                         — 顯示遷移狀態
 *   /migrate search <query>                — 直查 LanceDB（不過 LLM）
 *   /migrate stats                          — LanceDB 向量數 + table 清單
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { log } from "../../logger.js";
import { resolveCatclawDir } from "../../core/config.js";

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function handleImport(args: string): Promise<SkillResult> {
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  const sourcePath = join(homedir(), ".claude", "memory");
  const destPath = join(resolveCatclawDir(), "memory", "global");

  if (!existsSync(sourcePath)) {
    return { text: `❌ 來源路徑不存在：\`${sourcePath}\``, isError: true };
  }

  try {
    const { importFromClaude } = await import("../../migration/import-claude.js");
    const result = await importFromClaude({ sourcePath, destPath, force, dryRun });

    return {
      text: [
        dryRun ? "**[Dry Run] 遷移預覽**" : "**記憶遷移完成**",
        `• 複製：${result.copied.length} 個 atom`,
        `• 跳過：${result.skipped.length} 個（已存在）`,
        `• 合併索引：${result.mergedIndexEntries} 條`,
        result.errors.length > 0 ? `• ❌ 錯誤：${result.errors.length} 個` : null,
        `\n來源：\`${sourcePath}\`\n目標：\`${destPath}\``,
        !force && !dryRun ? "\n提示：加 `--force` 覆寫已存在的 atom" : null,
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleRebuild(args: string): Promise<SkillResult> {
  const dryRun = args.includes("--dry-run");
  const customDir = args.trim().replace("--dry-run", "").trim();

  const memoryDir = customDir || join(resolveCatclawDir(), "memory", "global");

  try {
    const { rebuildIndex } = await import("../../migration/rebuild-index.js");
    const result = rebuildIndex({ memoryDir, dryRun });

    return {
      text: [
        dryRun ? "**[Dry Run] 索引重建預覽**" : "**MEMORY.md 重建完成**",
        `• 找到 ${result.atomCount} 個 atom`,
        `• 索引路徑：\`${result.indexPath}\``,
      ].join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleSeed(args: string): Promise<SkillResult> {
  const dryRun = args.includes("--dry-run");
  const { getPlatformMemoryEngine } = await import("../../core/platform.js");
  const engine = getPlatformMemoryEngine();
  if (!engine) {
    return { text: "❌ MemoryEngine 未啟動（平台模式未啟用）", isError: true };
  }

  const { resolveCatclawDir } = await import("../../core/config.js");
  const catclawDir = resolveCatclawDir();
  const { join: pathJoin } = await import("node:path");
  const globalDir = pathJoin(catclawDir, "memory", "global");

  if (dryRun) {
    const { existsSync, readdirSync } = await import("node:fs");
    if (!existsSync(globalDir)) {
      return { text: `❌ 記憶目錄不存在：\`${globalDir}\``, isError: true };
    }
    const mdCount = readdirSync(globalDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md").length;
    return { text: `**[Dry Run] seed 預覽**\n• 目錄：\`${globalDir}\`\n• 預計 embed：${mdCount} 個 atom（namespace=global）` };
  }

  try {
    const result = await engine.seedFromDir(globalDir, "global");
    return {
      text: [
        "**記憶 Seed 完成**",
        `• 目錄：\`${globalDir}\``,
        `• Embedded：${result.seeded} 個`,
        `• 錯誤：${result.errors} 個`,
        result.errors > 0 ? "⚠️ 有錯誤，請查看 log" : "✅ Ollama embedding 服務需已啟動",
      ].join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function handleStatus(): SkillResult {
  const claudeMemory = join(homedir(), ".claude", "memory");
  const catclawMemory = join(resolveCatclawDir(), "memory", "global");

  const countMd = (dir: string): number => {
    if (!existsSync(dir)) return 0;
    let n = 0;
    try {
      const scan = (d: string) => {
        for (const entry of readdirSync(d)) {
          if (entry.startsWith("_")) continue;
          const full = join(d, entry);
          try {
            const stat = require("node:fs").statSync(full);
            if (stat.isDirectory()) scan(full);
            else if (entry.endsWith(".md") && entry !== "MEMORY.md") n++;
          } catch { /* skip */ }
        }
      };
      scan(dir);
    } catch { /* skip */ }
    return n;
  };

  const src = countMd(claudeMemory);
  const dst = countMd(catclawMemory);

  return {
    text: [
      "**遷移狀態**",
      `• \`~/.claude/memory/\` → ${src} 個 atom${existsSync(claudeMemory) ? "" : "（路徑不存在）"}`,
      `• \`~/.catclaw/memory/global/\` → ${dst} 個 atom${existsSync(catclawMemory) ? "" : "（路徑不存在）"}`,
      src > dst ? `\n提示：執行 \`/migrate import\` 遷移 ~${src - dst} 個尚未複製的 atom` : null,
    ].filter(Boolean).join("\n"),
  };
}

async function handleSearch(args: string): Promise<SkillResult> {
  const dryRun = args.includes("--dry-run");
  const query = args.replace("--dry-run", "").trim();
  if (!query) return { text: "用法：`/migrate search <查詢文字>`" };

  const { getVectorService } = await import("../../vector/lancedb.js");
  const vs = getVectorService();
  if (!vs.isReady()) return { text: "LanceDB 未初始化（bot 是否完全啟動？）" };

  if (dryRun) return { text: `[dry-run] 會搜尋 namespace=global，query="${query}"` };

  const results = await vs.search(query, { namespace: "global", topK: 5, minScore: 0 });
  if (!results.length) return { text: `**向量搜尋**：無命中（namespace=global）` };

  const lines = results.map((r, i) =>
    `${i + 1}. \`${r.id}\` score=${r.score.toFixed(4)}\n   ${r.text.slice(0, 80).replace(/\n/g, " ")}…`
  );
  return { text: `**向量搜尋** query="${query}"\n${lines.join("\n")}` };
}

async function handleStats(): Promise<SkillResult> {
  const { getVectorService } = await import("../../vector/lancedb.js");
  const vs = getVectorService();
  if (!vs.isReady()) return { text: "LanceDB 未初始化" };

  const info = await vs.stats();
  if (!info) return { text: "stats 不可用" };

  const lines = info.tables.map(t => `• \`${t.name}\` — ${t.count} 筆向量`);
  return { text: `**LanceDB 狀態**\n${lines.join("\n") || "（無 table）"}` };
}

// ── Skill 定義 ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "migrate",
  description: "記憶遷移管理：從 ~/.claude 匯入、重建索引、查看狀態",
  tier: "admin",
  trigger: ["/migrate"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const tokens = ctx.args.trim().split(/\s+/);
    const sub = (tokens[0] ?? "").toLowerCase();
    const rest = tokens.slice(1).join(" ");

    log.debug(`[skill:migrate] sub=${sub}`);

    switch (sub) {
      case "import":  return handleImport(rest);
      case "rebuild": return handleRebuild(rest);
      case "seed":    return handleSeed(rest);
      case "status":  return handleStatus();
      case "search":  return handleSearch(rest);
      case "stats":   return handleStats();
      default:
        return {
          text: [
            "**`/migrate` 子命令**",
            "• `import [--force] [--dry-run]` — 從 `~/.claude/memory/` 匯入記憶",
            "• `rebuild [<memoryDir>] [--dry-run]` — 重建 `MEMORY.md` 索引",
            "• `seed [--dry-run]` — 將記憶目錄 atom 嵌入至 LanceDB",
            "• `status` — 查看遷移狀態",
            "• `search <query>` — 直查 LanceDB（不過 LLM，minScore=0 顯示原始 score）",
            "• `stats` — LanceDB table 清單 + 向量數",
          ].join("\n"),
        };
    }
  },
};
