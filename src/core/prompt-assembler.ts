/**
 * @file core/prompt-assembler.ts
 * @description System Prompt 模組化組裝器
 *
 * 將 system prompt 拆成可組合的模組（identity / tools-usage / coding-rules /
 * git-rules / output-format / memory-rules），按 mode + 角色動態組裝。
 *
 * 使用方式：
 *   const prompt = assembleSystemPrompt({ role, mode, projectId, ... });
 *   // 結果為完整 system prompt 字串，可直接傳給 agent-loop
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import type { Role } from "../accounts/registry.js";
import type { ModePreset } from "./config.js";
import { config } from "./config.js";

// ── Prompt Module 介面 ──────────────────────────────────────────────────────

export interface PromptModule {
  /** 模組識別名（用於 log 和 debug） */
  name: string;
  /** 優先序（越小越前面，預設 50） */
  priority: number;
  /** 內容產生函式（回傳空字串 = 不注入此模組） */
  build: (ctx: PromptContext) => string;
}

export interface PromptContext {
  /** 使用者角色 */
  role: Role;
  /** 模式 preset */
  mode: ModePreset;
  /** 模式名稱（normal / precision） */
  modeName: string;
  /** 專案 ID（可選） */
  projectId?: string;
  /** 是否為群組頻道 */
  isGroupChannel?: boolean;
  /** 說話者顯示名稱 */
  speakerDisplay?: string;
  /** CatClaw accountId */
  accountId?: string;
  /** 說話者角色字串（群組場景） */
  speakerRole?: string;
  /** 工作目錄 */
  workspaceDir?: string;
  /** 當前 session 已啟用的 MCP server 名稱 */
  activeMcpServers?: string[];
}

// ── 內建模組 ─────────────────────────────────────────────────────────────────

const identityModule: PromptModule = {
  name: "identity",
  priority: 10,
  build: (ctx) => {
    const parts: string[] = [];
    parts.push("你是 CatClaw，一個 Codex 版 Claude Code CLI + 多人 AI 開發平台。");
    parts.push("透過 Discord 為前端介面，提供等同 Claude Code 的完整開發能力。");
    if (ctx.isGroupChannel && ctx.speakerDisplay) {
      parts.push(`\n[多人頻道] 當前說話者：${ctx.speakerDisplay}（${ctx.accountId ?? "unknown"}/${ctx.speakerRole ?? "member"}）`);
    }
    return parts.join("\n");
  },
};

const toolsUsageModule: PromptModule = {
  name: "tools-usage",
  priority: 20,
  build: () => {
    return [
      "## 工具使用規則",
      "- 讀檔用 read_file，不用 cat/head/tail/sed",
      "- 改檔用 edit_file 精確修改，不用 sed/awk",
      "- 建檔用 write_file，不用 echo redirection",
      "- 搜檔用 glob / grep，不用 find",
      "- 修改檔案前必須先 read_file（Read-before-Write 規則，程式碼層面強制）",
      "- 能用專用工具就不用 run_command",
      "- run_command 用於需要 shell 執行的系統指令",
    ].join("\n");
  },
};

const codingRulesModule: PromptModule = {
  name: "coding-rules",
  priority: 30,
  build: (ctx) => {
    // 精密模式從 workspace/prompts/coding-discipline.md 載入
    if (ctx.modeName === "precision" && ctx.workspaceDir) {
      const p = join(ctx.workspaceDir, "prompts", "coding-discipline.md");
      if (existsSync(p)) {
        try { return readFileSync(p, "utf-8"); } catch { /* fall through */ }
      }
    }
    // 一般模式：基本行為約束
    return [
      "## 行為約束",
      "- 程式碼修改保持最小範圍，不主動重構周圍程式碼",
      "- 不加不需要的 docstring、type annotation、無意義註解",
      "- 不為假想的未來需求設計",
      "- 先理解現有程式碼再修改",
    ].join("\n");
  },
};

const gitRulesModule: PromptModule = {
  name: "git-rules",
  priority: 40,
  build: () => {
    return [
      "## Git 安全協定",
      "- 優先建新 commit，不 amend（除非使用者明確要求）",
      "- 禁止 force push 到 main/master",
      "- 禁止 --no-verify",
      "- Destructive operations（reset --hard, checkout ., clean -f）→ 先確認",
      "- git add 指定檔案名，避免 -A 意外提交敏感檔案",
    ].join("\n");
  },
};

const outputFormatModule: PromptModule = {
  name: "output-format",
  priority: 50,
  build: () => {
    return [
      "## 輸出規則",
      "- 直球、精準、無廢話：跳過客套，直接給結論",
      "- 一句話能說的不用三句",
      "- 不在回應結尾總結剛才做的事",
      "- 回應語言：繁體中文（技術術語可英文）",
    ].join("\n");
  },
};

const discordReplyModule: PromptModule = {
  name: "discord-reply",
  priority: 55,
  build: (ctx) => {
    const hasDiscordMcp = ctx.activeMcpServers?.some(s => s.toLowerCase().includes("discord"));
    if (!hasDiscordMcp) return "";
    return [
      "## Discord 回覆規則",
      "當前 session 已啟用 Discord MCP。所有回覆必須透過 Discord MCP 的 reply 工具發送回 Discord 頻道。",
      "不要只在本地輸出文字——使用者在 Discord 端等待你的回覆。",
    ].join("\n");
  },
};

const memoryRulesModule: PromptModule = {
  name: "memory-rules",
  priority: 60,
  build: () => {
    return [
      "## 記憶系統",
      "- 使用 memory_recall 工具搜尋相關記憶（向量+關鍵字混合搜尋）",
      "- 已記錄事實直接引用，不重新分析原始碼",
      "- 已載入但不相關的記憶：靜默忽略",
    ].join("\n");
  },
};

// ── Module Registry ──────────────────────────────────────────────────────────

const builtinModules: PromptModule[] = [
  identityModule,
  toolsUsageModule,
  codingRulesModule,
  gitRulesModule,
  outputFormatModule,
  discordReplyModule,
  memoryRulesModule,
];

const customModules: PromptModule[] = [];

/** 註冊自訂 prompt 模組（供外部擴充） */
export function registerPromptModule(mod: PromptModule): void {
  customModules.push(mod);
}

// ── 組裝器 ───────────────────────────────────────────────────────────────────

export interface AssembleOpts extends PromptContext {
  /** 額外的 system prompt 片段（CATCLAW.md 內容、記憶 context 等） */
  extraBlocks?: string[];
  /** 覆寫使用的模組（null = 使用全部） */
  moduleFilter?: string[];
}

/**
 * 組裝完整 system prompt。
 * 按 priority 排序，依序呼叫每個模組的 build()，串接為一個字串。
 */
export function assembleSystemPrompt(opts: AssembleOpts): string {
  const disabledModules = config.promptAssembler?.disabledModules ?? [];
  const allModules = [...builtinModules, ...customModules]
    .filter(m => !disabledModules.includes(m.name))
    .sort((a, b) => a.priority - b.priority);

  const activeModules = opts.moduleFilter
    ? allModules.filter(m => opts.moduleFilter!.includes(m.name))
    : allModules;

  const parts: string[] = [];

  // 額外區塊（CATCLAW.md 等）優先注入
  if (opts.extraBlocks?.length) {
    parts.push(...opts.extraBlocks.filter(Boolean));
  }

  for (const mod of activeModules) {
    try {
      const content = mod.build(opts);
      if (content) {
        parts.push(content);
      }
    } catch (err) {
      log.warn(`[prompt-assembler] 模組 ${mod.name} 組裝失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.debug(`[prompt-assembler] 組裝完成：${activeModules.length} 個模組, ${parts.length} 個區段`);
  return parts.join("\n\n");
}

/** 列出所有已註冊的 prompt 模組（供 debug/dashboard 使用） */
export function listPromptModules(): Array<{ name: string; priority: number }> {
  return [...builtinModules, ...customModules]
    .sort((a, b) => a.priority - b.priority)
    .map(m => ({ name: m.name, priority: m.priority }));
}
