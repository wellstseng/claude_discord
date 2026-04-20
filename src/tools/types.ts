/**
 * @file tools/types.ts
 * @description Tool 系統基礎型別定義
 *
 * 設計：每個 tool 一個 .ts 檔，export `{ tool: Tool }`
 * 由 ToolRegistry.loadFromDirectory() 自動掃描註冊。
 * 新增 tool 只加檔案，不改 registry 程式碼。
 */

import type { EventEmitter } from "node:events";

// ── Tool Tier ─────────────────────────────────────────────────────────────────

export type ToolTier = "public" | "standard" | "elevated" | "admin" | "owner";

// ── JsonSchema（tool parameters 用） ─────────────────────────────────────────

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

// ── ToolResult ────────────────────────────────────────────────────────────────

export interface ToolResult {
  result?: unknown;
  error?: string;
  /** Tool 自標記：是否修改了檔案（用於 file:modified 事件） */
  fileModified?: boolean;
  modifiedPath?: string;
  /**
   * Rich content blocks（圖片 + 文字混合）。
   * 若設定，agent-loop 會直接用此作為 tool_result 的 content，
   * 不走 JSON.stringify(result) 路徑。用於 MCP screenshot 等需要回傳圖片的工具。
   */
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
}

// ── ToolContext（Tool 執行時可用的上下文）────────────────────────────────────

export interface ToolContext {
  accountId: string;
  projectId?: string;
  sessionId: string;
  channelId: string;
  /** CatClaw 事件匯流排（EventEmitter 子集，避免循環引用） */
  eventBus: Pick<EventEmitter, "emit">;
  /**
   * Spawn 深度（0 = 頂層 parent）。
   * 傳入子 agent 時 +1；≥ 2 時 allowSpawn 強制 false（最多 3 層）。
   */
  spawnDepth?: number;
  /**
   * 父 subagent 的 runId（由 spawn-subagent 注入）。
   * 子 agent 呼叫 spawn_subagent 時，registry.create 以此為 parentId，實現 cascade abort。
   */
  parentRunId?: string;
  /** 當前 turn 的 traceId（供子 agent 建立 parentTraceId 關聯） */
  traceId?: string;
  /** Agent ID（spawn_subagent 帶 agent 身份時注入） */
  agentId?: string;
  /** 是否為管理者 agent（由 agent config.json 的 admin flag 決定） */
  isAdmin?: boolean;
}

// ── Tool 介面 ─────────────────────────────────────────────────────────────────

export interface Tool {
  /** 唯一識別名（snake_case） */
  name: string;
  /** 呈現給 LLM 的說明 */
  description: string;
  /** 存取層級：決定哪些角色可用 */
  tier: ToolTier;
  /** 參數 JSON Schema */
  parameters: JsonSchema;
  /**
   * 單次 tool result 最大 token 數上限（超出時截斷，1 token ≈ 4 chars）。
   * 未設定則套用全域預設（8000 tokens）。設 0 表示無限制。
   */
  resultTokenCap?: number;
  /** 單次執行超時毫秒（覆寫全域設定）。0 = 無限制。 */
  timeoutMs?: number;
  /** 是否可安全並行執行（唯讀 tool 設 true，寫入 tool 預設 false） */
  concurrencySafe?: boolean;
  /**
   * Deferred tool：不在 LLM tools 參數中注入完整 schema，
   * 僅在 system prompt 列出名稱+描述。LLM 呼叫 tool_search 後才能使用。
   */
  deferred?: boolean;
  /** 執行函式 */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ── ToolDefinition（傳給 LLM 的格式）────────────────────────────────────────

/** 傳入 LLM stream() opts.tools 的格式（去除 execute 等程式碼欄位） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** 附帶 tier 供 listAvailable 使用（不傳 LLM，由 agent-loop 過濾） */
  tier: ToolTier;
  type: "tool";
  /** Deferred tool：不在 tools 參數注入，僅在 system prompt 列出 */
  deferred?: boolean;
}

/** 將 Tool 轉成 ToolDefinition（傳給 LLM） */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    tier: tool.tier,
    type: "tool",
    ...(tool.deferred ? { deferred: true } : {}),
  };
}
