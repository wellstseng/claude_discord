/**
 * @file providers/ollama.ts
 * @description Ollama Native HTTP Provider — 使用 /api/chat NDJSON 串流
 *
 * 差異 vs openai-compat：
 * - 端點：/api/chat（非 /v1/chat/completions）
 * - 串流格式：NDJSON（每行一個 JSON 物件，非 SSE）
 * - 支援 think 參數（qwen3 等 thinking 模型）
 * - Tool call 無原生 ID → 自動生成 UUID
 *
 * catclaw.json 設定範例：
 *   "providers": {
 *     "ollama": { "type": "ollama", "host": "http://localhost:11434", "model": "qwen3:1.7b" }
 *   }
 */

import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:1.7b";
const DEFAULT_NUM_PREDICT = 4096;

// ── Ollama 訊息格式 ───────────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: object } }>;
}

interface OllamaChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: object } }>;
  };
  done: boolean;
}

// ── OllamaProvider ────────────────────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  supportsToolUse: boolean;
  readonly maxContextTokens = 128_000;

  private host: string;
  private model: string;
  private think: boolean;
  private numPredict: number;

  constructor(id: string, entry: ProviderEntry) {
    this.id = id;
    this.name = `Ollama (${id})`;
    this.host = (entry.host ?? entry.baseUrl ?? DEFAULT_HOST).replace(/\/$/, "");
    this.model = entry.model ?? DEFAULT_MODEL;
    this.think = (entry as Record<string, unknown>)["think"] === true;
    this.numPredict = (entry as Record<string, unknown>)["numPredict"] as number ?? DEFAULT_NUM_PREDICT;
    this.supportsToolUse = (entry as Record<string, unknown>)["supportsToolUse"] !== false;
  }

  // ── 啟動：偵測模型 tool_use 能力 ──────────────────────────────────────────

  async init(): Promise<void> {
    try {
      const resp = await fetch(`${this.host}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: this.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const info = await resp.json() as { capabilities?: string[] };
        const hasTool = info?.capabilities?.includes("tools") ?? false;
        this.supportsToolUse = hasTool;
        if (!hasTool) {
          log.info(`[ollama:${this.id}] 模型 ${this.model} 不支援 tool_use，純文字模式`);
        } else {
          log.debug(`[ollama:${this.id}] 模型 ${this.model} 支援 tool_use`);
        }
      }
    } catch {
      log.debug(`[ollama:${this.id}] 無法偵測模型能力，使用預設值 supportsToolUse=${this.supportsToolUse}`);
    }
  }

  // ── 主要串流方法 ──────────────────────────────────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    const controller = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort());
    }

    const ollamaMessages = convertMessages(messages, opts.systemPrompt);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: true,
      options: { num_predict: opts.maxTokens ?? this.numPredict },
    };

    // think 參數（thinking 模型用）
    if (this.think) body["think"] = true;

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

    if (opts.temperature !== undefined) {
      (body["options"] as Record<string, unknown>)["temperature"] = opts.temperature;
    }

    log.debug(`[ollama:${this.id}] POST /api/chat model=${this.model} msgs=${messages.length} think=${this.think}`);

    const response = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`[ollama:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) throw new Error(`[ollama:${this.id}] 無 response body`);

    // 解析 NDJSON 串流
    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" = "end_turn";
    const toolCalls: ToolCall[] = [];

    await parseNdjsonStream(response.body, (chunk: OllamaChunk) => {
      const content = chunk.message?.content ?? "";

      if (content) {
        events.push({ type: "text_delta", text: content });
        finalText += content;
      }

      // tool_calls 通常在 done:true 的最後一個 chunk
      if (chunk.done && chunk.message?.tool_calls?.length) {
        for (const tc of chunk.message.tool_calls) {
          const call: ToolCall = {
            id: randomUUID(),
            name: tc.function.name,
            params: tc.function.arguments ?? {},
          };
          toolCalls.push(call);
        }
        finalStopReason = "tool_use";
      }

      if (chunk.done) {
        events.push({ type: "done", stopReason: finalStopReason, text: finalText });
      }
    });

    // 若 tool calls 存在則補上 tool_use 事件
    for (const tc of toolCalls) {
      events.splice(events.length - 1, 0, {
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        params: tc.params,
      });
    }

    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    log.debug(`[ollama:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 tools=${toolCalls.length}`);

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
    };
  }
}

// ── 格式轉換：Anthropic → Ollama ─────────────────────────────────────────────

function convertMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
      continue;
    }

    // ── content blocks ──
    const textParts: string[] = [];
    const toolUseCalls: Array<{ id: string; name: string; input: object }> = [];
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseCalls.push({ id: block.id, name: block.name, input: block.input });
      } else if (block.type === "tool_result") {
        toolResults.push({ tool_use_id: block.tool_use_id, content: block.content });
      }
    }

    // assistant：text + tool calls
    if (msg.role === "assistant") {
      const assistantMsg: OllamaMessage = { role: "assistant", content: textParts.join("") };
      if (toolUseCalls.length) {
        assistantMsg.tool_calls = toolUseCalls.map(tc => ({
          function: { name: tc.name, arguments: tc.input },
        }));
      }
      if (assistantMsg.content || assistantMsg.tool_calls) {
        result.push(assistantMsg);
      }
    }

    // user：tool results → role=tool（每個 result 一則訊息）
    if (msg.role === "user") {
      if (textParts.length) {
        result.push({ role: "user", content: textParts.join("") });
      }
      for (const tr of toolResults) {
        result.push({ role: "tool", content: tr.content });
      }
    }
  }

  return result;
}

// ── NDJSON 串流解析 ───────────────────────────────────────────────────────────

async function parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: OllamaChunk) => void,
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
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed) as OllamaChunk;
          onChunk(chunk);
        } catch { /* 忽略非 JSON 行 */ }
      }
    }

    // 緩衝區剩餘
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as OllamaChunk;
        onChunk(chunk);
      } catch { /* 忽略 */ }
    }
  } finally {
    reader.releaseLock();
  }
}
