/**
 * @file providers/base.ts
 * @description LLM Provider 基礎型別與介面定義
 *
 * 設計原則：
 * - 自己寫薄封裝，不依賴任何 LLM SDK
 * - 所有 Provider 實作同一個 LLMProvider 介面，上層零感知
 * - Message 格式遵循 Anthropic Messages API（tool_use 使用 content blocks）
 */

// ── 訊息格式 ─────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant";

/** Tool use content block（assistant → tool call） */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: object;
}

/** Tool result content block（user → tool result） */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Text content block */
export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: MessageRole;
  /** 純文字 or content blocks（tool_use / tool_result） */
  content: string | ContentBlock[];
  /** 此訊息的 token 數（LLM 回傳 or 字元數÷4 估算），CE 用來做精準 cost 計算 */
  tokens?: number;
}

// ── Tool 定義 ─────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  params: object;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── Provider 選項 ─────────────────────────────────────────────────────────────

export interface ProviderOpts {
  systemPrompt?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

// ── 串流事件 ─────────────────────────────────────────────────────────────────

export type ProviderEvent =
  | { type: "text_delta";          text: string }
  | { type: "thinking_delta";      thinking: string }
  | { type: "tool_use";            id: string; name: string; params: object }
  | { type: "tool_result_needed";  stopReason: "tool_use"; toolCalls: ToolCall[] }
  | { type: "done";                stopReason: "end_turn" | "tool_use"; text: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } }
  | { type: "error";               message: string };

/** Provider 回傳的 token 用量（必填，無法取得時用估算值） */
export interface ProviderUsage {
  input: number;
  output: number;
  totalTokens: number;
}

// ── StreamResult ──────────────────────────────────────────────────────────────

export interface StreamResult {
  events: AsyncIterable<ProviderEvent>;
  stopReason: "end_turn" | "tool_use";
  toolCalls: ToolCall[];
  text: string;
  /** 實際 token 用量（無法取得時為估算值，input/output 由字元數 ÷4 估算） */
  usage: ProviderUsage;
}

// ── LLMProvider 介面 ──────────────────────────────────────────────────────────

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsToolUse: boolean;
  readonly maxContextTokens: number;

  stream(messages: Message[], opts?: ProviderOpts): Promise<StreamResult>;

  /** 可選：連線初始化 */
  init?(): Promise<void>;
  /** 可選：清理連線 */
  shutdown?(): Promise<void>;
}

// ── Helper：從 content 提取純文字 ─────────────────────────────────────────────

export function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map(b => b.text)
    .join("");
}

/** 建立 tool_result Message（user role） */
export function makeToolResultMessage(results: ToolResult[]): Message {
  return {
    role: "user",
    content: results.map(r => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    })),
  };
}
