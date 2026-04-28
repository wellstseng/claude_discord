/**
 * @file skills/builtin/migrate.ts
 * @description /migrate 記憶遷移管理 skill（tier=admin）
 *
 * 子命令：
 *   /migrate import [--force] [--dry-run] [--memory-only]
 *                                          — 從 ~/.claude 匯入記憶，預設連 _AIDocs + Atomic Memory skill 一起帶入
 *   /migrate rebuild [<memoryDir>]          — 重建 MEMORY.md 索引
 *   /migrate seed [--dry-run]              — 將 atom 嵌入至 LanceDB（global）
 *   /migrate vector-resync [--dry-run] [--rebuild]
 *                                          — 全層向量 resync（upsert，預設）；--rebuild 先 dropTable 再 seed（換模型/維度時用）
 *   /migrate status                         — 顯示遷移狀態
 *   /migrate search <query>                — 直查 LanceDB（不過 LLM）
 *   /migrate stats                          — LanceDB 向量數 + table 清單
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { log } from "../../logger.js";
import { resolveCatclawDir } from "../../core/config.js";
import { getBootAgentDataDir } from "../../core/agent-loader.js";

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function handleImport(args: string): Promise<SkillResult> {
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const memoryOnly = args.includes("--memory-only");

  const sourceRoot = join(homedir(), ".claude");
  const sourcePath = join(homedir(), ".claude", "memory");
  const destPath = join(getBootAgentDataDir(), "memory");

  if (!existsSync(sourcePath)) {
    return { text: `❌ 來源路徑不存在：\`${sourcePath}\``, isError: true };
  }

  try {
    const { importFromClaude } = await import("../../migration/import-claude.js");
    const result = await importFromClaude({
      sourceRoot,
      sourcePath,
      destPath,
      importAidocs: !memoryOnly,
      force,
      dryRun,
    });

    return {
      text: [
        dryRun ? "**[Dry Run] 遷移預覽**" : "**記憶遷移完成**",
        `• 複製：${result.copied.length} 個 atom`,
        !memoryOnly ? `• AIDocs：${result.aidocsCopied.length} 個檔案` : null,
        !memoryOnly ? `• Prompt skill：${result.skillWritten ? "已建立" : "未建立"}` : null,
        `• 跳過：${result.skipped.length} 個（已存在）`,
        `• 合併索引：${result.mergedIndexEntries} 條`,
        result.errors.length > 0 ? `• ❌ 錯誤：${result.errors.length} 個` : null,
        `\n來源：\`${sourcePath}\`\n目標：\`${destPath}\``,
        !memoryOnly ? `Atomic Memory Docs：\`${join(resolveCatclawDir(), "aidocs", "claude-atomic-memory")}\`` : null,
        !force && !dryRun ? "\n提示：加 `--force` 覆寫已存在的 atom" : null,
        !memoryOnly ? "提示：新 prompt skill 已寫入 `~/.catclaw/skills/atomic-memory/`；若要立即穩定生效，建議重啟 bot/bridge。" : null,
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleRebuild(args: string): Promise<SkillResult> {
  const dryRun = args.includes("--dry-run");
  const customDir = args.trim().replace("--dry-run", "").trim();

  const memoryDir = customDir || join(getBootAgentDataDir(), "memory");

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

  const globalDir = engine.getStatus().globalDir;

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
    const ok = result.errors === 0 && result.skipped === 0;
    return {
      text: [
        "**記憶 Seed 完成**",
        `• 目錄：\`${globalDir}\``,
        `• Embedded：${result.seeded} 個`,
        result.skipped > 0 ? `• Skip（embedding 失敗）：${result.skipped} 個` : null,
        result.errors > 0 ? `• 錯誤：${result.errors} 個` : null,
        ok ? "✅ 完成" : result.skipped > 0 ? "⚠️ 有 skip — Ollama embedding 是否正常？執行 `/migrate search <query>` 確認" : "⚠️ 有錯誤，請查看 log",
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleVectorResync(args: string): Promise<SkillResult> {
  const dryRun = args.includes("--dry-run");
  // --rebuild：先 dropTable 再 seed（必要時機：換 embedding 模型/維度、清僵屍 atom）
  const rebuild = args.includes("--rebuild");
  const { getPlatformMemoryEngine } = await import("../../core/platform.js");
  const engine = getPlatformMemoryEngine();
  if (!engine) {
    return { text: "❌ MemoryEngine 未啟動（平台模式未啟用）", isError: true };
  }

  const { existsSync, readdirSync } = await import("node:fs");
  const status = engine.getStatus();
  const memRoot = join(getBootAgentDataDir(), "memory");

  // 收集所有層：global + projects/* + accounts/*
  const layers: Array<{ label: string; dir: string; namespace: string }> = [];
  layers.push({ label: "global", dir: status.globalDir, namespace: "global" });

  const projectsDir = join(memRoot, "projects");
  if (existsSync(projectsDir)) {
    for (const sub of readdirSync(projectsDir)) {
      const dir = join(projectsDir, sub);
      layers.push({ label: `project/${sub}`, dir, namespace: `project/${sub}` });
    }
  }
  const accountsDir = join(memRoot, "accounts");
  if (existsSync(accountsDir)) {
    for (const sub of readdirSync(accountsDir)) {
      const dir = join(accountsDir, sub);
      layers.push({ label: `account/${sub}`, dir, namespace: `account/${sub}` });
    }
  }

  if (dryRun) {
    const lines = [`**[Dry Run] vector-resync${rebuild ? " --rebuild" : ""} 預覽**`];
    if (rebuild) lines.push(`⚠️ rebuild 模式會 drop 所有 namespace table 後重建`);
    for (const l of layers) {
      if (!existsSync(l.dir)) continue;
      const count = readdirSync(l.dir).filter(f => f.endsWith(".md") && f !== "MEMORY.md").length;
      lines.push(`• ${l.label}：${count} 個 atom（ns=${l.namespace}）`);
    }
    return { text: lines.join("\n") };
  }

  const report: string[] = [`**向量全層${rebuild ? "重建" : "Resync"}完成**`];
  let totalSeeded = 0, totalSkipped = 0, totalErrors = 0, totalDropped = 0;

  for (const l of layers) {
    if (!existsSync(l.dir)) continue;
    try {
      if (rebuild) {
        const r = await engine.dropAndSeed(l.dir, l.namespace);
        if (r.dropped) totalDropped++;
        report.push(`• ${l.label}：${r.dropped ? "🗑 dropped → " : ""}✅ ${r.seeded} embedded, ${r.skipped} skipped, ${r.errors} errors`);
        totalSeeded += r.seeded; totalSkipped += r.skipped; totalErrors += r.errors;
      } else {
        const r = await engine.seedFromDir(l.dir, l.namespace);
        report.push(`• ${l.label}：✅ ${r.seeded} embedded, ${r.skipped} skipped, ${r.errors} errors`);
        totalSeeded += r.seeded; totalSkipped += r.skipped; totalErrors += r.errors;
      }
    } catch (err) {
      report.push(`• ${l.label}：❌ ${err instanceof Error ? err.message : String(err)}`);
      totalErrors++;
    }
  }

  const droppedNote = rebuild ? `${totalDropped} dropped, ` : "";
  report.push(`\n**合計**：${droppedNote}${totalSeeded} embedded, ${totalSkipped} skipped, ${totalErrors} errors`);
  if (totalErrors > 0 || totalSkipped > 0) {
    report.push("⚠️ 有 skip/error — 確認 Ollama embedding 是否正常");
  } else {
    report.push("✅ 全部完成");
  }
  if (!rebuild && totalSkipped > 0) {
    report.push("\n💡 若是換了 embedding 模型/維度（dim mismatch 會 skip），請改跑 `/migrate vector-resync --rebuild`");
  }

  return { text: report.join("\n") };
}

function handleStatus(): SkillResult {
  const claudeMemory = join(homedir(), ".claude", "memory");
  const catclawMemory = join(getBootAgentDataDir(), "memory");

  const countMd = (dir: string): number => {
    if (!existsSync(dir)) return 0;
    let n = 0;
    try {
      const scan = (d: string) => {
        for (const entry of readdirSync(d)) {
          if (entry.startsWith("_")) continue;
          const full = join(d, entry);
          try {
            const stat = statSync(full);
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
      `• \`${catclawMemory}/\` → ${dst} 個 atom${existsSync(catclawMemory) ? "" : "（路徑不存在）"}`,
      src > dst ? `\n提示：執行 \`/migrate import\` 遷移 ~${src - dst} 個尚未複製的 atom；預設也會匯入 Atomic Memory _AIDocs` : null,
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
      case "vector-resync": return handleVectorResync(rest);
      case "status":  return handleStatus();
      case "search":  return handleSearch(rest);
      case "stats":   return handleStats();
      default:
        return {
          text: [
            "**`/migrate` 子命令**",
            "• `import [--force] [--dry-run] [--memory-only]` — 從 `~/.claude/memory/` 匯入記憶；預設也匯入 `_AIDocs` 與 Atomic Memory prompt skill",
            "• `rebuild [<memoryDir>] [--dry-run]` — 重建 `MEMORY.md` 索引",
            "• `seed [--dry-run]` — 將記憶目錄 atom 嵌入至 LanceDB（global only）",
            "• `vector-resync [--dry-run] [--rebuild]` — 全層向量 resync；--rebuild 先 dropTable 再 seed（換模型/維度時用）",
            "• `status` — 查看遷移狀態",
            "• `search <query>` — 直查 LanceDB（不過 LLM，minScore=0 顯示原始 score）",
            "• `stats` — LanceDB table 清單 + 向量數",
          ].join("\n"),
        };
    }
  },
};
