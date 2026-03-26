/**
 * @file providers/codex-oauth.ts
 * @description OpenAI Codex OAuth Provider
 *
 * 使用 OpenAI Responses API（/v1/responses），與舊版 /v1/chat/completions 不同。
 * OpenClaw 原始碼確認：推論端點為 https://api.openai.com/v1/responses（WS 或 HTTP SSE）
 *
 * 認證流程：
 * 1. 讀取 ~/.codex/auth.json（或 oauthTokenPath 自訂路徑）
 * 2. 檢查 expires_at → 過期時發 HTTP refresh 請求
 * 3. 更新 auth.json + 用 access_token 作 Bearer header
 *
 * auth.json 格式（OpenAI OAuth 標準格式）：
 * {
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "expires_at": 1234567890,   // epoch seconds
 *   "token_type": "Bearer"
 * }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";

// ── OAuth token JSON 格式 ─────────────────────────────────────────────────────

interface CodexAuthJson {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;    // epoch seconds
  token_type?: string;
}

// ── Responses API 型別 ────────────────────────────────────────────────────────

interface ResponsesInputItem {
  role?: "user" | "assistant";
  type?: string;
  content?: ResponsesContentBlock[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesContentBlock {
  type: "input_text" | "output_text";
  text: string;
}

interface ResponsesChunk {
  type: string;
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { message?: string };
  };
}

// ── 預設值 ────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_PATH = "~/.codex/auth.json";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "openai-codex/gpt-5.4";

// token 提前 5 分鐘刷新
const REFRESH_BUFFER_MS = 5 * 60_000;

// ── CodexOAuthProvider ────────────────────────────────────────────────────────

export class CodexOAuthProvider implements LLMProvider {
  readonly id: string;
  readonly name = "Codex OAuth";
  readonly supportsToolUse = true;
  readonly maxContextTokens = 128_000;

  private baseUrl: string;
  private model: string;
  private tokenPath: string;
  private refreshUrl: string;
  private clientId?: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;  // epoch ms

  constructor(id: string, entry: ProviderEntry) {
    this.id = id;
    this.baseUrl = (entry.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = entry.model ?? DEFAULT_MODEL;

    const rawPath = (entry as unknown as Record<string, unknown>)["oauthTokenPath"] as string | undefined
      ?? DEFAULT_TOKEN_PATH;
    this.tokenPath = rawPath.startsWith("~") ? rawPath.replace("~", homedir()) : resolve(rawPath);

    this.refreshUrl = (entry as unknown as Record<string, unknown>)["oauthRefreshUrl"] as string | undefined
      ?? DEFAULT_REFRESH_URL;

    this.clientId = (entry as unknown as Record<string, unknown>)["oauthClientId"] as string | undefined;
  }

  // ── Token 取得（含自動刷新） ───────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    // 仍有效 → 直接回傳
    if (this.cachedToken && now < this.tokenExpiresAt - REFRESH_BUFFER_MS) {
      return this.cachedToken;
    }

    // 讀取 auth.json
    if (!existsSync(this.tokenPath)) {
      throw new Error(
        `[codex-oauth] auth.json 不存在：${this.tokenPath}\n` +
        `請先安裝 Codex CLI 並執行 codex auth login`
      );
    }

    let auth: CodexAuthJson;
    try {
      auth = JSON.parse(readFileSync(this.tokenPath, "utf-8")) as CodexAuthJson;
    } catch (err) {
      throw new Error(`[codex-oauth] 解析 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    // 尚未過期 → 直接用
    const expiresAtMs = (auth.expires_at ?? 0) * 1000;
    if (auth.access_token && now < expiresAtMs - REFRESH_BUFFER_MS) {
      this.cachedToken = auth.access_token;
      this.tokenExpiresAt = expiresAtMs;
      return auth.access_token;
    }

    // 需要刷新
    if (!auth.refresh_token) {
      throw new Error(`[codex-oauth] token 已過期且無 refresh_token，請重新執行 codex auth login`);
    }

    log.info(`[codex-oauth] token 過期，刷新中...`);
    const newAuth = await this._refresh(auth.refresh_token);

    // 寫回 auth.json
    try {
      writeFileSync(this.tokenPath, JSON.stringify(newAuth, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[codex-oauth] 寫回 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    this.cachedToken = newAuth.access_token;
    this.tokenExpiresAt = (newAuth.expires_at ?? 0) * 1000;
    return newAuth.access_token;
  }

  private async _refresh(refreshToken: string): Promise<CodexAuthJson> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    };
    if (this.clientId) body["client_id"] = this.clientId;

    const resp = await fetch(this.refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`[codex-oauth] refresh 失敗 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as Record<string, unknown>;

    const expiresIn = (data["expires_in"] as number | undefined) ?? 3600;
    return {
      access_token: data["access_token"] as string,
      refresh_token: (data["refresh_token"] as string | undefined) ?? refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: (data["token_type"] as string | undefined) ?? "Bearer",
    };
  }

  // ── 主要串流方法（使用 OpenAI Responses API）──────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort());
    }

    // 轉換 Anthropic 格式 → Responses API input 格式
    const input = convertToResponsesInput(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream: true,
    };

    if (opts.systemPrompt) body["instructions"] = opts.systemPrompt;

    // tool_use 支援
    if (opts.tools?.length) {
      body["tools"] = opts.tools.map(t => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
    }

    if (opts.maxTokens) body["max_output_tokens"] = opts.maxTokens;

    log.debug(`[codex-oauth:${this.id}] POST /v1/responses model=${this.model} msgs=${messages.length}`);

    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`[codex-oauth:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) throw new Error(`[codex-oauth:${this.id}] 無 response body`);

    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" = "end_turn";
    const toolCalls: ToolCall[] = [];

    await parseResponsesApiStream(response.body, (chunk) => {
      const event = processResponsesChunk(chunk, toolCalls);
      if (event) {
        events.push(event);
        if (event.type === "text_delta") finalText += event.text;
        if (event.type === "done") finalStopReason = event.stopReason;
      }
    });

    if (toolCalls.length > 0) finalStopReason = "tool_use";

    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    log.debug(`[codex-oauth:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字`);

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
    };
  }
}

// ── 格式轉換：Anthropic → Responses API input ─────────────────────────────────

function convertToResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: [{
          type: msg.role === "user" ? "input_text" : "output_text",
          text: msg.content,
        }],
      });
      continue;
    }

    for (const block of msg.content) {
      if (block.type === "text") {
        result.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: [{
            type: msg.role === "user" ? "input_text" : "output_text",
            text: block.text,
          }],
        });
      } else if (block.type === "tool_use") {
        result.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        result.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }
  }

  return result;
}

// ── Responses API SSE 解析 ────────────────────────────────────────────────────

async function parseResponsesApiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ResponsesChunk) => void,
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
          const chunk = JSON.parse(data) as ResponsesChunk;
          onChunk(chunk);
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── ResponsesChunk → ProviderEvent ────────────────────────────────────────────

/** function call arguments 累積 buffer（call_id → 累積字串） */
const argBuffers = new Map<string, { name: string; args: string }>();

function processResponsesChunk(chunk: ResponsesChunk, toolCalls: ToolCall[]): ProviderEvent | null {
  switch (chunk.type) {
    // 文字 delta
    case "response.output_text.delta":
      return chunk.delta ? { type: "text_delta", text: chunk.delta } : null;

    // function call 開始（記錄 call_id + name）
    case "response.output_item.added":
      if (chunk.item?.type === "function_call" && chunk.item.call_id) {
        argBuffers.set(chunk.item.call_id, { name: chunk.item.name ?? "", args: "" });
      }
      return null;

    // function call arguments delta
    case "response.function_call_arguments.delta":
      if (chunk.item?.call_id) {
        const buf = argBuffers.get(chunk.item.call_id);
        if (buf && chunk.delta) buf.args += chunk.delta;
      }
      return null;

    // function call 完成
    case "response.output_item.done":
      if (chunk.item?.type === "function_call" && chunk.item.call_id) {
        const buf = argBuffers.get(chunk.item.call_id);
        const argsStr = buf?.args ?? chunk.item.arguments ?? "{}";
        let params: object = {};
        try { params = JSON.parse(argsStr) as object; } catch { /* 忽略 */ }
        toolCalls.push({ id: chunk.item.call_id, name: chunk.item.name ?? "", params });
        argBuffers.delete(chunk.item.call_id);
      }
      return null;

    // 完成
    case "response.completed":
      argBuffers.clear();
      return { type: "done", stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn", text: "" };

    // 失敗
    case "response.failed":
      throw new Error(`[codex-oauth] response.failed: ${chunk.response?.error?.message ?? "unknown"}`);

    default:
      return null;
  }
}
