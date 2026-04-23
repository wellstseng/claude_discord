/**
 * @file skills/builtin/capabilities.ts
 * @description /capabilities — 列出 CatClaw 平台全部可用能力
 *
 * 子指令：
 *   /capabilities            — 總覽（各類別數量 + 簡表）
 *   /capabilities hooks      — 34 個 hook 事件詳表
 *   /capabilities tools      — 已註冊 tools 清單
 *   /capabilities skills     — trigger + prompt skills
 *   /capabilities modules    — prompt 模組清單
 *   /capabilities mcp        — MCP Servers 設定
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";

const HOOK_EVENTS: Record<string, string[]> = {
  "Lifecycle": ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"],
  "Turn/Message": [
    "UserMessageReceived", "UserPromptSubmit", "PreTurn", "PostTurn",
    "PreLlmCall", "PostLlmCall", "AgentResponseReady", "ToolTimeout",
  ],
  "Memory/Atom": [
    "PreAtomWrite", "PostAtomWrite", "PreAtomDelete", "PostAtomDelete",
    "AtomReplace", "MemoryRecall",
  ],
  "Subagent": ["PreSubagentSpawn", "PostSubagentComplete", "SubagentError"],
  "Context": ["PreCompaction", "PostCompaction", "ContextOverflow"],
  "CLI Bridge": ["CliBridgeSpawn", "CliBridgeSuspend", "CliBridgeTurn"],
  "File/Command": ["PreFileWrite", "PreFileEdit", "PreCommandExec"],
  "File Watcher": ["FileChanged", "FileDeleted"],
  "Error/Safety": ["SafetyViolation", "AgentError"],
  "Platform": ["ConfigReload", "ProviderSwitch"],
};

const TOTAL_HOOKS = Object.values(HOOK_EVENTS).reduce((s, a) => s + a.length, 0);

export const skill: Skill = {
  name: "capabilities",
  description: "列出 CatClaw 平台可用能力（hooks / tools / skills / modules / mcp）",
  tier: "public",
  trigger: ["/capabilities", "/caps"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const sub = ctx.args.trim().toLowerCase().split(/\s+/)[0] || "overview";

    switch (sub) {
      case "hooks":
        return showHooks();
      case "tools":
        return await showTools();
      case "skills":
        return await showSkills();
      case "modules":
        return showModules();
      case "mcp":
        return showMcp(ctx);
      case "overview":
      default:
        return await showOverview(ctx);
    }
  },
};

// ── Overview ─────────────────────────────────────────────────────────────────

async function showOverview(ctx: SkillContext): Promise<SkillResult> {
  const toolCount = await getToolCount();
  const { triggerCount, promptCount } = await getSkillCounts();
  const moduleCount = getModuleCount();
  const mcpCount = Object.keys(ctx.config.mcpServers ?? {}).length;

  const lines = [
    "⚙️ **CatClaw Platform Capabilities**\n",
    `| 類別 | 數量 | 查詢指令 |`,
    `|------|------|----------|`,
    `| Hook Events | ${TOTAL_HOOKS} | \`/caps hooks\` |`,
    `| Tools | ${toolCount} | \`/caps tools\` |`,
    `| Skills (trigger) | ${triggerCount} | \`/caps skills\` |`,
    `| Skills (prompt) | ${promptCount} | \`/caps skills\` |`,
    `| Prompt Modules | ${moduleCount} | \`/caps modules\` |`,
    `| MCP Servers | ${mcpCount} | \`/caps mcp\` |`,
    "",
    "Hook 掛載目錄：`~/.catclaw/workspace/hooks/`（全域）、`agents/{id}/hooks/`（agent）",
    "Hook 檔名格式：`{Event}.{name}.ts`",
  ];
  return { text: lines.join("\n") };
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function showHooks(): SkillResult {
  const lines = [`🪝 **Hook Events**（${TOTAL_HOOKS} 個）\n`];
  for (const [group, events] of Object.entries(HOOK_EVENTS)) {
    lines.push(`**${group}** (${events.length})`);
    lines.push("  " + events.map(e => `\`${e}\``).join(", "));
  }
  lines.push(
    "",
    "**掛載方式**",
    "• 檔案：`~/.catclaw/workspace/hooks/{Event}.{name}.ts`",
    "• SDK：`import { defineHook } from 'catclaw/hooks/sdk'`",
    "• Pre* 事件可 `block` / `modify`，Post* 事件為 observer（`passthrough`）",
  );
  return { text: lines.join("\n") };
}

// ── Tools ────────────────────────────────────────────────────────────────────

async function showTools(): Promise<SkillResult> {
  try {
    const { getToolRegistry } = await import("../../tools/registry.js");
    const reg = getToolRegistry();
    const all = reg.all();
    const grouped: Record<string, Array<{ name: string; tier: string; desc: string }>> = {};
    for (const t of all) {
      const prefix = t.name.startsWith("mcp_") ? "MCP" : "builtin";
      (grouped[prefix] ??= []).push({
        name: t.name,
        tier: t.tier,
        desc: (t as { description?: string }).description?.slice(0, 60) ?? "",
      });
    }

    const lines = [`🔧 **Tools**（${all.length} 個）\n`];
    for (const [group, tools] of Object.entries(grouped)) {
      lines.push(`**${group}** (${tools.length})`);
      for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`  • \`${t.name}\` [${t.tier}] ${t.desc}`);
      }
    }
    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `❌ 無法取得 Tools：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Skills ───────────────────────────────────────────────────────────────────

async function showSkills(): Promise<SkillResult> {
  try {
    const { listSkills, buildSkillsPrompt } = await import("../registry.js");
    const trigger = listSkills();
    const lines = [`📋 **Skills**\n`];

    lines.push(`**Trigger Skills** (${trigger.length})`);
    for (const s of trigger) {
      lines.push(`  • ${s.trigger.join(" | ")} — ${s.description} [${s.tier}]`);
    }

    // Prompt skills
    const prompt = buildSkillsPrompt();
    const nameRe = /<name>(.+?)<\/name>/g;
    const descRe = /<description>(.+?)<\/description>/g;
    const names: string[] = [];
    const descs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(prompt)) !== null) names.push(m[1]);
    while ((m = descRe.exec(prompt)) !== null) descs.push(m[1]);

    if (names.length > 0) {
      lines.push(`\n**Prompt Skills** (${names.length})`);
      for (let i = 0; i < names.length; i++) {
        lines.push(`  • \`/${names[i]}\` — ${descs[i] || "(無說明)"}`);
      }
    }

    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `❌ 無法取得 Skills：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Prompt Modules ───────────────────────────────────────────────────────────

function showModules(): SkillResult {
  try {
    const { listPromptModules } = require("../../core/prompt-assembler.js") as {
      listPromptModules: () => Array<{ name: string; priority: number }>;
    };
    const mods = listPromptModules();
    const lines = [`📦 **Prompt Modules**（${mods.length} 個）\n`];
    lines.push("| 優先序 | 模組 |");
    lines.push("|--------|------|");
    for (const m of mods) {
      lines.push(`| ${m.priority} | \`${m.name}\` |`);
    }
    lines.push("", "低優先序先組裝。自訂模組用 `registerPromptModule()` 註冊。");
    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `❌ 無法取得 Modules：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── MCP Servers ──────────────────────────────────────────────────────────────

function showMcp(ctx: SkillContext): SkillResult {
  const servers = ctx.config.mcpServers ?? {};
  const keys = Object.keys(servers);
  if (keys.length === 0) {
    return { text: "🔌 **MCP Servers**\n\n（無已設定的 MCP Server）\n\n在 Dashboard → MCP Servers 新增，或編輯 `catclaw.json` 的 `mcpServers`。" };
  }

  const lines = [`🔌 **MCP Servers**（${keys.length} 個）\n`];
  for (const key of keys.sort()) {
    const s = servers[key] as { command?: string; args?: string[]; env?: Record<string, string> };
    const cmd = s.command ?? "?";
    const argStr = s.args?.slice(0, 3).join(" ") ?? "";
    lines.push(`• **${key}** — \`${cmd} ${argStr}\``);
  }
  return { text: lines.join("\n") };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getToolCount(): Promise<number> {
  try {
    const { getToolRegistry } = await import("../../tools/registry.js");
    return getToolRegistry().all().length;
  } catch { return 0; }
}

async function getSkillCounts(): Promise<{ triggerCount: number; promptCount: number }> {
  try {
    const { listSkills, buildSkillsPrompt } = await import("../registry.js");
    const triggerCount = listSkills().length;
    const prompt = buildSkillsPrompt();
    const promptCount = (prompt.match(/<name>/g) ?? []).length;
    return { triggerCount, promptCount };
  } catch { return { triggerCount: 0, promptCount: 0 }; }
}

function getModuleCount(): number {
  try {
    const { listPromptModules } = require("../../core/prompt-assembler.js") as {
      listPromptModules: () => unknown[];
    };
    return listPromptModules().length;
  } catch { return 0; }
}
