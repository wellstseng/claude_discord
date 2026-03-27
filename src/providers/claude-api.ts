/**
 * @file providers/claude-api.ts
 * @description Claude API Provider — HTTP POST + SSE stream
 *
 * 自己寫 fetch + SSE 解析，不依賴任何 SDK。
 * 認證支援：
 *   - token → `x-api-key` header
 *   - setupToken → `Authorization: Bearer {token}` + `anthropic-beta: interstitial-1`
 *
 * 未來如需替換底層（@anthropic-ai/sdk 等），只改此檔，介面不變。
 */

import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 8192;

// ── Claude API Provider ───────────────────────────────────────────────────────

export class ClaudeApiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsToolUse = true;
  readonly maxContextTokens = 200_000;

  private token?: string;
  private model: string;
  private thinkingEnabled: boolean;

  constructor(id: string, entry: ProviderEntry) {
    this.id = id;
    this.name = `Claude API (${id})`;
    this.token = entry.token;
    this.model = entry.model ?? DEFAULT_MODEL;
    this.thinkingEnabled = entry.thinking ?? false;

    if (!this.token) {
      log.warn(`[claude-api:${id}] 未設定 token，請在 config 設定 "token": "\${ANTHROPIC_API_KEY}"`);
    }
  }

  // ── SSE 串流 ─────────────────────────────────────────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    const controller = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort());
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": API_VERSION,
    };

    if (this.token) {
      headers["x-api-key"] = this.token;
    } else {
      throw new Error(`[claude-api:${this.id}] 無認證資訊（token 未設定）`);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (opts.systemPrompt) body["system"] = opts.systemPrompt;
    if (opts.tools?.length)  body["tools"] = opts.tools;
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;

    // Extended thinking（需要 interstitial-1 beta header）
    let useThinking = this.thinkingEnabled;
    if (useThinking) {
      headers["anthropic-beta"] = "interstitial-1";
      body["thinking"] = { type: "enabled", budget_tokens: 10000 };
    }

    log.debug(`[claude-api:${this.id}] POST /v1/messages model=${this.model} msgs=${messages.length} thinking=${useThinking}`);

    let response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Thinking level failover：400 且錯誤訊息提到 thinking → 降級重試
    if (!response.ok && response.status === 400) {
      const errText = await response.text().catch(() => "");
      if (useThinking && errText.toLowerCase().includes("thinking")) {
        log.warn(`[claude-api:${this.id}] thinking not supported，降級重試（無 thinking）`);
        useThinking = false;
        delete headers["anthropic-beta"];
        delete body["thinking"];
        response = await fetch(`${API_BASE}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errText2 = await response.text().catch(() => "");
          throw new Error(`[claude-api:${this.id}] HTTP ${response.status}: ${errText2.slice(0, 200)}`);
        }
      } else {
        throw new Error(`[claude-api:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }
    } else if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`[claude-api:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) throw new Error(`[claude-api:${this.id}] 無 response body`);

    // ── 建立 StreamResult（lazy AsyncGenerator） ──
    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" = "end_turn";
    const toolCalls: ToolCall[] = [];

    // 解析 SSE，收集所有事件
    await parseSseStream(response.body, (sseEvent) => {
      const event = processAnthropicEvent(sseEvent, toolCalls);
      if (event) {
        events.push(event);
        if (event.type === "done") {
          finalText = event.text;
          finalStopReason = event.stopReason;
        }
      }
    });

    // 回傳 StreamResult
    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    log.debug(`[claude-api:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字`);

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
    };
  }
}

// ── SSE 解析 ─────────────────────────────────────────────────────────────────

interface SseEvent {
  event?: string;
  data?: string;
}

async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SseEvent = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 行解析
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";  // 最後一段可能不完整

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent.event = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentEvent.data = line.slice(6).trim();
        } else if (line === "") {
          // 空行 = 事件結束
          if (currentEvent.data) onEvent({ ...currentEvent });
          currentEvent = {};
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Anthropic SSE 事件轉換 ────────────────────────────────────────────────────

// tool_use 輸入累積（input_json_delta 是分段 JSON）
const _toolInputAccum = new Map<number, { id: string; name: string; json: string }>();

function processAnthropicEvent(sseEvent: SseEvent, toolCalls: ToolCall[]): ProviderEvent | null {
  if (!sseEvent.data || sseEvent.data === "[DONE]") return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(sseEvent.data);
  } catch {
    return null;
  }

  const type = payload["type"] as string;

  switch (type) {
    case "content_block_start": {
      const index = payload["index"] as number;
      const block = payload["content_block"] as Record<string, unknown>;
      if (block?.["type"] === "tool_use") {
        _toolInputAccum.set(index, {
          id: block["id"] as string,
          name: block["name"] as string,
          json: "",
        });
      }
      return null;
    }

    case "content_block_delta": {
      const index = payload["index"] as number;
      const delta = payload["delta"] as Record<string, unknown>;

      if (delta?.["type"] === "text_delta") {
        return { type: "text_delta", text: delta["text"] as string };
      }
      if (delta?.["type"] === "thinking_delta") {
        return { type: "thinking_delta", thinking: delta["thinking"] as string };
      }
      if (delta?.["type"] === "input_json_delta") {
        const accum = _toolInputAccum.get(index);
        if (accum) accum.json += delta["partial_json"] as string ?? "";
      }
      return null;
    }

    case "content_block_stop": {
      const index = payload["index"] as number;
      const accum = _toolInputAccum.get(index);
      if (accum) {
        let params: object = {};
        try { params = JSON.parse(accum.json || "{}"); } catch { /* ignore */ }
        const call: ToolCall = { id: accum.id, name: accum.name, params };
        toolCalls.push(call);
        _toolInputAccum.delete(index);
        return { type: "tool_use", id: call.id, name: call.name, params: call.params };
      }
      return null;
    }

    case "message_delta": {
      const delta = payload["delta"] as Record<string, unknown>;
      const stopReason = delta?.["stop_reason"] as string;
      if (stopReason === "tool_use") {
        return {
          type: "tool_result_needed",
          stopReason: "tool_use",
          toolCalls: [...toolCalls],
        };
      }
      return null;
    }

    case "message_stop": {
      // 由呼叫端決定 stopReason（已在 message_delta 處理）
      return null;
    }

    case "error": {
      const err = payload["error"] as Record<string, unknown>;
      return { type: "error", message: (err?.["message"] as string) ?? "unknown error" };
    }

    default:
      return null;
  }
}

/** 從 StreamResult.events 累積完整文字（工具函式） */
export async function collectStreamText(result: StreamResult): Promise<string> {
  let text = "";
  for await (const event of result.events) {
    if (event.type === "text_delta") text += event.text;
    if (event.type === "done") text = event.text;
  }
  return text;
}
