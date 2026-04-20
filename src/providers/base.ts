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
  /** 純文字 or rich content blocks（含圖片時用 array） */
  content: string | Array<{ type: string; [key: string]: unknown }>;
  is_error?: boolean;
}

/** Text content block */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Image content block（vision input） */
export interface ImageBlock {
  type: "image";
  /** base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/png", "image/jpeg", "image/gif", "image/webp" */
  mimeType: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface Message {
  role: MessageRole;
  /** 純文字 or content blocks（tool_use / tool_result） */
  content: string | ContentBlock[];
  /** 此訊息的 token 數（LLM 回傳 or 字元數÷4 估算），CE 用來做精準 cost 計算 */
  tokens?: number;
  // ── CE metadata ──
  /** 所屬 turn index（用於計算衰減年齡） */
  turnIndex?: number;
  /** 建立時間戳（用於 time-aware 衰減） */
  timestamp?: number;
  /** 壓縮等級 0=原始, 1=精簡, 2=核心, 3=stub */
  compressionLevel?: number;
  /** 壓縮前的原始 token 數 */
  originalTokens?: number;
  /** 執行壓縮的策略名稱 */
  compressedBy?: string;
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
  /** 純文字 or rich content blocks（含圖片時用 array） */
  content: string | Array<{ type: string; [key: string]: unknown }>;
  is_error?: boolean;
}

// ── Provider 選項 ─────────────────────────────────────────────────────────────

export interface ProviderOpts {
  systemPrompt?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Extended thinking level（Anthropic）。
   * 傳入後 LLM 會輸出 thinking_delta 事件。
   * 值：minimal | low | medium | high | xhigh
   */
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

// ── 串流事件 ─────────────────────────────────────────────────────────────────

export type ProviderEvent =
  | { type: "text_delta";          text: string }
  | { type: "thinking_delta";      thinking: string }
  | { type: "tool_use";            id: string; name: string; params: object }
  | { type: "tool_result_needed";  stopReason: "tool_use"; toolCalls: ToolCall[] }
  | { type: "done";                stopReason: "end_turn" | "tool_use" | "max_tokens"; text: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } }
  | { type: "error";               message: string };

/** Provider 回傳的 token 用量（必填，無法取得時用估算值） */
export interface ProviderUsage {
  input: number;
  output: number;
  totalTokens: number;
  /** prompt cache 建立消耗（Claude 等支援 cache 的 provider） */
  cacheWrite?: number;
  /** prompt cache 讀取（單價較低） */
  cacheRead?: number;
  /** 使用的模型 ID */
  model?: string;
  /** provider 類型識別（claude / ollama / openai-compat / codex-oauth） */
  providerType?: string;
  /** 是否為估算值（provider 未回傳 usage 時為 true） */
  estimated?: boolean;
}

// ── StreamResult ──────────────────────────────────────────────────────────────

export interface StreamResult {
  events: AsyncIterable<ProviderEvent>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
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
  /** 可選：主要模型 ID（用於 /status 顯示） */
  readonly modelId?: string;

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
