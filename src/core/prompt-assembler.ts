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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import type { Role } from "../accounts/registry.js";
import type { ModePreset } from "./config.js";
import { config, resolveWorkspaceDir } from "./config.js";

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
  /** 對話場景標籤（比照 OpenClaw ConversationLabel）
   *  例："Guild名 #頻道名 channel id:頻道ID" */
  conversationLabel?: string;
}

// ── Context-aware Intent Detection ──────────────────────────────────────────

export type PromptIntent = "coding" | "research" | "conversation";

const CODING_KEYWORDS = /\b(git|commit|push|pull|merge|branch|rebase|diff|code|bug|fix|refactor|test|build|compile|deploy|npm|tsc|lint|pr|issue|file|function|class|module|import|error|exception|stack|debug|log)\b/i;
const RESEARCH_KEYWORDS = /\b(search|find|look up|investigate|research|explain|what is|how does|why|compare|analyze|review|check|inspect|describe|list|show|status)\b/i;

export function detectIntent(userMessage: string): PromptIntent {
  const codingScore = (userMessage.match(CODING_KEYWORDS) || []).length;
  const researchScore = (userMessage.match(RESEARCH_KEYWORDS) || []).length;

  if (codingScore >= 2) return "coding";
  if (researchScore >= 2 && codingScore === 0) return "research";
  if (codingScore >= 1) return "coding";
  return "conversation";
}

/** 根據 intent 決定要啟用哪些模組 */
export function getModulesForIntent(intent: PromptIntent): string[] | undefined {
  switch (intent) {
    case "coding":
      // 全部模組
      return undefined;
    case "research":
      // 省略 coding-rules、git-rules
      return ["date-time", "identity", "catclaw-md", "tools-usage", "output-format", "discord-reply", "memory-rules"];
    case "conversation":
      // 最小 prompt
      return ["date-time", "identity", "catclaw-md", "output-format", "discord-reply", "memory-rules"];
  }
}

// ── 內建模組 ─────────────────────────────────────────────────────────────────

const dateTimeModule: PromptModule = {
  name: "date-time",
  priority: 5,
  build: () => {
    const nowStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    return `[系統資訊] 當前時間（Asia/Taipei）：${nowStr}`;
  },
};

const identityModule: PromptModule = {
  name: "identity",
  priority: 10,
  build: (ctx) => {
    const parts: string[] = [];
    parts.push("你是 CatClaw，一個 Codex 版 Claude Code CLI + 多人 AI 開發平台。");
    parts.push("透過 Discord 為前端介面，提供等同 Claude Code 的完整開發能力。");
    if (ctx.conversationLabel) {
      parts.push(`\n[Conversation] ${ctx.conversationLabel}`);
    }
    if (ctx.isGroupChannel && ctx.speakerDisplay) {
      parts.push(`[多人頻道] 當前說話者：${ctx.speakerDisplay}（${ctx.accountId ?? "unknown"}/${ctx.speakerRole ?? "member"}）`);
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

/** 工具摘要（由 platform.ts 初始化後注入） */
let _toolSummaryText = "";

/** 供 platform.ts 呼叫：注入工具摘要 */
export function setToolSummary(tools: Array<{ name: string; description: string }>): void {
  if (tools.length === 0) { _toolSummaryText = ""; return; }
  const lines = tools.map(t => `- ${t.name}：${t.description.split("\n")[0]}`);
  _toolSummaryText = [
    "## 可用工具摘要",
    "以下是當前 session 已註冊的所有工具（含 MCP 工具）：",
    ...lines,
  ].join("\n");
}

const toolSummaryModule: PromptModule = {
  name: "tool-summary",
  priority: 56,
  build: () => _toolSummaryText,
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

/**
 * CATCLAW.md 層級繼承（對標 Claude Code 的 3 層 CLAUDE.md 機制）
 *
 * 從 workspaceDir 開始往上搜尋 CATCLAW.md，直到根目錄。
 * 越接近 workspace 的優先序越高（後載入覆寫先載入）。
 * 返回合併的內容字串。
 */
function loadCatclawMdHierarchy(workspaceDir: string): string {
  const parts: string[] = [];
  let dir = workspaceDir;
  const seen = new Set<string>();

  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const candidate = join(dir, "CATCLAW.md");
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf-8").trim();
        if (content) {
          parts.push(`<!-- CATCLAW.md: ${candidate} -->\n${content}`);
        }
      } catch { /* ignore read errors */ }
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  if (parts.length === 0) return "";
  // Reverse: root-level first, project-level last (project overrides root)
  parts.reverse();
  return parts.join("\n\n");
}

const claudeMdModule: PromptModule = {
  name: "catclaw-md",
  priority: 15, // after identity (10), before tools-usage (20)
  build: (ctx) => {
    const wsDir = ctx.workspaceDir ?? (() => { try { return resolveWorkspaceDir(); } catch { return ""; } })();
    if (!wsDir) return "";
    const content = loadCatclawMdHierarchy(wsDir);
    if (content) return `## Project Instructions (CATCLAW.md)\n\n${content}`;
    // Auto-create default CATCLAW.md (mirrors loadBaseSystemPrompt behavior)
    const defaultContent = `# CATCLAW.md — CatClaw Bot 行為規則\n\n你是 CatClaw，一個專案知識代理人。\n\n## 工作目錄\n\n你的工作目錄是 \`${wsDir}\`。`;
    const p = join(wsDir, "CATCLAW.md");
    try { writeFileSync(p, defaultContent, "utf-8"); log.info(`[prompt-assembler] 已產生預設 CATCLAW.md：${p}`); } catch { /* ignore */ }
    return `## Project Instructions (CATCLAW.md)\n\n${defaultContent}`;
  },
};

// ── Failure Recall Module ────────────────────────────────────────────────────

/**
 * 快取的 failure summary（由 refreshFailureRecallCache() 非同步更新）。
 * prompt module 同步讀取此快取。
 */
let _failureRecallCache = "";

/** 重新載入 failure recall 快取。應在 session 開始時呼叫。 */
export async function refreshFailureRecallCache(): Promise<void> {
  try {
    const { getRecentFailureSummary } = await import("../workflow/failure-detector.js");
    _failureRecallCache = await getRecentFailureSummary();
    if (_failureRecallCache) {
      log.info(`[prompt-assembler] failure recall 載入 ${_failureRecallCache.split("\n").length - 1} 條陷阱`);
    }
  } catch (err) {
    log.debug(`[prompt-assembler] failure recall 載入失敗：${err instanceof Error ? err.message : String(err)}`);
    _failureRecallCache = "";
  }
}

const failureRecallModule: PromptModule = {
  name: "failure-recall",
  priority: 55, // after coding-rules (40), before memory-rules (60)
  build: () => _failureRecallCache,
};

// ── Module Registry ──────────────────────────────────────────────────────────

const builtinModules: PromptModule[] = [
  dateTimeModule,
  identityModule,
  claudeMdModule,
  toolsUsageModule,
  codingRulesModule,
  gitRulesModule,
  outputFormatModule,
  discordReplyModule,
  toolSummaryModule,
  memoryRulesModule,
  failureRecallModule,
];

const customModules: PromptModule[] = [];

/** 註冊自訂 prompt 模組（供外部擴充） */
export function registerPromptModule(mod: PromptModule): void {
  customModules.push(mod);
}

// ── 組裝器 ───────────────────────────────────────────────────────────────────

/** 組裝段落（name + 原始文字，用於計算 offset） */
export interface AssembleSegment {
  name: string;
  content: string;
}

/** assembleSystemPrompt 的 trace 輸出 */
export interface AssembleTraceOutput {
  modulesActive: string[];
  modulesSkipped: string[];
  /** 按組裝順序的各段落 name + content */
  segments: AssembleSegment[];
}

export interface AssembleOpts extends PromptContext {
  /** 額外的 system prompt 片段（CATCLAW.md 內容、記憶 context 等） */
  extraBlocks?: string[];
  /** extraBlocks 的對應名稱（用於 trace segment 標記），與 extraBlocks 同序 */
  extraBlockNames?: string[];
  /** 覆寫使用的模組（null = 使用全部） */
  moduleFilter?: string[];
  /** 傳入此物件時，組裝完成後寫入模組追蹤資訊 */
  traceOutput?: AssembleTraceOutput;
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

  const skippedModules = opts.moduleFilter
    ? allModules.filter(m => !opts.moduleFilter!.includes(m.name))
    : [];

  const parts: string[] = [];
  const segments: AssembleSegment[] = [];

  // 額外區塊（記憶 / channel override / mode extras）優先注入
  if (opts.extraBlocks?.length) {
    const extraNames = opts.extraBlockNames ?? [];
    for (let i = 0; i < opts.extraBlocks.length; i++) {
      const blk = opts.extraBlocks[i];
      if (!blk) continue;
      parts.push(blk);
      segments.push({ name: extraNames[i] ?? `extra-${i}`, content: blk });
    }
  }

  for (const mod of activeModules) {
    try {
      const content = mod.build(opts);
      if (content) {
        parts.push(content);
        segments.push({ name: mod.name, content });
      }
    } catch (err) {
      log.warn(`[prompt-assembler] 模組 ${mod.name} 組裝失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 寫入 trace 輸出
  if (opts.traceOutput) {
    opts.traceOutput.modulesActive = activeModules.map(m => m.name);
    opts.traceOutput.modulesSkipped = skippedModules.map(m => m.name);
    opts.traceOutput.segments = segments;
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
