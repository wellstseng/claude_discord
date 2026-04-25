/**
 * @file core/agent-loop.ts
 * @description Agent Loop — 核心對話迴圈
 *
 * 設計：一軌制，CatClaw 控制所有 tool，LLM 只負責思考。
 * 流程：
 *   1. 身份 + 權限檢查
 *   2. 記憶 Recall（可選）
 *   3. Context 組裝
 *   4. Tool list 物理過濾
 *   5. LLM 呼叫 → 處理 tool_use → 迴圈至 end_turn
 *   6. 萃取 + 事件通知
 *
 * 參考架構文件第 6 節（Agent Loop + Tool 執行引擎）。
 */

import { existsSync } from "node:fs";
import { log } from "../logger.js";
import { makeToolResultMessage } from "../providers/base.js";
import type { LLMProvider, Message, ProviderEvent, ImageBlock, ContentBlock } from "../providers/base.js";
import type { SessionManager } from "./session.js";
import type { PermissionGate } from "../accounts/permission-gate.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SafetyGuard } from "../safety/guard.js";
import { eventBus as _eventBusInstance } from "./event-bus.js";
type EventBus = typeof _eventBusInstance;
import type { ToolContext } from "../tools/types.js";
import { getContextEngine, repairToolPairing, estimateTokens } from "./context-engine.js";
import { getToolLogStore, ToolLogStore } from "./tool-log-store.js";
import { getSessionSnapshotStore } from "./session-snapshot.js";
import { registerTurnAbort, clearTurnAbort } from "../skills/builtin/stop.js";
import type { MemoryEngine } from "../memory/engine.js";
import { createApproval, sendApprovalDm, isCommandAllowed } from "./exec-approval.js";
import { getSessionNote, checkAndSaveNote } from "../memory/session-memory.js";
import { config } from "./config.js";
import type { MessageTrace } from "./message-trace.js";
import { getTraceStore } from "./message-trace.js";
import { isPlanMode, PLAN_MODE_BLOCKED_TOOLS } from "../skills/builtin/plan.js";

// ── Tool trace helpers ──────────────────────────────────────────────────────

/** 從 tool params 提取人類可讀摘要 */
function toolParamsPreview(name: string, params: unknown): string {
  const p = params as Record<string, unknown> | null;
  if (!p) return "";
  switch (name) {
    case "run_command": return String(p.command ?? "").slice(0, 80);
    case "read_file": return String(p.path ?? p.filePath ?? "");
    case "write_file": return String(p.path ?? p.filePath ?? "");
    case "edit_file": return String(p.path ?? p.filePath ?? "");
    case "search_files": return `${p.pattern ?? ""} in ${p.path ?? "."}`;
    case "discord_reply": return String(p.text ?? "").slice(0, 60);
    case "discord_react": return `${p.emoji ?? ""} on ${p.message_id ?? ""}`;
    case "spawn_subagent": return String(p.task ?? "").slice(0, 60);
    case "memory_recall": return String(p.query ?? "").slice(0, 60);
    case "atom_write": return String(p.name ?? p.atomName ?? "");
    case "atom_delete": return String(p.name ?? "");
    case "fetch_messages": return `ch:${String(p.chat_id ?? p.channelId ?? "").slice(-6)}`;
    default: {
      // 通用：取第一個 string 值
      for (const v of Object.values(p)) {
        if (typeof v === "string" && v.length > 0) return v.slice(0, 60);
      }
      return "";
    }
  }
}

/** 安全序列化 tool result 為預覽字串 */
function toolResultPreview(result: unknown, error?: string): string {
  if (error) return error;
  if (result == null) return "";
  if (typeof result === "string") return result.slice(0, 100);
  try { return JSON.stringify(result).slice(0, 100); } catch { return String(result).slice(0, 100); }
}

// ── 常數 ─────────────────────────────────────────────────────────────────────

// 自適應 loop cap：
//   - BASE 是基礎預算（正常對話綽綽有餘）
//   - 接近 cap 時，若近 5 輪「全成功、tool_search 沒超過 2 次」→ 延長一階（+STEP）
//   - CEILING 是絕對天花板（擋失控成本）
// 理由：Playwright MCP 之類一連串 30-50 工具呼叫的任務，固定 20 做不完；
//       但無條件放寬會讓 buggy loop 吃掉成本。進展健康才准擴展是折衷。
const BASE_LOOPS = 50;
const LOOP_EXTEND_STEP = 10;
const LOOP_CAP_CEILING = 80;
const MAX_CONTINUATIONS = 3;  // Output Token Recovery：max_tokens 截斷時最多自動續接次數
const MAX_DEFERRED_NUDGES = 3;  // Deferred tool 活化後空回應 → 注入續接提示的最大次數
const ACTIVATE_PER_ITER_LIMIT = 3;  // 每輪最多活化幾個 deferred tool（防 Anthropic 批次活化空回應 quirk）
const DEFAULT_RESULT_TOKEN_CAP = 0;   // 0 = 不截斷（讓上游/per-tool 自行控制）

// ── Tool result 智慧截斷 ──────────────────────────────────────────────────────

/** 依 tool 類型套用不同截斷策略 */
function truncateToolResult(text: string, tokenCap: number, toolName?: string): string {
  if (tokenCap === 0) return text;                       // 0 = 無限制
  const charCap = tokenCap * 4;
  if (text.length <= charCap) return text;

  const lines = text.split("\n");
  const totalLines = lines.length;

  // ── 策略分派 ──
  const strategy = toolName ? TRUNCATION_STRATEGIES[toolName] : undefined;
  if (strategy) {
    return strategy(text, lines, totalLines, charCap);
  }

  // ── 預設策略：head + tail ──
  return defaultTruncation(lines, totalLines, text.length, charCap);
}

function defaultTruncation(lines: string[], totalLines: number, totalChars: number, charCap: number): string {
  const headLines = Math.min(50, Math.floor(totalLines * 0.7));
  const tailLines = Math.min(20, totalLines - headLines);
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const notice = `\n[⚠️ CatClaw 已截斷：原始 ${totalLines} 行 / ${totalChars} 字元 → 僅顯示前 ${headLines} + 末 ${tailLines} 行。如需完整內容請縮小參數範圍後重新呼叫]\n`;
  return head + notice + tail;
}

/** read_file：保留頭部（含行號）+ 尾部，中間截斷並標示行號範圍 */
function truncateReadFile(text: string, lines: string[], totalLines: number, charCap: number): string {
  const headCount = Math.min(80, Math.floor(charCap / 4 / 60 * 0.7));  // 估算：每行約 60 chars
  const tailCount = Math.min(30, Math.floor(charCap / 4 / 60 * 0.3));
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(-tailCount).join("\n");
  const skipped = totalLines - headCount - tailCount;
  const skipStart = headCount + 1;
  const skipEnd = totalLines - tailCount;
  const notice = `\n[⚠️ CatClaw 已截斷：省略中間 ${skipped} 行（第 ${skipStart}~${skipEnd} 行）。如需讀取被省略區段請用 read_file 的 offset=${skipStart} / limit 參數]\n`;
  return head + notice + tail;
}

/** grep / glob / web_search：限制匹配數量，保留前 N 筆 */
function truncateSearchResult(_text: string, lines: string[], totalLines: number, charCap: number): string {
  const maxLines = Math.floor(charCap / 60);  // 每行約 60 chars
  const kept = lines.slice(0, maxLines).join("\n");
  const omitted = totalLines - maxLines;
  if (omitted > 0) {
    return kept + `\n[⚠️ CatClaw 已截斷：還有 ${omitted} 筆結果未顯示（共 ${totalLines} 筆）。grep/glob 請用 offset/head_limit(或 limit) 分頁，或用更精確的 pattern/glob 縮小範圍；web_search 請精簡 query]`;
  }
  return kept;
}

/** run_command：保留 stderr + exit code + 尾部 stdout */
function truncateRunCommand(text: string, lines: string[], totalLines: number, charCap: number): string {
  // 嘗試找到 stderr 區段（通常是 error 或 warning 行）
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  let hasStderr = false;

  for (const line of lines) {
    // 常見 stderr 模式：Error, Warning, error:, WARN, ERR, fatal
    if (/^(error|warning|fatal|ERR|WARN|Error:|TypeError|SyntaxError)/i.test(line.trim())) {
      hasStderr = true;
    }
    if (hasStderr && stderrLines.length < 30) {
      stderrLines.push(line);
    } else {
      stdoutLines.push(line);
    }
  }

  const tailCount = Math.min(40, Math.floor(charCap / 4 / 60));
  const tail = stdoutLines.slice(-tailCount).join("\n");

  if (stderrLines.length > 0) {
    const stderrBlock = stderrLines.join("\n");
    const notice = `[⚠️ CatClaw 已截斷：原始 ${totalLines} 行 / ${text.length} 字元 → 僅保留 stderr/error 區段 + 最後 ${tailCount} 行 stdout。如需完整 stdout 請用 grep / head / tail 後再執行，或輸出到檔案後用 read_file 分頁讀取]`;
    return `${notice}\n\n--- stderr ---\n${stderrBlock}\n\n--- stdout (tail) ---\n${tail}`;
  }

  // 無明顯 stderr：僅保留尾部
  const notice = `[⚠️ CatClaw 已截斷：原始 ${totalLines} 行 / ${text.length} 字元 → 僅保留最後 ${tailCount} 行。如需完整輸出請將結果寫到檔案後用 read_file 分頁讀取]`;
  return `${notice}\n${tail}`;
}

/** tool-specific 截斷策略表 */
const TRUNCATION_STRATEGIES: Record<string, (text: string, lines: string[], totalLines: number, charCap: number) => string> = {
  read_file: truncateReadFile,
  grep: truncateSearchResult,
  glob: truncateSearchResult,
  web_search: truncateSearchResult,
  run_command: truncateRunCommand,
};

/**
 * 計算工具結果的有效 token cap。
 * 優先序：per-tool override > per-turn remaining budget > global default
 */
function resolveResultTokenCap(
  perToolCap: number | undefined,
  turnTokensUsed: number,
  modeOverride?: number,
): number {
  if (perToolCap !== undefined) return perToolCap;
  // 模式覆寫 > global config > 預設
  const tb = config.contextEngineering?.toolBudget;
  const globalDefault = modeOverride ?? tb?.resultTokenCap ?? DEFAULT_RESULT_TOKEN_CAP;
  const perTurnCap = tb?.perTurnTotalCap ?? 0;
  if (perTurnCap === 0) return globalDefault;
  const remaining = perTurnCap - turnTokensUsed;
  if (remaining <= 0) return 50; // budget 耗盡，幾乎截空
  return Math.min(globalDefault, remaining);
}

// ── LLM 呼叫重試 + backoff ────────────────────────────────────────────────────

async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseMs: number; maxMs: number; signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts) throw err;
      if (opts.signal?.aborted) throw err;

      const msg = err instanceof Error ? err.message : String(err);

      // 判斷是否可重試
      const statusMatch = msg.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (status >= 400 && status < 500 && status !== 429) throw err; // 4xx 非 rate limit → 不重試

      // 429 → 讀 Retry-After（單位：秒）
      let delay: number;
      if (status === 429) {
        const retryAfterMatch = msg.match(/retry-after[:\s]+(\d+)/i);
        delay = retryAfterMatch ? parseInt(retryAfterMatch[1]) * 1000 : opts.baseMs;
      } else {
        const jitter = Math.random() * opts.baseMs * 0.1;
        delay = Math.min(opts.baseMs * Math.pow(2, attempt - 1) + jitter, opts.maxMs);
      }

      log.warn(`[agent-loop] retry attempt=${attempt}/${opts.maxAttempts} status=${status || "network"} wait=${Math.round(delay)}ms`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        opts.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    }
  }
  throw new Error("unreachable");
}

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AgentLoopOpts {
  /** 平台識別碼（用於 session key 前綴，預設 "discord"） */
  platform?: string;
  /** 平台頻道 ID（用於 session key） */
  channelId: string;
  /** CatClaw accountId */
  accountId: string;
  /** 是否為群組頻道（影響 system prompt 多人聲明） */
  isGroupChannel?: boolean;
  /** 說話者角色（群組場景） */
  speakerRole?: string;
  /** 說話者顯示名稱 */
  speakerDisplay?: string;
  /** 已選定的 LLM Provider */
  provider: LLMProvider;
  /** System prompt（記憶 + context 已組裝） */
  systemPrompt?: string;
  /** AbortSignal（turn timeout / /cancel） */
  signal?: AbortSignal;
  /** Turn timeout 毫秒（預設無限） */
  turnTimeoutMs?: number;
  /** 是否顯示 tool calls（summary / all / none） */
  showToolCalls?: "all" | "summary" | "none";
  /** 當前專案 ID */
  projectId?: string;
  /**
   * 是否允許呼叫 spawn_subagent（預設 true）。
   * 子 agent 傳入 false — 邏輯面過濾，tool list 不含此工具。
   */
  allowSpawn?: boolean;
  /**
   * Spawn 深度（0 = 頂層 parent）。
   * ≥ 2 時 allowSpawn 強制 false（最多 3 層：parent → child → grandchild）。
   */
  spawnDepth?: number;
  /** LLM 呼叫失敗重試次數（預設 3） */
  retryMaxAttempts?: number;
  /** 重試 backoff 基礎毫秒（預設 1000） */
  retryBaseMs?: number;
  /** 重試 backoff 最大毫秒（預設 30000） */
  retryMaxMs?: number;
  /** 子 agent 工作目錄（spawn 時繼承父設定） */
  workspaceDir?: string;
  /**
   * 覆寫 session key（子 agent 用，繞過 platform:ch:channelId 格式）。
   * 正常流程不使用此欄位。
   */
  _sessionKeyOverride?: string;
  /**
   * 父 subagent runId（由 spawn-subagent 注入）。
   * 注入到 ToolContext.parentRunId，讓子 agent 呼叫 spawn_subagent 時能建立 parentId 關聯。
   */
  parentRunId?: string;
  /** Agent ID（spawn_subagent 帶 agent 身份時注入，傳遞到 ToolContext + recall） */
  agentId?: string;
  /** Agent admin flag（admin agent 不受路徑限制） */
  isAdmin?: boolean;
  /**
   * 圖片附件（來自 Discord 訊息）。
   * 直接作為 image content blocks 加入第一條 user 訊息，讓 LLM 可直接「看」圖。
   */
  imageAttachments?: Array<{ data: string; mimeType: string; name: string }>;
  /** Message Lifecycle Trace 收集器（由呼叫端建立並傳入） */
  trace?: MessageTrace;
  /**
   * Inbound History context（頻道脈絡）。
   * 注入為 messages 層的 user context（非 system prompt），CE 可壓縮。
   */
  inboundContext?: string;
  /**
   * Extended thinking 等級（Anthropic）。
   * 傳入後 LLM 會輸出 thinking_delta 事件。
   */
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** 當前模式 preset（由 /mode 或 config 決定，影響 CE、tool budget、prompt extras） */
  modePreset?: import("./config.js").ModePreset;
  /**
   * 執行指令前 DM 確認設定。
   * 啟用時，run_command 執行前會送 DM 給指定使用者等待確認。
   * 回呼由呼叫端提供（需整合 discord client）。
   */
  execApproval?: {
    enabled: boolean;
    /** 送出純文字 DM 的非同步函式（fallback，sendApprovalDm 優先） */
    sendDm: (dmUserId: string, content: string) => Promise<void>;
    dmUserId: string;
    timeoutMs?: number;
    /**
     * 指令白名單 pattern（substring match）。
     * 指令包含任一 pattern → 自動允許，跳過 DM 確認。
     * 例：["/tmp/", "echo ", "cat "]
     */
    allowedPatterns?: string[];
  };

  /**
   * Session Memory 選項（對話筆記）。
   * 注入：每次 turn 開始前讀取並前置到 system prompt。
   * 萃取：每 intervalTurns 輪 fire-and-forget 萃取一次。
   */
  sessionMemory?: {
    enabled: boolean;
    intervalTurns: number;
    maxHistoryTurns: number;
    memoryDir: string;
  };

  /**
   * 記憶 Recall 選項。
   * 啟用時於 LLM 呼叫前注入向量搜尋結果到 system prompt。
   * 呼叫端不需自行組裝記憶 context 即可注入。
   *
   * ⚠️ 若呼叫端已自行組裝 memory context 至 systemPrompt（如 discord.ts），
   * 請勿同時啟用此選項，否則同一批 atoms 會被注入兩次。
   * 此選項設計用於無前置 recall 的情境（子 agent、cron）。
   */
  memoryRecall?: {
    enabled: boolean;
    /** true = hybrid（vector + trigger），false = 僅 trigger */
    vectorSearch: boolean;
    topK?: number;
  };

  /**
   * Prompt 組裝分類提示（由 discord.ts 傳入）。
   * agent-loop 在 recordContextSnapshot 時合併自身區塊產出完整 breakdown。
   */
  promptBreakdownHints?: {
    memoryContext?: string;
    channelOverride?: string;
    modeExtras?: string;
    assemblerModules?: string[];
    assemblerSegments?: Array<{ name: string; content: string }>;
  };
}

/** AgentLoop yield 出的事件 */
export type AgentLoopEvent =
  | { type: "text_delta";   text: string }
  | { type: "thinking";     thinking: string }
  | { type: "tool_start";   name: string; id: string; params: unknown }
  | { type: "tool_result";  name: string; id: string; result: unknown; error?: string }
  | { type: "tool_blocked"; name: string; reason: string }
  | { type: "done";         text: string; turnCount: number }
  | { type: "context_warning"; level: "high" | "critical"; utilization: number; estimatedTokens: number; contextWindow: number; source: "session" | "model" }
  | { type: "ce_applied";   strategies: string[]; tokensBefore: number; tokensAfter: number }
  | { type: "error";        message: string };

// ── TurnTracker ───────────────────────────────────────────────────────────────

interface ToolCallRecord {
  name: string;
  params: unknown;
  result: unknown;
  error?: string;
  durationMs: number;
}

class TurnTracker {
  toolCalls: ToolCallRecord[] = [];
  editCounts = new Map<string, number>();
  private textParts: string[] = [];

  appendText(text: string): void { this.textParts.push(text); }

  getFullResponse(): string { return this.textParts.join(""); }

  recordToolCall(name: string, params: unknown, result: unknown, error: string | undefined, durationMs: number): void {
    this.toolCalls.push({ name, params, result, error, durationMs });
    if (name === "edit_file" || name === "write_file") {
      const path = (params as Record<string, unknown>)["path"] as string | undefined;
      if (path) this.editCounts.set(path, (this.editCounts.get(path) ?? 0) + 1);
    }
  }

  getRutSignals(): string[] {
    const signals: string[] = [];
    for (const [path, count] of this.editCounts) {
      if (count >= 3) signals.push(`same_file_3x:${path}`);
    }
    return signals;
  }

  classifyIntent(): string {
    const names = this.toolCalls.map(c => c.name);
    if (names.some(n => ["write_file", "edit_file"].includes(n))) return "build";
    if (names.some(n => ["run_command"].includes(n))) return "debug";
    if (names.some(n => ["memory_recall"].includes(n))) return "recall";
    if (names.some(n => ["read_file", "glob", "grep"].includes(n))) return "design";
    return "general";
  }
}

// ── Reversibility Assessment ──────────────────────────────────────────────────

/**
 * 評估 tool 操作的可逆性分數（0-3）
 * 0 = 完全可逆（read-only）
 * 1 = 低風險（本地寫入，可 undo）
 * 2 = 中風險（影響共享狀態，難以還原）
 * 3 = 高風險（破壞性操作，不可逆）
 */
function assessReversibility(toolName: string, params: Record<string, unknown>): { score: number; warning?: string } {
  if (["read_file", "glob", "grep", "web_search", "web_fetch", "memory_recall", "tool_search", "task_manage"].includes(toolName)) {
    return { score: 0 };
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    return { score: 1 };
  }

  if (toolName === "run_command") {
    const cmd = String(params["command"] ?? "").trim();

    // 高風險（score 3）：不可逆的破壞性操作
    const destructive3 = [
      /\brm\s+-rf?\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+push\s+--force\b/,
      /\bgit\s+push\s+-f\b/, /\bgit\s+clean\s+-f/, /\bdrop\s+(table|database)\b/i,
      /\btruncate\s+table\b/i, /\bgit\s+branch\s+-D\b/,
    ];
    for (const pattern of destructive3) {
      if (pattern.test(cmd)) {
        return { score: 3, warning: `高風險操作：${cmd.slice(0, 80)}。這是不可逆的破壞性操作，請確認是否真的需要執行。` };
      }
    }

    // 中風險（score 2）：影響共享狀態
    const shared2 = [
      /\bgit\s+push\b/, /\bgit\s+merge\b/, /\bgit\s+rebase\b/,
      /\bgit\s+checkout\s+\./, /\bgit\s+restore\s+\./,
      /\bkill\b/, /\bpkill\b/, /\bnpm\s+publish\b/,
    ];
    for (const pattern of shared2) {
      if (pattern.test(cmd)) {
        return { score: 2, warning: `此操作影響共享狀態：${cmd.slice(0, 80)}。請確認後再執行。` };
      }
    }

    // 其他 run_command 預設 score 1
    return { score: 1 };
  }

  if (toolName === "spawn_subagent") {
    return { score: 1 };
  }

  // 未知 tool 預設 score 1
  return { score: 1 };
}

// ── before_tool_call hook 鏈 ──────────────────────────────────────────────────

/** 取 tool 呼叫的 args 特徵（用於迴圈偵測的「相似度」比較） */
function argsSignature(name: string, params: Record<string, unknown>): string {
  if (name === "run_command" && typeof params["command"] === "string") {
    return String(params["command"]).trim().slice(0, 30);
  }
  const p = String(params["path"] ?? params["file_path"] ?? "");
  if (p) return p;
  return JSON.stringify(params).slice(0, 60);
}

/** 判斷 tool 執行結果是否失敗（用於迴圈偵測的「失敗」計數） */
function isFailingResult(result: unknown, error: string | undefined): boolean {
  if (error) return true;
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return true;
  if (r.error) return true;
  if (r.isError === true) return true;
  return false;
}

/**
 * 近 5 輪進展是否健康 — 用於自適應 loop cap 延長判斷。
 *
 * 健康條件（全部要符合）：
 *   1. 近 5 個 tool 呼叫沒有 error
 *   2. 近 5 個中 tool_search 不超過 2 個（tool_search 多 = 模型在瞎查 schema，不是實作進展）
 *
 * 不夠 5 個 tool 時視為「資料不足，不擴展」（保守），避免初始幾輪誤判。
 */
function isHealthyProgress(recentCalls: ToolCallRecord[]): boolean {
  const last5 = recentCalls.slice(-5);
  if (last5.length < 5) return false;
  if (last5.some(c => isFailingResult(c.result, c.error))) return false;
  const toolSearchCount = last5.filter(c => c.name === "tool_search").length;
  if (toolSearchCount >= 3) return false;
  return true;
}

type BeforeToolResult =
  | { blocked: true; needsApproval?: boolean; reason: string }
  | { blocked: false; params: Record<string, unknown>; warning?: string };

async function runBeforeToolCall(
  call: { id: string; name: string; params: Record<string, unknown> },
  ctx: { accountId: string; role?: string; agentId?: string; isAdmin?: boolean; recentCalls: ToolCallRecord[]; readFiles?: Set<string>; sessionKey?: string; channelId?: string; toolTier?: string },
  permissionGate: PermissionGate,
  safetyGuard: SafetyGuard,
): Promise<BeforeToolResult> {
  // 1. Permission Gate
  const perm = permissionGate.check(ctx.accountId, call.name);
  if (!perm.allowed) return { blocked: true, reason: perm.reason ?? "權限不足" };

  // 2. Safety Guard（含 per-role/per-account 工具權限規則 + agent 路徑白名單）
  const guard = safetyGuard.check(call.name, call.params, {
    accountId: ctx.accountId,
    role: ctx.role,
    agentId: ctx.agentId,
    isAdmin: ctx.isAdmin,
  });
  if (guard.blocked) {
    // SafetyViolation hook（observer，fire-and-forget）
    try {
      const { getHookRegistry } = await import("../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("SafetyViolation", ctx.agentId) > 0) {
        void hookReg.runSafetyViolation({
          event: "SafetyViolation",
          rule: `tool:${call.name}`,
          detail: guard.reason ?? "safety guard blocked",
          agentId: ctx.agentId,
          accountId: ctx.accountId,
        });
      }
    } catch { /* ignore */ }
    return { blocked: true, needsApproval: guard.needsApproval, reason: guard.reason ?? "安全規則阻擋" };
  }

  // 3. Read-before-Write enforcement
  // write_file / edit_file 的目標路徑必須先被 read_file 讀過（新建檔案除外）
  if (ctx.readFiles && (call.name === "write_file" || call.name === "edit_file")) {
    const targetPath = String(call.params["path"] ?? call.params["file_path"] ?? "");
    if (targetPath && !ctx.readFiles.has(targetPath)) {
      // 檢查檔案是否存在：存在但未讀 → 阻擋；不存在 → 允許新建
      try {
        if (existsSync(targetPath)) {
          return { blocked: true, reason: `請先用 read_file 讀取 ${targetPath} 再進行修改（Read-before-Write 規則）` };
        }
      } catch {
        // 無法判斷 → 放行（寧可通過也不誤擋）
      }
    }
  }

  // 4. Tool Loop Detection — 兩層防護
  // 4a. 精確迴圈：同 tool + 同參數連續 ≥3 次 → 立即攔截
  const last5 = ctx.recentCalls.slice(-5);
  const recentSame = last5.filter(c => c.name === call.name);
  if (recentSame.length >= 3) {
    const callSig = JSON.stringify(call.params);
    const identicalCount = recentSame.filter(c => JSON.stringify(c.params) === callSig).length;
    if (identicalCount >= 3) {
      return { blocked: true, reason: `偵測到工具迴圈：${call.name} 以相同參數連續呼叫 ${identicalCount} 次` };
    }
  }
  // 4b. 寬鬆防線：同 tool 最近 10 次中 ≥8 次、其中 ≥5 次「失敗且 args 與當前相似」→ 疑似無效重試
  // 只看 tool name count 會把探索性呼叫（不同指令）誤擋，必須同時檢查 args 相似度 + result 失敗
  const last10 = ctx.recentCalls.slice(-10);
  const sameName10 = last10.filter(c => c.name === call.name);
  if (last10.length >= 10 && sameName10.length >= 8) {
    const curSig = argsSignature(call.name, call.params);
    const failingSimilar = sameName10.filter(c =>
      isFailingResult(c.result, c.error) &&
      argsSignature(c.name, c.params as Record<string, unknown>) === curSig
    ).length;
    if (failingSimilar >= 5) {
      return { blocked: true, reason: `${call.name} 在最近 10 次中有 ${failingSimilar} 次失敗且 args 相似，疑似無效重試` };
    }
  }

  // 4b. Alternating Tool Cycle Detection（period-2：A→B→A→B→A…）
  if (ctx.recentCalls.length >= 4) {
    const r4 = ctx.recentCalls.slice(-4).map(c => c.name);
    if (r4[0] === r4[2] && r4[1] === r4[3] && r4[0] !== r4[1] && call.name === r4[0]) {
      return { blocked: true, reason: `偵測到交替工具迴圈：${r4[1]}↔${r4[0]}（已重複 2 輪）` };
    }
  }

  // 5. Reversibility Assessment
  const reversibility = assessReversibility(call.name, call.params);
  const reversibilityThreshold = config.safety?.reversibility?.threshold ?? 2;
  const reversibilityWarning = reversibility.score >= reversibilityThreshold ? reversibility.warning : undefined;

  // 6. External Hooks（PreToolUse）
  const { getHookRegistry } = await import("../hooks/hook-registry.js");
  const hookRegistry = getHookRegistry();
  if (hookRegistry && hookRegistry.count("PreToolUse") > 0) {
    const hookResult = await hookRegistry.runPreToolUse({
      event: "PreToolUse",
      toolName: call.name,
      toolParams: call.params,
      accountId: ctx.accountId,
      sessionKey: ctx.sessionKey ?? "",
      channelId: ctx.channelId ?? "",
      toolTier: ctx.toolTier ?? "standard",
    });
    if (hookResult.blocked) return { blocked: true, reason: hookResult.reason };
    return { blocked: false, params: hookResult.params, warning: reversibilityWarning };
  }

  return { blocked: false, params: call.params, warning: reversibilityWarning };
}

// ── PostToolUse Hook Helper ──────────────────────────────────────────────────

async function runPostToolUseHook(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolResult: { result?: unknown; error?: string },
  durationMs: number,
  ctx: { accountId: string; sessionKey: string; channelId: string },
): Promise<{ result?: unknown; error?: string }> {
  const { getHookRegistry } = await import("../hooks/hook-registry.js");
  const hookRegistry = getHookRegistry();
  if (!hookRegistry || hookRegistry.count("PostToolUse") === 0) return toolResult;
  return hookRegistry.runPostToolUse({
    event: "PostToolUse",
    toolName,
    toolParams,
    toolResult,
    durationMs,
    accountId: ctx.accountId,
    sessionKey: ctx.sessionKey,
    channelId: ctx.channelId,
  });
}

// ── Agent Loop（主函式）────────────────────────────────────────────────────────

/**
 * agentLoop：核心對話迴圈，yield AgentLoopEvent
 *
 * 呼叫端負責：
 * - 取得 provider、sessionManager 等依賴
 * - 消費 events（串流回覆 + 追蹤）
 */
export async function* agentLoop(
  prompt: string,
  opts: AgentLoopOpts,
  deps: {
    sessionManager: SessionManager;
    permissionGate: PermissionGate;
    toolRegistry: ToolRegistry;
    safetyGuard: SafetyGuard;
    eventBus: EventBus;
    /** 可選記憶引擎，配合 opts.memoryRecall 使用 */
    memoryEngine?: MemoryEngine;
  },
): AsyncGenerator<AgentLoopEvent> {
  const { sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus } = deps;
  const { channelId, accountId, provider, projectId } = opts;
  const platform = opts.platform ?? "discord";
  const spawnDepth = opts.spawnDepth ?? 0;
  const trace = opts.trace;
  // Post-compact recovery：追蹤最近編輯的檔案（最多 5 個），壓縮後重新注入
  const recentlyEditedFiles: string[] = [];
  // Read-before-Write：追蹤本 turn 已讀取的檔案路徑
  const readFiles = new Set<string>();
  // allowSpawn: depth ≥ 2 強制 false（最多 3 層）；opts.allowSpawn 明確 false 也關閉
  const allowSpawn = opts.allowSpawn !== false && spawnDepth < 2;

  // ── 1. 進門權限檢查 ────────────────────────────────────────────────────────
  const accessResult = permissionGate.checkAccess(accountId);
  if (!accessResult.allowed) {
    yield { type: "error", message: `存取拒絕：${accessResult.reason}` };
    return;
  }

  // ── 2. Session + messages ──────────────────────────────────────────────────
  const sessionKey = opts._sessionKeyOverride ?? `${platform}:ch:${channelId}`;

  // Turn Queue：序列化同一 session 的並發 turn，防止歷史交錯
  try {
    await sessionManager.enqueueTurn({ sessionKey, accountId, prompt, signal: opts.signal });
  } catch (err) {
    yield { type: "error", message: `session 佇列：${err instanceof Error ? err.message : String(err)}` };
    return;
  }

  // ── 以下受 Turn Queue 保護（讀 session → 執行 → 寫回 → dequeueTurn）──────
  try {

  const session = sessionManager.getOrCreate(sessionKey, accountId, channelId, opts.provider.id);

  // SessionStart hook（首次建立 session 時觸發）
  if (session.turnCount === 0) {
    const { getHookRegistry } = await import("../hooks/hook-registry.js");
    const hookReg = getHookRegistry();
    if (hookReg && hookReg.count("SessionStart", opts.agentId) > 0) {
      await hookReg.runSessionStart({ event: "SessionStart", sessionKey, accountId, channelId, agentId: opts.agentId });
    }
  }

  // UserPromptSubmit hook（可 block / 改寫 prompt）
  {
    const { getHookRegistry } = await import("../hooks/hook-registry.js");
    const hookReg = getHookRegistry();
    if (hookReg && hookReg.count("UserPromptSubmit", opts.agentId) > 0) {
      const r = await hookReg.runUserPromptSubmit({
        event: "UserPromptSubmit", prompt, sessionKey, accountId, channelId, agentId: opts.agentId,
      });
      if (r.blocked) {
        yield { type: "error", message: `UserPromptSubmit hook 阻擋：${r.reason ?? "(無理由)"}` };
        return;
      }
      if (r.prompt !== prompt) {
        log.debug(`[agent-loop] UserPromptSubmit hook 改寫 prompt`);
        prompt = r.prompt;
      }
    }
  }

  // Session Snapshot（turn 開始前快照）
  const snapshotStore = getSessionSnapshotStore();
  if (snapshotStore) {
    snapshotStore.save(sessionKey, session.turnCount, session.messages);
  }

  // ContextEngine：套用 CE strategies（compaction / overflow-hard-stop）
  const rawHistory = sessionManager.getHistory(sessionKey);
  const contextEngine = getContextEngine();
  let processedHistory: Message[];
  if (contextEngine) {
    processedHistory = await contextEngine.build(rawHistory, {
      sessionKey,
      turnIndex: session.turnCount,
      agentId: opts.agentId,
      accountId: opts.accountId,
    });
    // S2: 有 strategy 觸發 → 把壓縮後的 messages 寫回 session（含備份原始）
    const ceBd = contextEngine.lastBuildBreakdown;
    if (ceBd.strategiesApplied.length > 0) {
      sessionManager.replaceMessages(sessionKey, processedHistory);
      yield {
        type: "ce_applied",
        strategies: ceBd.strategiesApplied,
        tokensBefore: ceBd.tokensBeforeCE ?? ceBd.estimatedTokens,
        tokensAfter: ceBd.tokensAfterCE ?? ceBd.estimatedTokens,
      };
      eventBus.emit("context:compressed", sessionKey);
    }
  } else {
    processedHistory = rawHistory;
  }

  // Trace: Context Engineering + Session History 記錄
  if (trace) {
    // History token 估算（補回 discord.ts 無法取得的 history 資訊）
    const historyTokens = processedHistory.reduce((sum, m) => {
      if (m.tokens) return sum + m.tokens;
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(content.length / 4);
    }, 0);
    trace.recordContextEnd({
      systemPromptTokens: Math.ceil((opts.systemPrompt?.length ?? 0) / 4),
      historyTokens,
      historyMessageCount: processedHistory.length,
      totalContextTokens: Math.ceil((opts.systemPrompt?.length ?? 0) / 4) + historyTokens,
    });

    if (contextEngine) {
      const bd = contextEngine.lastBuildBreakdown;
      trace.recordCE({
        strategiesApplied: bd.strategiesApplied,
        tokensBeforeCE: bd.tokensBeforeCE ?? bd.estimatedTokens,
        tokensAfterCE: bd.tokensAfterCE ?? bd.estimatedTokens,
        strategyDetails: bd.strategyDetails,
        originalMessageDigest: bd.originalMessageDigest,
        overflowSignaled: bd.overflowSignaled,
      });
    }
  }

  // Context overflow 三段 failover 第三段：CE 偵測到超硬上限 → 終止
  if (contextEngine?.lastBuildBreakdown.overflowSignaled) {
    yield { type: "error", message: "context_overflow: Context 已達上限，建議輸入 /rollback 或開新對話" };
    return;
  }

  // 若有圖片附件，建立混合 content blocks（文字 + 圖片）
  const firstUserContent: string | ContentBlock[] = (() => {
    if (!opts.imageAttachments?.length) return prompt;
    const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
    for (const img of opts.imageAttachments) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType } satisfies ImageBlock);
    }
    return blocks;
  })();

  // Inbound History：注入為 context messages（在 user prompt 前），CE 可壓縮
  const inboundMessages: Message[] = opts.inboundContext
    ? [
        { role: "user", content: opts.inboundContext },
        { role: "assistant", content: "好的，我已了解頻道近期脈絡。" },
      ]
    : [];

  let messages: Message[] = [
    ...processedHistory,
    ...inboundMessages,
    { role: "user", content: firstUserContent },
  ];

  // ── 3. Tool list（物理過濾 + deferred 分離）────────────────────────────────
  const allToolDefs = permissionGate.listAvailable(accountId);
  // allowSpawn:false → 邏輯面過濾，子 agent 看不到 spawn_subagent
  const filteredDefs = !allowSpawn
    ? allToolDefs.filter(d => d.name !== "spawn_subagent")
    : allToolDefs;

  // Plan Mode：過濾寫入/執行類工具
  const planActive = isPlanMode(opts.channelId);
  const planFiltered = planActive
    ? filteredDefs.filter(d => !PLAN_MODE_BLOCKED_TOOLS.has(d.name))
    : filteredDefs;

  // Deferred Tool Loading：eager = 完整 schema 注入 tools 參數；deferred = 僅名稱+描述注入 system prompt
  let eagerDefs = planFiltered.filter(d => !d.deferred);
  const deferredDefs = filteredDefs.filter(d => d.deferred);
  // 追蹤已載入的 deferred tools（tool_search 後加入）
  const loadedDeferredNames = new Set<string>();
  let toolDefs = eagerDefs;

  // ── 3b. Memory Recall（可選，供子 agent 等無前置 recall 的情境使用）──────────
  let memoryContextBlock = "";
  if (opts.memoryRecall?.enabled && deps.memoryEngine) {
    const recallStartMs = Date.now();
    try {
      const recallResult = await deps.memoryEngine.recall(
        prompt,
        { accountId, projectId },
        { vectorSearch: opts.memoryRecall.vectorSearch, vectorTopK: opts.memoryRecall.topK ?? 5 },
      );
      if (recallResult.fragments.length > 0) {
        const ctx = deps.memoryEngine.buildContext(recallResult.fragments, prompt, recallResult.blindSpot);
        memoryContextBlock = ctx.text;
        log.debug(`[agent-loop] memory recall 注入 ${recallResult.fragments.length} fragments (vectorSearch=${opts.memoryRecall.vectorSearch})`);
        trace?.recordMemoryRecall({
          durationMs: Date.now() - recallStartMs,
          fragmentCount: recallResult.fragments.length,
          atomNames: recallResult.fragments.map(f => f.atom.name),
          injectedTokens: ctx.tokenCount,
          vectorSearch: !recallResult.degraded,
          degraded: recallResult.degraded,
          blindSpot: recallResult.blindSpot,
          hits: recallResult.fragments.map(f => ({
            name: f.atom.name,
            layer: f.layer,
            score: Math.round(f.score * 1000) / 1000,
            matchedBy: f.matchedBy,
          })),
        });
      }
    } catch (err) {
      log.debug(`[agent-loop] memory recall 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. System prompt + 群組多人聲明 ────────────────────────────────────────
  let systemPrompt = opts.systemPrompt ?? "";
  // memory context 前置到 system prompt
  if (memoryContextBlock) {
    systemPrompt = memoryContextBlock + (systemPrompt ? `\n\n${systemPrompt}` : "");
  }
  if (opts.isGroupChannel && opts.speakerDisplay) {
    const isolation = `[多人頻道] 當前說話者：${opts.speakerDisplay}（${accountId}/${opts.speakerRole ?? "member"}）`;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${isolation}` : isolation;
  }
  // Plan Mode：注入行為約束到 system prompt
  if (planActive) {
    const planNotice = [
      "## 🗺️ Plan Mode 已啟用",
      "你目前處於規劃模式。在此模式下：",
      "- 只進行分析、規劃、閱讀程式碼",
      "- 不執行任何修改操作（write_file, edit_file, run_command 等已被移除）",
      "- 可使用 read_file, glob, grep, web_search 等唯讀工具",
      "- 提供詳細的實作計畫、步驟、風險評估",
    ].join("\n");
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${planNotice}` : planNotice;
  }

  // ── 4a. Deferred Tool Listing（改為每 iter 動態重組）──
  // 避免：若 listing 在 turn 外靜態組裝，deferred tool 活化後仍在 listing 中，
  // Claude 同時看到「X 在 deferred 清單」+「X 已在 tools array」的矛盾 state → 空回應 end_turn
  const buildDeferredBlock = (): string => {
    const pending = deferredDefs.filter(d => !loadedDeferredNames.has(d.name));
    if (pending.length === 0) return "";
    const listing = pending.map(d => `- ${d.name}: ${d.description.split("\n")[0]}`).join("\n");
    return [
      "The following deferred tools are available via tool_search:",
      listing,
      "Usage rule: Call tool_search to load a deferred tool's schema only when you intend to USE it next.",
      "**In the same turn**, after tool_search returns, you MUST either (a) call the actual tool you looked up, or (b) ask the user for missing info / explain why you can't proceed.",
      "Do NOT end your turn immediately after tool_search just because you loaded the schema — that leaves the user waiting with nothing done.",
    ].join("\n");
  };
  if (deferredDefs.length > 0) {
    log.debug(`[agent-loop] deferred tools: ${deferredDefs.map(d => d.name).join(", ")}`);
  }

  // ── 4b. Token Budget Nudge（參考 Claude Code tokenBudget.ts）────────────────
  // 當 context 使用率超過 60%，主動提示 LLM 簡潔回應；超過 70% 加強提示
  if (contextEngine) {
    const estimatedTokens = contextEngine.lastBuildBreakdown.estimatedTokens;
    const windowTokens = contextEngine.getContextWindowTokens();
    const ratio = windowTokens > 0 ? estimatedTokens / windowTokens : 0;
    let nudge = "";
    if (ratio >= 0.70) {
      nudge = `【Context 已用 ${Math.round(ratio * 100)}%，接近上限】請儘量簡短回應，避免冗長說明。`;
    } else if (ratio >= 0.60) {
      nudge = `【Context 使用 ${Math.round(ratio * 100)}%】請保持回應簡潔。`;
    }
    if (nudge) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${nudge}` : nudge;
      log.debug(`[agent-loop] token-budget-nudge ratio=${ratio.toFixed(2)} appended`);
    }
  }

  // ── 4b-2. 外部化索引注入（AI 查閱被壓訊息的目錄）────────────────────────────
  {
    const { buildExternalizedIndex } = await import("./context-engine.js");
    const extIndex = buildExternalizedIndex(processedHistory);
    if (extIndex) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${extIndex}` : extIndex;
      log.debug(`[agent-loop] externalized-index 已注入`);
    }
  }

  // Trace: agent-loop 追加的 system prompt 區塊
  const _agentLoopBlocks: string[] = [];
  if (memoryContextBlock) _agentLoopBlocks.push("memory-context");
  if (opts.isGroupChannel) _agentLoopBlocks.push("group-isolation");
  if (planActive) _agentLoopBlocks.push("plan-mode");
  if (deferredDefs.length > 0) _agentLoopBlocks.push("deferred-tools");
  if (contextEngine) {
    const ratio = contextEngine.getContextWindowTokens() > 0
      ? contextEngine.lastBuildBreakdown.estimatedTokens / contextEngine.getContextWindowTokens()
      : 0;
    if (ratio >= 0.60) _agentLoopBlocks.push("token-nudge");
  }
  if (systemPrompt.includes("[外部化索引]")) _agentLoopBlocks.push("externalized-index");
  if (trace) trace.appendAgentLoopBlocks(_agentLoopBlocks);

  // ── 4c. Session Note 注入（參考 Claude Code SessionMemory）───────────────────
  if (opts.sessionMemory?.enabled) {
    const note = getSessionNote(opts.sessionMemory.memoryDir, channelId);
    if (note) {
      systemPrompt = note + (systemPrompt ? `\n\n${systemPrompt}` : "");
      _agentLoopBlocks.push("session-note");
      log.debug(`[agent-loop] session-note 已注入 channelId=${channelId.slice(-8)}`);
    }
  }

  // ── 4d. AutoCompact：主動預留 output 空間 ─────────────────────────────────
  // 在 system prompt 完整組裝後，檢查總 context 是否超出預留空間
  if (contextEngine) {
    const reserve = opts.modePreset?.contextReserve ?? 0.2;
    const windowTokens = contextEngine.getContextWindowTokens();
    const sysTokens = Math.ceil((systemPrompt?.length ?? 0) / 4);
    const msgTokens = contextEngine.estimateTokens(messages);
    const totalTokens = sysTokens + msgTokens;
    const maxInputTokens = windowTokens * (1 - reserve);

    if (totalTokens > maxInputTokens) {
      log.info(`[agent-loop:autoCompact] tokens=${totalTokens} > maxInput=${Math.round(maxInputTokens)} (reserve=${reserve * 100}%), 觸發額外壓縮`);
      const trimTarget = Math.round(maxInputTokens - sysTokens);
      while (contextEngine.estimateTokens(messages) > trimTarget && messages.length > 3) {
        messages = messages.slice(1);
      }
      messages = repairToolPairing(messages);
      log.info(`[agent-loop:autoCompact] 壓縮後 messages=${messages.length} tokens≈${contextEngine.estimateTokens(messages)}`);

      // Post-compact recovery：注入最近編輯檔案的內容摘要
      if (recentlyEditedFiles.length > 0) {
        const { existsSync, readFileSync } = await import("node:fs");
        const recoveryParts: string[] = [];
        for (const filePath of recentlyEditedFiles) {
          if (!existsSync(filePath)) continue;
          try {
            const content = readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            const preview = lines.length > 50
              ? lines.slice(0, 30).join("\n") + `\n... (共 ${lines.length} 行，已截斷)`
              : content;
            recoveryParts.push(`=== ${filePath} ===\n${preview}`);
          } catch { /* 讀取失敗跳過 */ }
        }
        if (recoveryParts.length > 0) {
          messages.push({
            role: "user",
            content: `[壓縮後恢復] 以下是你最近編輯的檔案，供你參考：\n\n${recoveryParts.join("\n\n")}`,
          });
          log.info(`[agent-loop:postCompact] 恢復了 ${recoveryParts.length} 個最近編輯檔案`);
        }
      }
    }
  }

  // ── 4e. Trace: Context Snapshot（完整 system prompt + messages）────────────
  if (trace) {
    const ceApplied = (contextEngine?.lastBuildBreakdown?.strategiesApplied?.length ?? 0) > 0;
    const hints = opts.promptBreakdownHints;

    // 計算 segments offset（從 assembler segments + agent-loop blocks 的 content 定位）
    const segments: Array<{ name: string; offset: number; length: number }> = [];
    if (hints?.assemblerSegments || _agentLoopBlocks.length > 0) {
      let cursor = 0;
      // agent-loop prepend: session-note（在最前面）
      // agent-loop prepend: memory-context（在 assembler 之前）
      // 然後是 assembler segments
      // 最後是 agent-loop appends: group-isolation, plan-mode, deferred-tools, token-nudge

      // 用 indexOf 搜尋每段在 systemPrompt 中的位置
      const allSegments: Array<{ name: string; content: string }> = [];
      // assembler segments（含 extraBlocks + modules）
      if (hints?.assemblerSegments) {
        allSegments.push(...hints.assemblerSegments);
      }
      for (const seg of allSegments) {
        const idx = systemPrompt.indexOf(seg.content, cursor);
        if (idx >= 0) {
          segments.push({ name: seg.name, offset: idx, length: seg.content.length });
          cursor = idx + seg.content.length;
        }
      }
    }

    trace.recordContextSnapshot({
      systemPrompt,
      memoryContext: memoryContextBlock || hints?.memoryContext || undefined,
      promptBreakdown: {
        memoryContext: (memoryContextBlock || hints?.memoryContext) ? (memoryContextBlock || hints?.memoryContext) : undefined,
        channelOverride: hints?.channelOverride,
        modeExtras: hints?.modeExtras,
        assemblerModules: hints?.assemblerModules ?? [],
        agentLoopBlocks: _agentLoopBlocks,
        segments: segments.length > 0 ? segments : undefined,
      },
      messagesBeforeCE: ceApplied ? rawHistory as unknown[] : undefined,
      messagesAfterCE: messages as unknown[],
      ceApplied,
    });
  }

  // ── 5. Turn abort signal ───────────────────────────────────────────────────
  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort());
  }
  registerTurnAbort(sessionKey, controller);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (opts.turnTimeoutMs) {
    timeoutHandle = setTimeout(() => controller.abort(), opts.turnTimeoutMs);
  }

  const tracker = new TurnTracker();
  let loopCount = 0;
  let loopCap = BASE_LOOPS;  // 自適應：進展健康時會被延長（見迴圈尾巴的 cap extend 邏輯）
  let continuationCount = 0;  // Output Token Recovery 續接計數
  // Deferred Tool Nudge：tool_search 後 LLM 空回應 end_turn 時自動注入續接提示
  let deferredJustActivated: string[] = [];   // 本 iteration 剛活化的 deferred tool 名稱
  let prevIterDeferredActivated: string[] = []; // 上一 iteration 活化的（供本 iter 判斷用）
  let deferredNudgeCount = 0;                 // Deferred tool 活化後的空回應續接次數
  let deferredNudgeExhausted = false;         // nudge 用完還在空轉 → 給使用者通知
  const turnStartMs = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let lastModel: string | undefined;
  let lastProviderType: string | undefined;
  let lastEstimated = false;
  let turnToolResultTokens = 0; // per-turn 工具結果 token 累計（省 token 用）

  trace?.setSessionKey(sessionKey);
  eventBus.emit("turn:before", { accountId, channelId, sessionKey, prompt, projectId });

  // ── Workflow → Trace bridge（turn 期間記錄 workflow 事件到 trace）──────────
  const _wfListeners: Array<() => void> = [];
  if (trace) {
    const onRut = (warnings: { pattern: string; count: number }[]) => {
      trace.recordWorkflowEvent("rut", warnings.map(w => `${w.pattern}(×${w.count})`).join(", "));
    };
    const onOsc = (atom: string, count: number) => {
      trace.recordWorkflowEvent("oscillation", `${atom} ×${count}`);
    };
    const onSync = (files: string[]) => {
      trace.recordWorkflowEvent("sync_needed", `${files.length} files`);
    };
    const onFileModified = (path: string, tool: string) => {
      trace.recordWorkflowEvent("file_modified", `${tool}: ${path}`);
    };
    eventBus.on("workflow:rut", onRut);
    eventBus.on("workflow:oscillation", onOsc);
    eventBus.on("workflow:sync_needed", onSync);
    eventBus.on("file:modified", onFileModified);
    _wfListeners.push(
      () => eventBus.off("workflow:rut", onRut),
      () => eventBus.off("workflow:oscillation", onOsc),
      () => eventBus.off("workflow:sync_needed", onSync),
      () => eventBus.off("file:modified", onFileModified),
    );
  }

  // Post-compact recovery：追蹤檔案修改（獨立於 trace）
  const _onFileEditForRecovery = (path: string) => {
    const idx = recentlyEditedFiles.indexOf(path);
    if (idx !== -1) recentlyEditedFiles.splice(idx, 1);
    recentlyEditedFiles.push(path);
    if (recentlyEditedFiles.length > 5) recentlyEditedFiles.shift();
  };
  eventBus.on("file:modified", _onFileEditForRecovery);
  _wfListeners.push(() => eventBus.off("file:modified", _onFileEditForRecovery));

  // ── Background Agent Result Queue ─────────────────────────────────────────
  // 監聽 subagent:completed/failed 事件，累積結果，在下次 LLM 呼叫前注入
  const pendingBgResults: Array<{ type: "completed" | "failed"; runId: string; label: string; content: string }> = [];
  const _onBgCompleted = (_parentKey: string, runId: string, label: string, result: string) => {
    if (_parentKey !== sessionKey) return;
    pendingBgResults.push({ type: "completed", runId, label, content: result });
  };
  const _onBgFailed = (_parentKey: string, runId: string, label: string, error: string) => {
    if (_parentKey !== sessionKey) return;
    pendingBgResults.push({ type: "failed", runId, label, content: error });
  };
  eventBus.on("subagent:completed", _onBgCompleted);
  eventBus.on("subagent:failed", _onBgFailed);
  _wfListeners.push(
    () => eventBus.off("subagent:completed", _onBgCompleted),
    () => eventBus.off("subagent:failed", _onBgFailed),
  );

  log.debug(`[agent-loop] ── turn 開始 ── sessionKey=${sessionKey} turnCount=${session.turnCount} accountId=${accountId} history=${processedHistory.length} msgs systemPrompt=${systemPrompt.length} chars`);

  try {
    while (loopCount++ < loopCap) {
      // 把「本 iter 剛活化」移到「上一 iter 活化」槽，供本 iter end_turn 判斷
      prevIterDeferredActivated = deferredJustActivated;
      deferredJustActivated = [];

      // ── abort 快速出口（/stop 或 timeout 觸發後，下一輪不再呼叫 LLM）────
      if (controller.signal.aborted) break;

      // ── Background Agent 結果注入 ──────────────────────────────────────────
      if (pendingBgResults.length > 0) {
        const parts = pendingBgResults.splice(0).map(r => {
          const status = r.type === "completed" ? "✅ 完成" : "❌ 失敗";
          const preview = r.content.slice(0, 2000);
          return `[背景 Agent ${status}] ${r.label} (${r.runId.slice(0, 8)})\n${preview}`;
        });
        messages.push({ role: "user", content: `[系統通知] 背景子 agent 已完成：\n\n${parts.join("\n\n---\n\n")}` });
        log.debug(`[agent-loop] 注入 ${parts.length} 個背景 agent 結果`);
      }

      // ── 5a. LLM 呼叫（帶重試）────────────────────────────────────────────
      log.debug(`[agent-loop] [loop=${loopCount}] 呼叫 LLM msgs=${messages.length}`);
      trace?.recordLLMCallStart(loopCount);

      // PreLlmCall / PreTurn hook（observer，不 block）
      {
        const { getHookRegistry } = await import("../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg) {
          if (hookReg.count("PreTurn", opts.agentId) > 0) {
            await hookReg.runPreTurn({ event: "PreTurn", sessionKey, accountId, channelId, agentId: opts.agentId, turnIndex: loopCount });
          }
          if (hookReg.count("PreLlmCall", opts.agentId) > 0) {
            await hookReg.runPreLlmCall({
              event: "PreLlmCall", sessionKey, accountId, channelId, agentId: opts.agentId,
              model: lastModel ?? "", provider: provider.id, messageCount: messages.length,
            });
          }
        }
      }

      const llmCallStartMs = Date.now();
      // 每 iter 重組 systemPrompt：base + 當前 pending 的 deferred listing（已活化的不會再列）
      const deferredBlockNow = buildDeferredBlock();
      const currentSystemPrompt = deferredBlockNow
        ? (systemPrompt ? `${systemPrompt}\n\n${deferredBlockNow}` : deferredBlockNow)
        : systemPrompt;
      let streamResult;
      try {
        streamResult = await callWithRetry(
          () => provider.stream(messages, {
            systemPrompt: currentSystemPrompt || undefined,
            tools: toolDefs.length > 0 ? toolDefs.map(d => ({
              name: d.name,
              description: d.description,
              input_schema: d.input_schema,
            })) : undefined,
            abortSignal: controller.signal,
            ...(opts.thinking ? { thinking: opts.thinking } : {}),
          }),
          {
            maxAttempts: opts.retryMaxAttempts ?? 3,
            baseMs: opts.retryBaseMs ?? 1000,
            maxMs: opts.retryMaxMs ?? 30_000,
            signal: controller.signal,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 使用者主動中止（/stop 或外部 signal）→ 靜默退出，不送 Discord 錯誤訊息
        if (controller.signal.aborted) {
          log.debug(`[agent-loop] turn 已中止（abort signal），靜默退出`);
          return;
        }
        log.warn(`[agent-loop] LLM 呼叫失敗 provider=${provider.id} loop=${loopCount}: ${msg}`);
        // 辨識「所有憑證耗盡」→ 不重試，直接回報
        if (msg.includes("所有 API 憑證都在 cooldown")) {
          yield { type: "error", message: msg };
          return;
        }
        yield { type: "error", message: `LLM 呼叫失敗：[${provider.id}] ${msg}` };
        eventBus.emit("provider:error", provider.id, err instanceof Error ? err : new Error(msg));
        return;
      }

      // ── 5b. 消費串流事件 ───────────────────────────────────────────────────
      // iter 級 text 累積（turn 級的 tracker 會跨 iter 累積；送回 messages 時只要本 iter 的）
      let iterText = "";
      let providerError: string | null = null;  // 捕捉 provider 端 stream 錯誤（pi-ai 會 emit type=error）
      for await (const event of streamResult.events as AsyncIterable<ProviderEvent>) {
        if (event.type === "text_delta") {
          iterText += event.text;
          tracker.appendText(event.text);
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "thinking_delta") {
          yield { type: "thinking", thinking: event.thinking };
        } else if (event.type === "error") {
          // pi-ai 在 streamAnthropic 內部 catch 任何錯誤後 emit `{type: "error"}` 而不 throw，
          // 之前 agent-loop 沒處理這個事件 → 錯誤被吞掉，呈現為「outputEmpty + estimated=true」
          // 假裝是 Anthropic 空回應 quirk。實際可能是真的 API error（429 / 413 / 5xx / network）。
          providerError = event.message;
          log.warn(`[agent-loop] [loop=${loopCount}] provider stream error: ${event.message}`);
        }
      }

      totalInputTokens += streamResult.usage.input;
      totalOutputTokens += streamResult.usage.output;
      totalCacheRead += streamResult.usage.cacheRead ?? 0;
      totalCacheWrite += streamResult.usage.cacheWrite ?? 0;
      lastModel = streamResult.usage.model;
      lastProviderType = streamResult.usage.providerType;
      if (streamResult.usage.estimated) lastEstimated = true;

      // PostLlmCall hook（observer）
      {
        const { getHookRegistry } = await import("../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("PostLlmCall", opts.agentId) > 0) {
          await hookReg.runPostLlmCall({
            event: "PostLlmCall", sessionKey, accountId, channelId, agentId: opts.agentId,
            model: streamResult.usage.model ?? "", provider: streamResult.usage.providerType ?? provider.id,
            inputTokens: streamResult.usage.input, outputTokens: streamResult.usage.output,
            durationMs: Date.now() - llmCallStartMs,
            finishReason: streamResult.stopReason,
          });
        }
      }

      // Trace: LLM call 結束
      trace?.recordLLMCallEnd({
        model: streamResult.usage.model ?? "",
        provider: streamResult.usage.providerType ?? provider.id,
        inputTokens: streamResult.usage.input,
        outputTokens: streamResult.usage.output,
        cacheRead: streamResult.usage.cacheRead ?? 0,
        cacheWrite: streamResult.usage.cacheWrite ?? 0,
        estimated: streamResult.usage.estimated ?? false,
        stopReason: streamResult.stopReason,
      });

      if (controller.signal.aborted) break;

      // ── 5b-1. Provider stream 錯誤優先處理（pi-ai 會 emit error 事件而不 throw）──
      // 之前完全沒處理 → 錯誤被吞掉，呈現為「outputEmpty + estimated=true」假裝是空回應 quirk
      if (providerError) {
        const errMsg = `\n\n❌ LLM provider 錯誤：${providerError}\n（已記入 trace，若反覆出現請貼 trace 給 wells 看）`;
        yield { type: "text_delta", text: errMsg };
        tracker.appendText(errMsg);
        log.warn(`[agent-loop] [loop=${loopCount}] 終止 turn — provider error 已通知使用者`);
        break;
      }

      if (streamResult.stopReason === "end_turn") {
        // 本 iter 是否空回應：output=0 + estimated=true 代表 provider 沒收到任何 event
        // （Claude API events 陣列為空 → fallback 預設 end_turn + estimated usage，見 claude-api.ts:336）
        const outputEmpty = streamResult.usage.output === 0 && (streamResult.usage.estimated ?? false);
        if (outputEmpty) {
          // Debug dump：空回應時印出關鍵 state，方便排查 root cause
          const lastMsg = messages[messages.length - 1];
          const lastMsgPreview = lastMsg
            ? `role=${lastMsg.role} contentType=${Array.isArray(lastMsg.content) ? `array[${lastMsg.content.length}]` : "string"}`
            : "none";
          const toolNames = toolDefs.map(d => d.name).join(",");
          log.warn(`[agent-loop] [loop=${loopCount}] EMPTY RESPONSE: msgs=${messages.length} tools=${toolDefs.length} prevDeferred=[${prevIterDeferredActivated.join(",")}] lastMsg=${lastMsgPreview} toolNames=[${toolNames}]`);
        }
        // Deferred Tool Nudge：deferred tool 已活化過 + 本 iter 空回應 → 注入中性續接
        // 文案改中性（去「[系統提示]」前綴）避開 Anthropic Common cause #1（tool_result 後加 text 強化 end_turn）
        //
        // 用 loadedDeferredNames（累積載入的 deferred tool 集合，跨 iter 持久）判斷，
        // 不用 prevIterDeferredActivated（只看上一 iter 活化）—— 後者在 nudge 之後會變空
        // （nudge iter 沒新活化任何 tool），導致第 2 次續接條件 false、break 放棄
        //
        // 上限 3 次：單次 nudge 不一定救得回來（觀察過連續 2 次 nudge 才啟動），但也不能無限
        if (outputEmpty && loadedDeferredNames.size > 0 && deferredNudgeCount < MAX_DEFERRED_NUDGES) {
          deferredNudgeCount++;
          const loaded = Array.from(loadedDeferredNames).join(", ");
          log.warn(`[agent-loop] [loop=${loopCount}] tool_search 後空回應 end_turn，自動注入 continuation ${deferredNudgeCount}/${MAX_DEFERRED_NUDGES}（已載入 ${loaded}）`);
          messages.push({
            role: "user",
            content: `Tools now available: ${loaded}.`,
          });
          continue;
        }
        // 如果 nudge 用完還在 empty end_turn → 標記，讓最終 response 補通知給使用者
        if (outputEmpty && loadedDeferredNames.size > 0 && deferredNudgeCount >= MAX_DEFERRED_NUDGES) {
          deferredNudgeExhausted = true;
          log.warn(`[agent-loop] [loop=${loopCount}] deferred nudge 用完仍空回應，放棄 turn`);
        }
        break;
      }

      // ── Output Token Recovery：截斷偵測 + 自動續接 ────────────────────────
      if (streamResult.stopReason === "max_tokens") {
        continuationCount++;
        if (continuationCount > MAX_CONTINUATIONS) {
          log.warn(`[agent-loop] max_tokens 續接已達上限 (${MAX_CONTINUATIONS})，結束 turn`);
          break;
        }
        log.info(`[agent-loop] [loop=${loopCount}] output 被截斷（max_tokens），自動續接 (${continuationCount}/${MAX_CONTINUATIONS})`);
        // 將截斷的 assistant 回覆加入 messages，再送 user "繼續" 讓 LLM 接著寫
        const partialText = tracker.getFullResponse();
        if (partialText) {
          messages.push({ role: "assistant", content: partialText, tokens: streamResult.usage.output > 0 ? streamResult.usage.output : undefined });
        }
        messages.push({ role: "user", content: "繼續" });
        continue;  // 回到 while loop 頂部，再次呼叫 LLM
      }

      if (streamResult.stopReason !== "tool_use") break;
      if (streamResult.toolCalls.length === 0) break;

      // ── 5c. Tool 執行 ──────────────────────────────────────────────────────
      log.debug(`[agent-loop] [loop=${loopCount}] 執行 ${streamResult.toolCalls.length} 個 tool: ${streamResult.toolCalls.map(t => t.name).join(", ")}`);
      const toolResults: Array<{ tool_use_id: string; content: string | Array<{ type: string; [key: string]: unknown }>; is_error: boolean }> = [];

      // 先把 assistant 的 text + tool_use 加入 messages（B: 標記 token 數）
      // 關鍵：Anthropic 規範 assistant content 應包含 LLM 本 iter 所有 blocks（text 在前、tool_use 在後）。
      // 若只 push tool_use 會讓下一 iter 看到殘缺 state，容易觸發空回應 end_turn。
      const assistantContent: ContentBlock[] = [];
      if (iterText.trim().length > 0) {
        assistantContent.push({ type: "text", text: iterText });
      }
      for (const tc of streamResult.toolCalls) {
        assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.params as object });
      }
      messages.push({
        role: "assistant",
        content: assistantContent,
        tokens: streamResult.usage.output > 0 ? streamResult.usage.output : undefined,
      });

      // spawn_subagent 並行：同一輪多個 spawn_subagent → Promise.all（其他 tool 維持串行）
      const spawnCalls = streamResult.toolCalls.filter(tc => tc.name === "spawn_subagent");
      const otherCalls = streamResult.toolCalls.filter(tc => tc.name !== "spawn_subagent");

      if (spawnCalls.length > 1) {
        // 並行執行（不在 callback 裡 yield，收集後統一 yield）
        type SpawnEvent = AgentLoopEvent;
        type SpawnBatchResult = {
          toolResult: { tool_use_id: string; content: string; is_error: boolean };
          events: SpawnEvent[];
          toolRecord: { name: string; params: unknown; result: unknown; error?: string; durationMs: number };
        };

        const batchResults = await Promise.all(spawnCalls.map(async (call): Promise<SpawnBatchResult> => {
          const params = call.params as Record<string, unknown>;
          const toolCtx: ToolContext = { accountId, projectId, sessionId: sessionKey, channelId, eventBus, spawnDepth, parentRunId: opts.parentRunId, traceId: trace?.traceId, agentId: opts.agentId, isAdmin: opts.isAdmin };
          const events: SpawnEvent[] = [];
          const hookResult = await runBeforeToolCall(
            { id: call.id, name: call.name, params },
            { accountId, role: opts.speakerRole, agentId: opts.agentId, isAdmin: opts.isAdmin, recentCalls: tracker.toolCalls, readFiles, sessionKey, channelId, toolTier: toolRegistry.get(call.name)?.tier },
            permissionGate, safetyGuard,
          );
          if (hookResult.blocked) {
            events.push({ type: "tool_blocked", name: call.name, reason: hookResult.reason });
            return {
              toolResult: { tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true },
              events,
              toolRecord: { name: call.name, params, result: null, error: hookResult.reason, durationMs: 0 },
            };
          }
          if (opts.showToolCalls !== "none") {
            events.push({ type: "tool_start", name: call.name, id: call.id, params: hookResult.params });
          }
          eventBus.emit("tool:before", { id: call.id, name: call.name, params: hookResult.params });
          const t0 = Date.now();
          let toolResult = await toolRegistry.execute(call.name, hookResult.params, toolCtx);
          const durationMs = Date.now() - t0;
          // PostToolUse hook
          const postHookResult = await runPostToolUseHook(call.name, hookResult.params, toolResult, durationMs, { accountId, sessionKey, channelId });
          if (postHookResult.result !== undefined) toolResult = { ...toolResult, result: postHookResult.result };
          if (toolResult.error) {
            eventBus.emit("tool:error", { id: call.id, name: call.name, params: hookResult.params }, new Error(toolResult.error));
          } else {
            eventBus.emit("tool:after", { id: call.id, name: call.name, params: hookResult.params }, toolResult);
          }
          // Error 訊息不過 truncate（避免錯誤被截斷後 agent 看不到完整原因）
          let resultText: string;
          if (toolResult.error) {
            resultText = `錯誤：${toolResult.error}`;
          } else {
            const rawText = JSON.stringify(toolResult.result ?? null);
            const tokenCap = resolveResultTokenCap(toolRegistry.get(call.name)?.resultTokenCap, turnToolResultTokens, opts.modePreset?.resultTokenCap);
            resultText = truncateToolResult(rawText, tokenCap, call.name);
          }
          events.push({ type: "tool_result", name: call.name, id: call.id, result: toolResult.result, error: toolResult.error });
          return {
            toolResult: { tool_use_id: call.id, content: resultText, is_error: Boolean(toolResult.error) },
            events,
            toolRecord: { name: call.name, params: hookResult.params, result: toolResult.result, error: toolResult.error, durationMs },
          };
        }));

        // 按序 yield 收集到的事件
        for (const batch of batchResults) {
          for (const evt of batch.events) yield evt;
          toolResults.push(batch.toolResult);
          turnToolResultTokens += Math.ceil(batch.toolResult.content.length / 4);
          tracker.recordToolCall(batch.toolRecord.name, batch.toolRecord.params, batch.toolRecord.result, batch.toolRecord.error, batch.toolRecord.durationMs);
          trace?.recordToolCall({
            name: batch.toolRecord.name,
            durationMs: batch.toolRecord.durationMs,
            error: batch.toolRecord.error,
            resultPreview: toolResultPreview(batch.toolRecord.result, batch.toolRecord.error),
            paramsPreview: toolParamsPreview(batch.toolRecord.name, batch.toolRecord.params),
          });
        }
      }

      // ── Batch Partition：concurrencySafe tool 並行，其餘串行 ──────────────
      const serialCalls = spawnCalls.length > 1 ? otherCalls : streamResult.toolCalls;
      const concurrentCalls = serialCalls.filter(tc => toolRegistry.get(tc.name)?.concurrencySafe === true);
      const sequentialCalls = serialCalls.filter(tc => toolRegistry.get(tc.name)?.concurrencySafe !== true);

      // 並行執行 concurrencySafe tools（read_file, glob, grep 等）
      if (concurrentCalls.length > 1) {
        type BatchResult = {
          toolResult: { tool_use_id: string; content: string; is_error: boolean };
          events: AgentLoopEvent[];
          toolRecord: { name: string; params: unknown; result: unknown; error?: string; durationMs: number };
          fileModified?: { path: string; tool: string };
        };
        const batchResults = await Promise.all(concurrentCalls.map(async (call): Promise<BatchResult> => {
          const params = call.params as Record<string, unknown>;
          const toolCtx: ToolContext = { accountId, projectId, sessionId: sessionKey, channelId, eventBus, spawnDepth, parentRunId: opts.parentRunId, traceId: trace?.traceId, agentId: opts.agentId, isAdmin: opts.isAdmin };
          const events: AgentLoopEvent[] = [];

          const hookResult = await runBeforeToolCall(
            { id: call.id, name: call.name, params },
            { accountId, role: opts.speakerRole, agentId: opts.agentId, isAdmin: opts.isAdmin, recentCalls: tracker.toolCalls, readFiles, sessionKey, channelId, toolTier: toolRegistry.get(call.name)?.tier },
            permissionGate, safetyGuard,
          );
          if (hookResult.blocked) {
            events.push({ type: "tool_blocked", name: call.name, reason: hookResult.reason });
            return { toolResult: { tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true }, events, toolRecord: { name: call.name, params, result: null, error: hookResult.reason, durationMs: 0 } };
          }
          if (opts.showToolCalls !== "none") events.push({ type: "tool_start", name: call.name, id: call.id, params: hookResult.params });
          eventBus.emit("tool:before", { id: call.id, name: call.name, params: hookResult.params });
          const t0 = Date.now();
          let toolResult = await toolRegistry.execute(call.name, hookResult.params, toolCtx);
          const durationMs = Date.now() - t0;
          // PostToolUse hook
          const postHookResult = await runPostToolUseHook(call.name, hookResult.params, toolResult, durationMs, { accountId, sessionKey, channelId });
          if (postHookResult.result !== undefined) toolResult = { ...toolResult, result: postHookResult.result };
          if (toolResult.error) {
            eventBus.emit("tool:error", { id: call.id, name: call.name, params: hookResult.params }, new Error(toolResult.error));
          } else {
            eventBus.emit("tool:after", { id: call.id, name: call.name, params: hookResult.params }, toolResult);
          }
          // Error 訊息不過 truncate（避免錯誤被截斷後 agent 看不到完整原因）
          let resultText: string;
          if (toolResult.error) {
            resultText = `錯誤：${toolResult.error}`;
          } else {
            const rawText = JSON.stringify(toolResult.result ?? null);
            const tokenCap = resolveResultTokenCap(toolRegistry.get(call.name)?.resultTokenCap, turnToolResultTokens, opts.modePreset?.resultTokenCap);
            resultText = truncateToolResult(rawText, tokenCap, call.name);
          }
          events.push({ type: "tool_result", name: call.name, id: call.id, result: toolResult.result, error: toolResult.error });
          return {
            toolResult: { tool_use_id: call.id, content: resultText, is_error: Boolean(toolResult.error) },
            events,
            toolRecord: { name: call.name, params: hookResult.params, result: toolResult.result, error: toolResult.error, durationMs },
            fileModified: toolResult.fileModified && toolResult.modifiedPath ? { path: toolResult.modifiedPath, tool: call.name } : undefined,
          };
        }));

        for (const batch of batchResults) {
          for (const evt of batch.events) yield evt;
          toolResults.push(batch.toolResult);
          turnToolResultTokens += Math.ceil(batch.toolResult.content.length / 4);
          tracker.recordToolCall(batch.toolRecord.name, batch.toolRecord.params, batch.toolRecord.result, batch.toolRecord.error, batch.toolRecord.durationMs);
          // Read-before-Write：batch 中的 read_file 成功後記錄路徑
          if (batch.toolRecord.name === "read_file" && !batch.toolRecord.error) {
            const rp = String((batch.toolRecord.params as Record<string, unknown>)["path"] ?? (batch.toolRecord.params as Record<string, unknown>)["file_path"] ?? "");
            if (rp) readFiles.add(rp);
          }
          trace?.recordToolCall({ name: batch.toolRecord.name, durationMs: batch.toolRecord.durationMs, error: batch.toolRecord.error, resultPreview: toolResultPreview(batch.toolRecord.result, batch.toolRecord.error), paramsPreview: toolParamsPreview(batch.toolRecord.name, batch.toolRecord.params) });
          if (batch.fileModified) eventBus.emit("file:modified", batch.fileModified.path, batch.fileModified.tool, accountId);
        }
        log.debug(`[agent-loop] batch-partition: ${concurrentCalls.length} 個 concurrencySafe tool 已並行完成`);
      } else {
        // 單個 concurrencySafe tool 歸入 sequential
        sequentialCalls.unshift(...concurrentCalls);
      }

      for (const call of sequentialCalls) {
        const params = call.params as Record<string, unknown>;
        const toolCtx: ToolContext = {
          accountId,
          projectId,
          sessionId: sessionKey,
          channelId,
          eventBus,
          spawnDepth,
          parentRunId: opts.parentRunId,
          traceId: trace?.traceId,
          agentId: opts.agentId,
          isAdmin: opts.isAdmin,
        };

        // before_tool_call
        const hookResult = await runBeforeToolCall(
          { id: call.id, name: call.name, params },
          { accountId, role: opts.speakerRole, agentId: opts.agentId, isAdmin: opts.isAdmin, recentCalls: tracker.toolCalls, sessionKey, channelId, toolTier: toolRegistry.get(call.name)?.tier },
          permissionGate,
          safetyGuard,
        );

        if (hookResult.blocked) {
          // 軟擋（needsApproval）→ 有 exec-approval 就走授權流程，否則硬擋
          if (hookResult.needsApproval && opts.execApproval?.enabled) {
            log.info(`[agent-loop] guard 軟擋 → 走 exec-approval：${hookResult.reason}`);
            const displayCmd = `[Guard] ${hookResult.reason}`;
            const timeoutMs = opts.execApproval.timeoutMs ?? 60_000;
            const [approvalId, approvalPromise] = createApproval(displayCmd, channelId, timeoutMs);
            try {
              await sendApprovalDm({
                dmUserId: opts.execApproval.dmUserId,
                command: displayCmd,
                channelId,
                approvalId,
                timeoutMs,
                sendTextFallback: opts.execApproval.sendDm,
              });
              log.info(`[agent-loop] guard-approval 等待確認 approvalId=${approvalId}`);
            } catch (err) {
              log.warn(`[agent-loop] guard-approval 送 DM 失敗，硬擋：${err instanceof Error ? err.message : String(err)}`);
              toolResults.push({ tool_use_id: call.id, content: `錯誤：${hookResult.reason}（授權請求失敗）`, is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: hookResult.reason };
              continue;
            }
            const approved = await approvalPromise;
            if (!approved) {
              log.info(`[agent-loop] guard-approval 拒絕 approvalId=${approvalId}`);
              toolResults.push({ tool_use_id: call.id, content: `錯誤：使用者拒絕授權 — ${hookResult.reason}`, is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: `使用者拒絕：${hookResult.reason}` };
              continue;
            }
            log.info(`[agent-loop] guard-approval 允許 approvalId=${approvalId}`);
            // 授權通過 → 繼續執行（不 continue）
          } else {
            yield { type: "tool_blocked", name: call.name, reason: hookResult.reason };
            toolResults.push({ tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true });
            continue;
          }
        }

        // guard-approval 通過後，effectiveParams 為原始參數（hookResult.blocked=true 時無 params）
        const effectiveParams: Record<string, unknown> = hookResult.blocked ? params : (hookResult.params ?? params);

        // ── Reversibility Warning ─────────────────────────────────────────────
        // score ≥ 2 → 在 tool result 前注入警告（不阻擋，但提醒 LLM）
        const _reversibilityWarning = hookResult.blocked ? undefined : hookResult.warning;

        // ── Exec Approval（run_command / write_file / edit_file DM 確認）────────
        const _approvalTools = ["run_command", "write_file", "edit_file"];
        if (_approvalTools.includes(call.name) && opts.execApproval?.enabled) {
          const p = effectiveParams;
          // 組成可讀的操作描述
          let displayCmd: string;
          if (call.name === "run_command") {
            displayCmd = String(p["command"] ?? "");
          } else if (call.name === "write_file") {
            displayCmd = `write_file ${String(p["path"] ?? p["file_path"] ?? "")}`;
          } else {
            displayCmd = `edit_file ${String(p["path"] ?? p["file_path"] ?? "")}`;
          }
          const timeoutMs = opts.execApproval.timeoutMs ?? 60_000;

          // 白名單檢查
          if (isCommandAllowed(displayCmd, opts.execApproval.allowedPatterns ?? [])) {
            log.debug(`[agent-loop] exec-approval 白名單通過，自動允許 command="${displayCmd.slice(0, 80)}"`);
          } else {
            const [approvalId, approvalPromise] = createApproval(displayCmd, channelId, timeoutMs);
            try {
              await sendApprovalDm({
                dmUserId: opts.execApproval.dmUserId,
                command: displayCmd,
                channelId,
                approvalId,
                timeoutMs,
                sendTextFallback: opts.execApproval.sendDm,
              });
              log.info(`[agent-loop] exec-approval 等待確認 approvalId=${approvalId} command="${displayCmd.slice(0, 80)}"`);
            } catch (err) {
              log.warn(`[agent-loop] exec-approval 送 DM 失敗，自動拒絕：${err instanceof Error ? err.message : String(err)}`);
              toolResults.push({ tool_use_id: call.id, content: "錯誤：DM 確認失敗，操作未執行", is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: "DM 確認失敗" };
              continue;
            }
            const approved = await approvalPromise;
            if (!approved) {
              log.info(`[agent-loop] exec-approval 拒絕 approvalId=${approvalId}`);
              toolResults.push({ tool_use_id: call.id, content: "錯誤：使用者拒絕執行（或確認逾時）", is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: "使用者拒絕執行操作" };
              continue;
            }
            log.info(`[agent-loop] exec-approval 允許 approvalId=${approvalId}`);
          }
        }

        if (opts.showToolCalls !== "none") {
          yield { type: "tool_start", name: call.name, id: call.id, params: effectiveParams };
        }

        eventBus.emit("tool:before", { id: call.id, name: call.name, params: effectiveParams });
        const t0 = Date.now();

        // Tool 執行：逾時自動重試 1 次（總共最多 2 次嘗試）
        // 非逾時錯誤不重試，避免無效放大副作用
        const TOOL_TIMEOUT_MAX_RETRIES = 1;
        let toolResult = await toolRegistry.execute(call.name, effectiveParams, toolCtx);
        for (let attempt = 1; attempt <= TOOL_TIMEOUT_MAX_RETRIES; attempt++) {
          if (!toolResult.error || !toolResult.error.includes("逾時")) break;
          log.warn(`[agent-loop] tool ${call.name} 逾時，重試 ${attempt}/${TOOL_TIMEOUT_MAX_RETRIES}`);
          toolResult = await toolRegistry.execute(call.name, effectiveParams, toolCtx);
        }
        if (toolResult.error?.includes("逾時")) {
          const totalAttempts = TOOL_TIMEOUT_MAX_RETRIES + 1;
          log.warn(`[agent-loop] tool ${call.name} 連續 ${totalAttempts} 次逾時，放棄並回報 LLM`);
          toolResult = {
            ...toolResult,
            error: `${toolResult.error}；已重試共 ${totalAttempts} 次仍逾時，請改變策略或拆分操作後再試`,
          };
        }
        const durationMs = Date.now() - t0;
        // PostToolUse hook
        const postHookResult = await runPostToolUseHook(call.name, effectiveParams, toolResult, durationMs, { accountId, sessionKey, channelId });
        if (postHookResult.result !== undefined) toolResult = { ...toolResult, result: postHookResult.result };

        if (toolResult.error) {
          eventBus.emit("tool:error", { id: call.id, name: call.name, params: effectiveParams }, new Error(toolResult.error));
        } else {
          eventBus.emit("tool:after", { id: call.id, name: call.name, params: effectiveParams }, toolResult);
          if (toolResult.fileModified && toolResult.modifiedPath) {
            eventBus.emit("file:modified", toolResult.modifiedPath, call.name, accountId);
          }
        }

        tracker.recordToolCall(call.name, effectiveParams, toolResult.result, toolResult.error, durationMs);
        // Read-before-Write：read_file 成功後記錄路徑
        if (call.name === "read_file" && !toolResult.error) {
          const readPath = String(effectiveParams["path"] ?? effectiveParams["file_path"] ?? "");
          if (readPath) readFiles.add(readPath);
        }
        // Trace: tool call 記錄
        trace?.recordToolCall({
          name: call.name,
          durationMs,
          error: toolResult.error,
          resultPreview: toolResultPreview(toolResult.result, toolResult.error),
          paramsPreview: toolParamsPreview(call.name, effectiveParams),
        });
        if (toolResult.error) {
          log.debug(`[agent-loop] [使用工具] (${call.name}) :: error ${durationMs}ms — ${toolResult.error}`);
        } else {
          log.debug(`[agent-loop] [使用工具] (${call.name}) :: ok ${durationMs}ms`);
        }

        // Rich content blocks（MCP screenshot 等回傳圖片時使用）
        if (toolResult.contentBlocks?.length && !toolResult.error) {
          turnToolResultTokens += Math.ceil(JSON.stringify(toolResult.contentBlocks).length / 4);
          toolResults.push({
            tool_use_id: call.id,
            content: toolResult.contentBlocks,
            is_error: false,
          });
        } else {
          const rawResultText = toolResult.error
            ? `錯誤：${toolResult.error}`
            : JSON.stringify(toolResult.result ?? null);
          const cap = resolveResultTokenCap(toolRegistry.get(call.name)?.resultTokenCap, turnToolResultTokens, opts.modePreset?.resultTokenCap);
          const resultText = truncateToolResult(rawResultText, cap, call.name);
          if (resultText.length < rawResultText.length) {
            log.debug(`[agent-loop] [使用工具] (${call.name}) :: result truncated ${rawResultText.length} → ${resultText.length} chars`);
          }
          turnToolResultTokens += Math.ceil(resultText.length / 4);

          // Reversibility warning 前置到結果
          const finalResultText = _reversibilityWarning
            ? `⚠️ [可逆性警告] ${_reversibilityWarning}\n\n${resultText}`
            : resultText;

          toolResults.push({
            tool_use_id: call.id,
            content: finalResultText,
            is_error: Boolean(toolResult.error),
          });
        }

        yield {
          type: "tool_result",
          name: call.name,
          id: call.id,
          result: toolResult.result,
          error: toolResult.error,
        };
      }

      // ── Deferred Tool Activation：tool_search 呼叫後，依**實際返回的 tool 名單**活化 ──
      // 不再從 query 字串 fuzzy 推導——這會導致 `_navigate` 被查到時，`_navigate_back` 也因
      // 子字串匹配被活化，造成 Claude API 空回應 end_turn（見 trace 9cc832ce，tools=18）。
      // 正解：tool_search 自己已經做過 exact/keyword 匹配，直接信任它的 result，取 name 陣列。
      //
      // 每輪活化上限 ACTIVATE_PER_ITER_LIMIT：
      //   LLM 現在會批次預查（`tool_search "a,b,c,d,e"`）一次活化 5+ deferred tools。
      //   這會觸發 Anthropic 空回應 quirk（下輪 LLM 收到 5 個新 tool 突然加入，直接 end_turn），
      //   trace 82aa1fec 實測：一次活化 ≥3 個 → 連 4 輪 empty。
      //   改成每輪最多活化 3 個，剩下的留在 loadedDeferredNames 裡，LLM 再 tool_search 會拿到剩下的。
      for (const call of streamResult.toolCalls) {
        if (call.name !== "tool_search") continue;
        const rec = tracker.toolCalls.find(tc => tc.name === "tool_search");
        if (!rec || rec.error) continue;
        const matchedNames = new Set<string>();
        if (Array.isArray(rec.result)) {
          for (const item of rec.result as Array<{ name?: unknown }>) {
            if (item && typeof item.name === "string") matchedNames.add(item.name);
          }
        }
        if (matchedNames.size === 0) continue;
        let activatedThisIter = 0;
        for (const def of deferredDefs) {
          if (loadedDeferredNames.has(def.name)) continue;
          if (matchedNames.has(def.name)) {
            if (activatedThisIter >= ACTIVATE_PER_ITER_LIMIT) break;
            toolDefs.push(def);
            loadedDeferredNames.add(def.name);
            deferredJustActivated.push(def.name);
            activatedThisIter++;
            log.debug(`[agent-loop] deferred tool activated: ${def.name}`);
          }
        }
        if (activatedThisIter < matchedNames.size) {
          log.info(`[agent-loop] deferred 活化節流：本輪 ${activatedThisIter}/${matchedNames.size}（防 Anthropic 空回應 quirk）`);
        }
      }

      // 把 tool results 加入 messages
      messages.push(makeToolResultMessage(toolResults));

      // ── 自適應 loop cap：接近上限 + 進展健康 → 延長 ─────────────────────────
      //   「接近」：剩 ≤2 輪時判斷（避免太早擴展讓 buggy case 也被放寬）
      //   「健康」：近 5 輪全部成功 + tool_search 不超過 2 次（tool_search 多 = 空轉訊號）
      if (loopCount >= loopCap - 2 && loopCap < LOOP_CAP_CEILING) {
        if (isHealthyProgress(tracker.toolCalls)) {
          const oldCap = loopCap;
          loopCap = Math.min(LOOP_CAP_CEILING, loopCap + LOOP_EXTEND_STEP);
          log.info(`[agent-loop] [loop=${loopCount}] 自適應延長 cap ${oldCap} → ${loopCap}（近 5 輪健康進展）`);
        }
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    clearTurnAbort(sessionKey);
  }

  // ── 6. Turn 結束 ────────────────────────────────────────────────────────────
  // 觸頂判斷：post-increment 讓自然退出時 loopCount === loopCap+1；break 則 ≤ loopCap
  // 不讓使用者以為 bot 消失 — 把現況補進 response，讓 Discord 端至少有訊息、可用「繼續」追
  const maxLoopsReached = loopCount > loopCap;
  let fullResponse = tracker.getFullResponse();
  // 關鍵：reply-handler 從 text_delta 事件串流累積 Discord 訊息，不讀 done.text
  // → 在 loop 後直接 append 到 fullResponse 的通知 **永遠不會上 Discord**
  // 修法：算出 notice 後，yield 一個 text_delta 事件讓 Discord 端收得到
  let bailNotice: string | null = null;
  if (maxLoopsReached) {
    const toolsRun = tracker.toolCalls.length;
    const lastTools = tracker.toolCalls.slice(-3).map(tc => tc.name).join(" → ") || "（無）";
    const extended = loopCap > BASE_LOOPS ? `（已自適應延長到 ${loopCap}）` : "";
    bailNotice = `\n\n⚠️ 已達工具呼叫上限 ${loopCap} 輪${extended}（執行了 ${toolsRun} 個工具，最後 3 個：${lastTools}），自動中止本輪。任務可能未完成 — 若要繼續請回覆「繼續」或補充指示。`;
    log.warn(`[agent-loop] loop cap 觸頂：sessionKey=${sessionKey} cap=${loopCap} tools=${toolsRun}`);
  } else if (deferredNudgeExhausted) {
    // 不是 loop cap 觸頂，而是 Anthropic API 在 tool_search 後連續空回應 end_turn
    // nudge 已經注入 3 次還是沒用 → 提醒使用者，不讓模型看起來裝死
    bailNotice = `\n\n⚠️ 模型在工具查詢後連續 ${MAX_DEFERRED_NUDGES + 1} 次空回應（Anthropic API 已知 quirk），自動中止。若要繼續請回覆「繼續」，或重述需求更具體一點。`;
    log.warn(`[agent-loop] deferred nudge 耗盡：sessionKey=${sessionKey}`);
  }
  if (bailNotice) {
    fullResponse = fullResponse.trim() ? fullResponse + bailNotice : bailNotice.trimStart();
    // 讓 reply-handler 把 notice 送到 Discord（會 append 到 totalText + progressMsg）
    yield { type: "text_delta", text: bailNotice };
  }

  // Tool Log Store：儲存 tool 執行記錄，session history 加索引摘要
  // 注意：session.turnCount 此時是「本輪尚未計入」的值（addMessages 下面才 ++）
  // 必須把這個「本輪」值同時給 tool-log 的檔名和 trace 的 turnIndex，否則兩邊差 1
  // → dashboard click-to-expand 會讀到下一輪的 tool log
  const savedTurnIndex = session.turnCount;
  const toolLogStore = getToolLogStore();
  let toolLogPath: string | null = null;
  const extraMessages: Message[] = [];
  if (toolLogStore && tracker.toolCalls.length > 0) {
    toolLogPath = toolLogStore.save(
      sessionKey,
      savedTurnIndex,
      tracker.toolCalls.map(tc => ({
        id: Math.random().toString(36).slice(2),
        name: tc.name,
        params: tc.params,
        result: tc.result,
        error: tc.error,
        durationMs: tc.durationMs,
      })),
    );
    if (toolLogPath) {
      const summary = ToolLogStore.buildIndexSummary(
        tracker.toolCalls.map(tc => ({ id: "", name: tc.name, params: tc.params, result: tc.result, error: tc.error, durationMs: tc.durationMs })),
        toolLogPath,
        session.turnCount,
      );
      extraMessages.push({ role: "user" as const, content: summary });
    }
  }

  // 儲存 turn 到 session（B: 標記 per-message token 數）
  // 若本輪呼叫了 clear_session，不再將本輪訊息寫回（否則清除等於白做）
  const sessionClearedDuringTurn = tracker.toolCalls.some(tc => tc.name === "clear_session" && !tc.error);
  if (!sessionClearedDuringTurn) {
    const promptTokens = Math.ceil(prompt.length / 4);
    const responseTokens = totalOutputTokens > 0 ? totalOutputTokens : Math.ceil(fullResponse.length / 4);
    const turnTs = Date.now();
    const turnIdx = session.turnCount;
    sessionManager.addMessages(sessionKey, [
      { role: "user", content: prompt, tokens: promptTokens, turnIndex: turnIdx, timestamp: turnTs },
      { role: "assistant", content: fullResponse, tokens: responseTokens, turnIndex: turnIdx, timestamp: turnTs },
      ...extraMessages,
    ]);
  } else {
    log.info(`[agent-loop] clear_session 已執行，跳過本輪 addMessages`);
  }

  eventBus.emit("turn:after", { accountId, channelId, sessionKey, prompt, projectId }, fullResponse);

  // Turn Cap Warning（P4：防止 session 無上限累積）
  const turnCapWarn = config.contextEngineering?.turnCapWarning ?? 100;
  if (turnCapWarn > 0 && session.turnCount >= turnCapWarn && session.turnCount % 20 === 0) {
    log.warn(`[agent-loop] session ${sessionKey} turnCount=${session.turnCount} 已超過建議上限 ${turnCapWarn}，建議執行 /clear-session`);
  }

  // Session Snapshot：正常完成 → 刪除快照（CE 壓縮時保留 48h）
  if (snapshotStore) {
    const ceApplied = (contextEngine?.lastBuildBreakdown?.strategiesApplied?.length ?? 0) > 0;
    if (!ceApplied) {
      snapshotStore.delete(sessionKey, session.turnCount);
    }
    // CE 壓縮時快照在 save 時已設定 expiresAt=48h，不需額外操作
  }

  // ── Session Note 萃取（fire-and-forget）────────────────────────────────────
  if (opts.sessionMemory?.enabled) {
    const sessionAfterForNote = sessionManager.get(sessionKey) ?? session;
    const turnCountForNote = sessionAfterForNote.turnCount;
    const historyForNote = sessionManager.getHistory(sessionKey);
    checkAndSaveNote(channelId, turnCountForNote, historyForNote, opts.sessionMemory.memoryDir, {
      enabled: true,
      intervalTurns: opts.sessionMemory.intervalTurns,
      maxHistoryTurns: opts.sessionMemory.maxHistoryTurns,
    }).catch(() => { /* 靜默 */ });
  }

  // Workflow trace listeners cleanup
  for (const unsub of _wfListeners) unsub();

  // Trace: Post-process + Finalize
  if (trace) {
    const ceApplied = (contextEngine?.lastBuildBreakdown?.strategiesApplied?.length ?? 0) > 0;
    trace.recordPostProcess({
      extractRan: false, // extract 在 discord.ts 的 handleAgentLoopReply 中 fire-and-forget
      sessionSnapshotKept: ceApplied,
      sessionNoteUpdated: !!opts.sessionMemory?.enabled,
      toolLogPath: toolLogPath ?? undefined,
    });
    trace.recordResponse(fullResponse, Date.now() - turnStartMs);

    // TurnAuditLog 遷移欄位：turnIndex, phase, contextBreakdown, toolDurations
    // 原本用 post-increment 的 turnCount，導致 trace.turnIndex 與 tool-log 檔名（pre-increment）差 1
    trace.setTurnIndex(savedTurnIndex);
    trace.setPhase({
      inboundReceivedMs: turnStartMs,
      completedMs: Date.now(),
    });
    const ceBreakdownTrace = contextEngine?.lastBuildBreakdown;
    if (ceBreakdownTrace) {
      trace.setContextBreakdown({
        systemPrompt: ceBreakdownTrace.estimatedTokens, // 近似值
        recall: 0,
        history: 0,
        inboundContext: 0,
        current: 0,
      });
    }
    if (tracker.toolCalls.length > 0) {
      trace.setToolDurations(
        tracker.toolCalls.reduce<Record<string, number[]>>((acc, tc) => {
          (acc[tc.name] ??= []).push(tc.durationMs);
          return acc;
        }, {}),
      );
    }

    // 如果是 abort 導致的退出（loopCount 沒到但 response 為空），標記
    if (controller.signal.aborted) {
      trace.recordAbort("stop", !!snapshotStore);
    }

    // 持久化
    const traceStore = getTraceStore();
    if (traceStore) {
      traceStore.append(trace.finalize());
    }
  }

  // SessionEnd hook
  {
    const { getHookRegistry } = await import("../hooks/hook-registry.js");
    const hookReg = getHookRegistry();
    if (hookReg && hookReg.count("SessionEnd") > 0) {
      await hookReg.runSessionEnd({ event: "SessionEnd", sessionKey, accountId, channelId, turnCount: session.turnCount });
    }
  }

  // ── Context Usage Warning ──────────────────────────────────────────────────
  // 每個 session 在 high / critical 各最多提醒一次
  {
    const postHistory = sessionManager.getHistory(sessionKey);
    const postTokens = estimateTokens(postHistory);

    // Session CE context window
    const ceWindow = contextEngine?.getContextWindowTokens() ?? 100_000;
    const ceUtil = postTokens / ceWindow;
    const sessionWarned = session as unknown as { _contextWarned?: { high?: boolean; critical?: boolean } };
    sessionWarned._contextWarned ??= {};

    if (ceUtil >= 0.9 && !sessionWarned._contextWarned.critical) {
      sessionWarned._contextWarned.critical = true;
      yield { type: "context_warning", level: "critical", utilization: ceUtil, estimatedTokens: postTokens, contextWindow: ceWindow, source: "session" };
    } else if (ceUtil >= 0.7 && !sessionWarned._contextWarned.high) {
      sessionWarned._contextWarned.high = true;
      yield { type: "context_warning", level: "high", utilization: ceUtil, estimatedTokens: postTokens, contextWindow: ceWindow, source: "session" };
    }

    // LLM Model context window
    const modelWindow = provider.maxContextTokens;
    if (modelWindow > 0) {
      const modelUtil = totalInputTokens / modelWindow;
      const modelWarned = session as unknown as { _modelContextWarned?: { high?: boolean; critical?: boolean } };
      modelWarned._modelContextWarned ??= {};

      if (modelUtil >= 0.9 && !modelWarned._modelContextWarned.critical) {
        modelWarned._modelContextWarned.critical = true;
        yield { type: "context_warning", level: "critical", utilization: modelUtil, estimatedTokens: totalInputTokens, contextWindow: modelWindow, source: "model" };
      } else if (modelUtil >= 0.7 && !modelWarned._modelContextWarned.high) {
        modelWarned._modelContextWarned.high = true;
        yield { type: "context_warning", level: "high", utilization: modelUtil, estimatedTokens: totalInputTokens, contextWindow: modelWindow, source: "model" };
      }
    }
  }

  // AgentResponseReady hook（可 block / 改 text）+ PostTurn + SessionEnd
  try {
    const { getHookRegistry } = await import("../hooks/hook-registry.js");
    const hookReg = getHookRegistry();
    if (hookReg) {
      if (hookReg.count("AgentResponseReady", opts.agentId) > 0) {
        const r = await hookReg.runAgentResponseReady({
          event: "AgentResponseReady", sessionKey, accountId, channelId, agentId: opts.agentId,
          text: fullResponse,
          destination: platform === "discord" ? "discord" : platform === "dashboard" ? "dashboard" : "discord",
        });
        if (r.blocked) fullResponse = `[回覆被 hook 阻擋：${r.reason ?? ""}]`;
        else if (r.text !== fullResponse) fullResponse = r.text;
      }
      if (hookReg.count("PostTurn", opts.agentId) > 0) {
        await hookReg.runPostTurn({
          event: "PostTurn", sessionKey, accountId, channelId, agentId: opts.agentId,
          turnIndex: loopCount, toolCallCount: tracker.toolCalls.length,
          durationMs: Date.now() - turnStartMs,
        });
      }
    }
  } catch { /* ignore */ }

  yield { type: "done", text: fullResponse, turnCount: loopCount };
  log.debug(`[agent-loop] ── turn 完成 ── accountId=${accountId} channelId=${channelId} loops=${loopCount} tools=${tracker.toolCalls.length}`);

  } catch (fatalErr) {
    // AgentError hook（observer），任何未攔截錯誤都觸發
    try {
      const { getHookRegistry } = await import("../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("AgentError", opts.agentId) > 0) {
        await hookReg.runAgentError({
          event: "AgentError", sessionKey, accountId, channelId, agentId: opts.agentId,
          error: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
          stack: fatalErr instanceof Error ? fatalErr.stack : undefined,
          phase: "other",
        });
      }
    } catch { /* ignore */ }
    throw fatalErr;
  } finally {
    // Turn Queue 釋放：無論成功、錯誤、或 abort，都讓下一個 turn 繼續
    sessionManager.dequeueTurn(sessionKey);
  }
}
