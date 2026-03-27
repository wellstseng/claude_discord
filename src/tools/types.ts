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
}

// ── ToolContext（Tool 執行時可用的上下文）────────────────────────────────────

export interface ToolContext {
  accountId: string;
  projectId?: string;
  sessionId: string;
  channelId: string;
  /** CatClaw 事件匯流排（EventEmitter 子集，避免循環引用） */
  eventBus: Pick<EventEmitter, "emit">;
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
}

/** 將 Tool 轉成 ToolDefinition（傳給 LLM） */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    tier: tool.tier,
    type: "tool",
  };
}
