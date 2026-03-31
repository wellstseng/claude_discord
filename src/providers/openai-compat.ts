/**
 * @file providers/openai-compat.ts
 * @description OpenAI-Compatible Provider — 對接任何 /v1/chat/completions 端點
 *
 * 適用：Ollama、vLLM、LiteLLM、LMStudio 等 OpenAI 相容 API
 * 認證：apiKey（可選，Bearer header）
 * 串流：Server-Sent Events，data: {...}\n\ndata: [DONE]
 *
 * 對應架構文件第 10 節「openai-compat Provider」
 */

import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:11434";  // Ollama 預設
const DEFAULT_MODEL = "qwen3:1.7b";
const DEFAULT_MAX_TOKENS = 4096;

// ── OpenAI Compat Provider ────────────────────────────────────────────────────

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsToolUse: boolean;
  readonly maxContextTokens = 128_000;

  private baseUrl: string;
  private model: string;
  private token?: string;

  constructor(id: string, entry: ProviderEntry) {
    this.id = id;
    this.name = `OpenAI-Compat (${id})`;
    this.baseUrl = (entry.baseUrl ?? entry.host ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = entry.model ?? DEFAULT_MODEL;
    this.token = entry.token;
    // 預設支援 tool_use（Ollama 新版支援）；可由 config 覆寫
    this.supportsToolUse = (entry as Record<string, unknown>)["supportsToolUse"] !== false;
  }

  // ── 可選：啟動時偵測模型能力 ──────────────────────────────────────────────

  async init(): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: this.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const info = await resp.json() as { capabilities?: string[] };
        const hasTool = info?.capabilities?.includes("tools") ?? false;
        (this as { supportsToolUse: boolean }).supportsToolUse = hasTool;
        if (!hasTool) {
          log.warn(`[openai-compat:${this.id}] 模型 ${this.model} 不支援 tool_use，純文字模式`);
        }
      }
    } catch {
      log.debug(`[openai-compat:${this.id}] 無法偵測模型能力（可能非 Ollama），supportsToolUse=${this.supportsToolUse}`);
    }
  }

  // ── 主要串流方法 ──────────────────────────────────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    const controller = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort());
    }

    // 轉換 Anthropic 格式 → OpenAI 格式
    const openaiMessages = convertMessages(messages, opts.systemPrompt);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: openaiMessages,
      stream: true,
    };

    // tool_use 支援
    if (opts.tools?.length && this.supportsToolUse) {
      body["tools"] = opts.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    log.debug(`[openai-compat:${this.id}] POST /v1/chat/completions model=${this.model} msgs=${messages.length}`);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`[openai-compat:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) throw new Error(`[openai-compat:${this.id}] 無 response body`);

    // 解析 OpenAI SSE 串流
    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" = "end_turn";
    const toolCalls: ToolCall[] = [];
    let usageInput = 0;
    let usageOutput = 0;

    await parseOpenAISseStream(response.body, (chunk) => {
      // 部分端點在串流最後一個 chunk 帶 usage
      if ((chunk as Record<string, unknown>)["usage"]) {
        const u = (chunk as Record<string, unknown>)["usage"] as Record<string, number>;
        usageInput = u["prompt_tokens"] ?? 0;
        usageOutput = u["completion_tokens"] ?? 0;
      }
      const event = processOpenAIChunk(chunk, toolCalls);
      if (event) {
        events.push(event);
        if (event.type === "text_delta") finalText += event.text;
        if (event.type === "done") finalStopReason = event.stopReason;
      }
    });

    // 若有 tool calls → stopReason = tool_use
    if (toolCalls.length > 0) finalStopReason = "tool_use";

    // 端點未回傳 usage 時用估算
    const inputTokens = usageInput > 0 ? usageInput : Math.round(finalText.length / 4);
    const outputTokens = usageOutput > 0 ? usageOutput : Math.round(finalText.length / 4);

    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    log.debug(`[openai-compat:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 inputTokens=${inputTokens} outputTokens=${outputTokens}`);

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
      usage: { input: inputTokens, output: outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }
}

// ── 格式轉換 ──────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * Anthropic Messages 格式 → OpenAI Messages 格式
 * 注意：tool_result 在 OpenAI 格式是 role=tool 訊息
 */
function convertMessages(messages: Message[], systemPrompt?: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
      continue;
    }

    // content blocks
    for (const block of msg.content) {
      if (block.type === "text") {
        result.push({ role: msg.role === "user" ? "user" : "assistant", content: block.text });
      } else if (block.type === "tool_use") {
        result.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          }],
        });
      } else if (block.type === "tool_result") {
        result.push({
          role: "tool",
          content: block.content,
          tool_call_id: block.tool_use_id,
        });
      }
    }
  }

  return result;
}

// ── OpenAI SSE 解析 ──────────────────────────────────────────────────────────

interface OpenAIChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

async function parseOpenAISseStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: OpenAIChunk) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as OpenAIChunk;
          onChunk(chunk);
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Chunk → ProviderEvent ────────────────────────────────────────────────────

/** tool_calls 參數累積 buffer（index → 累積 arguments 字串） */
const argBuffers = new Map<number, { id: string; name: string; args: string }>();

function processOpenAIChunk(chunk: OpenAIChunk, toolCalls: ToolCall[]): ProviderEvent | null {
  const choice = chunk.choices?.[0];
  if (!choice) return null;

  const delta = choice.delta;

  // 文字 delta
  if (delta?.content) {
    return { type: "text_delta", text: delta.content };
  }

  // tool_calls delta（分片累積）
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!argBuffers.has(idx)) {
        argBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
      }
      const buf = argBuffers.get(idx)!;
      if (tc.id) buf.id = tc.id;
      if (tc.function?.name) buf.name += tc.function.name;
      if (tc.function?.arguments) buf.args += tc.function.arguments;
    }
  }

  // 結束
  if (choice.finish_reason) {
    // 完成 tool_calls 收集
    if (choice.finish_reason === "tool_calls") {
      for (const [, buf] of argBuffers) {
        let params: object = {};
        try { params = JSON.parse(buf.args) as object; } catch { /* 忽略 */ }
        toolCalls.push({ id: buf.id, name: buf.name, params });
      }
      argBuffers.clear();
      return { type: "done", stopReason: "tool_use", text: "" };
    }
    argBuffers.clear();
    return { type: "done", stopReason: "end_turn", text: "" };
  }

  return null;
}
