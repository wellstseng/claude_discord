/**
 * @file skills/builtin/status.ts
 * @description /status, /memory skills
 *
 * /status  — 當前 session + 系統狀態快照
 * /memory  — 記憶系統查詢（list / search / status）
 */

import type { Skill } from "../types.js";
import { getPlatformSessionManager, getPlatformMemoryEngine, getPlatformToolRegistry } from "../../core/platform.js";
import { getProviderRegistry } from "../../providers/registry.js";
import { listSkills } from "../registry.js";

// ── /status ────────────────────────────────────────────────────────────────────

export const statusSkill: Skill = {
  name: "status",
  description: "顯示當前 session 與系統狀態（provider、turn、queue、記憶）",
  tier: "standard",
  trigger: ["/status"],

  async execute({ channelId, accountId, authorId }) {
    const sessionManager = getPlatformSessionManager();
    const session = sessionManager.list().find(s => s.channelId === channelId);

    const lines: string[] = ["📊 **CatClaw 狀態**\n"];

    // ── Session ──
    if (session) {
      const msgCount = session.messages.length;
      const queueDepth = sessionManager.getQueueDepth(session.sessionKey);
      const lastActive = new Date(session.lastActiveAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      lines.push(`**Session**`);
      lines.push(`  key: \`${session.sessionKey}\``);
      lines.push(`  turns: ${session.turnCount}  messages: ${msgCount}  queue: ${queueDepth}`);
      lines.push(`  provider: \`${session.providerId}\``);
      lines.push(`  最後活躍: ${lastActive}`);
    } else {
      lines.push("**Session**\n  此頻道尚無 session");
    }

    // ── Provider ──
    try {
      const provReg = getProviderRegistry();
      const providers = provReg.list();
      lines.push(`\n**Providers** (${providers.length})`);
      for (const p of providers) {
        const active = session?.providerId === p.id ? " ◀" : "";
        lines.push(`  \`${p.id}\`${active}`);
      }
    } catch { /* provider registry not ready */ }

    // ── Tools & Skills ──
    const toolRegistry = getPlatformToolRegistry();
    const toolCount = toolRegistry.all().length;
    const skillCount = listSkills().length;
    lines.push(`\n**工具**  tools: ${toolCount}  skills: ${skillCount}`);

    // ── Memory ──
    const memEngine = getPlatformMemoryEngine();
    if (memEngine) {
      const st = memEngine.getStatus();
      lines.push(`\n**記憶引擎**`);
      lines.push(`  initialized: ${st.initialized}  vector: ${st.vectorAvailable}`);
      lines.push(`  projects: ${st.projectCount}  accounts: ${st.accountCount}`);
    } else {
      lines.push("\n**記憶引擎**  未初始化");
    }

    return { text: lines.join("\n") };
  },
};

// ── /memory ────────────────────────────────────────────────────────────────────

export const memorySkill: Skill = {
  name: "memory",
  description: "記憶庫管理（/memory list / search <q> / status）",
  tier: "standard",
  trigger: ["/memory"],

  async execute({ args, accountId, authorId, channelId }) {
    const memEngine = getPlatformMemoryEngine();
    if (!memEngine) return { text: "❌ 記憶引擎尚未初始化", isError: true };

    const effectiveAccountId = accountId ?? `discord:${authorId}`;
    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase() ?? "status";

    switch (subCmd) {

      case "status": {
        const st = memEngine.getStatus();
        const lines = [
          "🧠 **記憶引擎狀態**",
          `  initialized: ${st.initialized}`,
          `  vector DB: ${st.vectorAvailable ? "✅ 在線" : "❌ 離線"}`,
          `  globalDir: \`${st.globalDir}\``,
          `  projects: ${st.projectCount}  accounts: ${st.accountCount}`,
        ];
        return { text: lines.join("\n") };
      }

      case "search": {
        const query = parts.slice(1).join(" ").trim();
        if (!query) return { text: "用法：`/memory search <關鍵字>`", isError: true };

        const result = await memEngine.recall(query, { accountId: effectiveAccountId });
        if (result.fragments.length === 0) {
          return { text: `🔍 「${query}」無匹配記憶` };
        }

        const lines = [`🔍 **記憶搜尋：${query}** (${result.fragments.length} 筆)\n`];
        for (const f of result.fragments.slice(0, 5)) {
          const preview = (f.atom.content ?? "").slice(0, 120).replace(/\n/g, " ");
          lines.push(`• \`${f.atom.name}\` [score=${f.score.toFixed(2)} via=${f.matchedBy}]`);
          lines.push(`  ${preview}`);
        }
        if (result.fragments.length > 5) lines.push(`  …還有 ${result.fragments.length - 5} 筆`);
        return { text: lines.join("\n") };
      }

      case "list": {
        const layer = parts[1] ?? "global";
        const { readdirSync, readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const { globalDir } = memEngine.getStatus();
        const dir = layer === "global"
          ? globalDir
          : layer === "account"
          ? join(globalDir, "..", "accounts", effectiveAccountId)
          : globalDir;

        if (!existsSync(dir)) {
          return { text: `⚠️ 目錄不存在：${dir}` };
        }

        let files: string[];
        try {
          files = readdirSync(dir).filter(f => f.endsWith(".md")).slice(0, 20);
        } catch {
          return { text: "❌ 無法讀取記憶目錄", isError: true };
        }

        if (files.length === 0) return { text: `📂 \`${layer}\` 層無記憶檔案` };

        const lines = [`📂 **${layer} 層記憶** (${files.length} 筆${files.length >= 20 ? "，已截斷" : ""})\n`];
        for (const f of files) {
          // 讀第一行內容當摘要
          try {
            const content = readFileSync(join(dir, f), "utf-8");
            const firstContent = content.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("*")) ?? "";
            const preview = firstContent.slice(0, 60);
            lines.push(`• \`${f.replace(".md", "")}\`${preview ? ` — ${preview}` : ""}`);
          } catch {
            lines.push(`• \`${f.replace(".md", "")}\``);
          }
        }
        return { text: lines.join("\n") };
      }

      default:
        return { text: "用法：\n• `/memory status` — 引擎狀態\n• `/memory search <關鍵字>` — 搜尋記憶\n• `/memory list [global|account]` — 列出記憶檔案" };
    }
  },
};

// ── exports ────────────────────────────────────────────────────────────────────

export const skill = statusSkill;
export const skills = [memorySkill];
