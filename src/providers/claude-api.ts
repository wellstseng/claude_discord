/**
 * @file providers/claude-api.ts
 * @description Claude API Provider — 使用 @mariozechner/pi-ai streamSimpleAnthropic
 *
 * 自動偵測憑證類型（API key / OAuth），pi-ai 負責正確設定 headers。
 * 多憑證：從 {workspace}/agents/default/auth-profiles.json 載入。
 */

import { join } from "node:path";
import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";
import { resolveWorkspaceDirSafe } from "../core/config.js";
import { AuthProfileStore, type CooldownReason } from "./auth-profile-store.js";

// ── pi-ai imports ─────────────────────────────────────────────────────────────

import { streamSimpleAnthropic } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type {
  Context as PiContext,
  Message as PiMessage,
  UserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall as PiToolCall,
  AssistantMessageEvent,
  Tool as PiTool,
} from "@mariozechner/pi-ai";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 8192;

/** 短名稱別名 → 完整 model ID */
const MODEL_ALIASES: Record<string, string> = {
  "claude-haiku":  "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus":   "claude-opus-4-6",
};

function resolveModelId(id: string): string {
  return MODEL_ALIASES[id] ?? id;
}

// ── 型別轉換：catclaw Message → pi-ai Message ─────────────────────────────────

/** 建立 tool_use_id → toolName 的反查表（從歷史 assistant 訊息） */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          map.set(block.id, block.name);
        }
      }
    }
  }
  return map;
}

function toPiMessages(messages: Message[]): PiMessage[] {
  const toolNameMap = buildToolNameMap(messages);
  const result: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        // 純文字 user 訊息
        result.push({ role: "user", content: msg.content, timestamp: 0 } satisfies UserMessage);
      } else {
        // 有 content blocks：分離 tool_result、文字、圖片
        const toolResults = msg.content.filter(b => b.type === "tool_result");
        const textBlocks  = msg.content.filter(b => b.type === "text");
        const imageBlocks = msg.content.filter(b => b.type === "image");

        for (const b of toolResults) {
          if (b.type !== "tool_result") continue;
          // rich content blocks（圖片 + 文字混合）or 純文字
          let trContent: ToolResultMessage["content"];
          if (Array.isArray(b.content)) {
            trContent = b.content.map(block => {
              const raw = block as Record<string, unknown>;
              if (raw["type"] === "image") {
                return { type: "image" as const, data: String(raw["data"] ?? ""), mimeType: String(raw["mimeType"] ?? "image/png") };
              }
              return { type: "text" as const, text: String(raw["text"] ?? JSON.stringify(raw)) };
            });
          } else {
            trContent = [{ type: "text", text: b.content }];
          }
          result.push({
            role: "toolResult",
            toolCallId: b.tool_use_id,
            toolName: toolNameMap.get(b.tool_use_id) ?? "unknown",
            content: trContent,
            isError: b.is_error ?? false,
            timestamp: 0,
          } satisfies ToolResultMessage);
        }
        // 文字 + 圖片合併為一條 user 訊息
        if (textBlocks.length > 0 || imageBlocks.length > 0) {
          type PiUserContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
          const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
          for (const b of textBlocks) {
            if (b.type === "text") parts.push({ type: "text", text: b.text });
          }
          for (const b of imageBlocks) {
            if (b.type === "image") parts.push({ type: "image", data: b.data, mimeType: b.mimeType });
          }
          const content: PiUserContent = parts.length === 1 && parts[0]!.type === "text"
            ? parts[0]!.text
            : parts;
          result.push({ role: "user", content, timestamp: 0 } as UserMessage);
        }
      }
    } else if (msg.role === "assistant") {
      // assistant 訊息
      const content: PiAssistantMessage["content"] = [];
      const rawContent = typeof msg.content === "string"
        ? [{ type: "text" as const, text: msg.content }]
        : msg.content;

      for (const block of rawContent) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text } satisfies TextContent);
        } else if (block.type === "tool_use") {
          content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          } satisfies PiToolCall);
        }
      }

      result.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: DEFAULT_MODEL,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      } satisfies PiAssistantMessage);
    }
  }
  return result;
}

/** catclaw ToolDefinition → pi-ai Tool */
function toPiTools(tools: ProviderOpts["tools"]): PiTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    // 用 Type.Unsafe 包裝既有 JSON Schema，避免重新建構 typebox schema
    parameters: Type.Unsafe(t.input_schema),
  }));
}

// ── HTTP 錯誤分類 ─────────────────────────────────────────────────────────────

function classifyError(errorMessage: string): CooldownReason | null {
  const msg = errorMessage.toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit"))  return "rate_limit";
  if (msg.includes("503") || msg.includes("overload"))    return "overloaded";
  if (msg.includes("402") || msg.includes("billing") || msg.includes("credit")) return "billing";
  if (msg.includes("401") || msg.includes("403") || msg.includes("auth"))       return "auth";
  return null;
}

// ── ClaudeApiProvider ─────────────────────────────────────────────────────────

export class ClaudeApiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsToolUse = true;
  readonly maxContextTokens = 200_000;

  private token?: string;
  readonly modelId: string;
  private _store?: AuthProfileStore;

  constructor(id: string, entry: ProviderEntry) {
    this.id = id;
    this.name = `Claude API (${id})`;
    this.modelId = resolveModelId(entry.model ?? DEFAULT_MODEL);

    const mode = entry.mode;
    const forceApi = mode === "api";    // API key 模式（sk-ant-api...）
    const forceToken = mode === "token"; // OAuth token 模式（sk-ant-oat...，auth-profile.json）

    if (forceApi) {
      // 明確指定 api 模式：直接用 token 欄位（API key），不初始化 auth-profile store
      this.token = entry.token;
      if (!this.token) log.warn(`[claude:${id}] mode=api 但未設定 token`);
      log.debug(`[claude:${id}] api 模式（API key）`);
      return;
    }

    // token（OAuth）模式 / 自動偵測：從 auth-profile store 載入
    const workspaceDir = resolveWorkspaceDirSafe();
    const authProfilePath = join(workspaceDir, "agents", "default", "auth-profile.json");
    this._store = new AuthProfileStore(authProfilePath);
    this._store.load();

    if (this._store.getAvailableCount("anthropic") > 0) {
      log.info(`[claude:${id}] token 模式（OAuth），${this._store.getAvailableCount("anthropic")} 組憑證可用`);
    } else if (forceToken) {
      log.warn(`[claude:${id}] mode=token 但 ${authProfilePath} 無有效憑證`);
    } else {
      // 自動偵測：oauth store 空 → fallback to API key
      this.token = entry.token;
      if (!this.token) {
        log.warn(`[claude:${id}] 憑證檔 ${authProfilePath} 為空且未設定 token`);
      }
    }
  }

  /** 取得目前可用憑證數 */
  getAvailableCredentialCount(): number {
    return this._store?.getAvailableCount("anthropic") ?? (this.token ? 1 : 0);
  }

  /** 取得最快可用時間（所有憑證 cooldown 中時） */
  getEarliestAvailableTime(): number | null {
    return this._store?.getEarliestAvailableTime("anthropic") ?? null;
  }

  // ── stream ────────────────────────────────────────────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    // ── 憑證選取 ──────────────────────────────────────────────────────────────
    let credential: string;
    let activeProfileId: string | undefined;

    const storeProfile = this._store?.pickForProvider("anthropic") ?? null;
    if (storeProfile) {
      credential = storeProfile.apiKey;
      activeProfileId = storeProfile.profileId;
    } else if (this._store && Object.keys(this._store.listAll()).length > 0) {
      const availAt = this._store.getEarliestAvailableTime("anthropic");
      const waitMsg = availAt
        ? `最快 ${Math.ceil((availAt - Date.now()) / 60000)} 分鐘後可用`
        : "所有憑證已永久停用，請聯絡管理員";
      throw new Error(`[claude:${this.id}] 所有 API 憑證都在 cooldown 中（${waitMsg}）`);
    } else if (this.token) {
      credential = this.token;
    } else {
      throw new Error(`[claude:${this.id}] 無認證資訊`);
    }

    // ── pi-ai 呼叫 ────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = getModel("anthropic", this.modelId as any);
    const context: PiContext = {
      systemPrompt: opts.systemPrompt,
      messages: toPiMessages(messages),
      tools: toPiTools(opts.tools),
    };

    // 粗估 input tokens：(所有訊息字元 + system prompt 字元) / 4 + tool 定義 ~300 tokens 各
    const estInputTokens = Math.round(
      (JSON.stringify(context.messages).length + (opts.systemPrompt?.length ?? 0)) / 4
      + (context.tools?.length ?? 0) * 300
    );
    // 擷取最後一條 user 訊息做摘要
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content as Array<{type:string;text?:string}>).filter(b => b.type === "text").map(b => b.text ?? "").join(" ")
        : "";
    log.debug(`[claude:${this.id}] POST model=${this.modelId} msgs=${messages.length} tools=${context.tools?.length ?? 0} profile=${activeProfileId ?? "token"} ~inputTokens=${estInputTokens} lastUser="${lastUserText}"`);

    // ── Debug Dump：偵測到 playwright tool 時 dump 完整 payload 到 /tmp 供排查空回應 ──
    // （一次性診斷，找到根因後移除）
    if (context.tools?.some(t => t.name.includes("playwright"))) {
      try {
        const fs = await import("node:fs");
        const dumpPath = `/tmp/catclaw-claude-payload-${Date.now()}.json`;
        fs.writeFileSync(dumpPath, JSON.stringify({
          model: this.modelId,
          systemPromptLen: context.systemPrompt?.length ?? 0,
          systemPromptPreview: context.systemPrompt?.slice(-2000),
          messagesCount: context.messages.length,
          messages: context.messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string"
              ? { type: "string", preview: (m.content as string).slice(0, 500) }
              : { type: "blocks", blocks: (m.content as unknown[]).map(b => {
                  const block = b as Record<string, unknown>;
                  return { type: block.type, preview: JSON.stringify(b).slice(0, 300) };
                }) },
          })),
          toolsCount: context.tools.length,
          tools: context.tools.map(t => ({ name: t.name, schemaKeys: Object.keys((t.parameters ?? {}) as object) })),
        }, null, 2));
        log.warn(`[claude:${this.id}] 🔍 DEBUG DUMP: ${dumpPath}`);
      } catch (e) {
        log.warn(`[claude:${this.id}] debug dump failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // ── 事件收集 ──────────────────────────────────────────────────────────────
    const events: ProviderEvent[] = [];
    const toolCalls: ToolCall[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
    let finalUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined;

    try {
      const stream = streamSimpleAnthropic(model, context, {
        apiKey: credential,
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: opts.abortSignal,
        temperature: opts.temperature,
        cacheRetention: "long",
        ...(opts.thinking ? { reasoning: opts.thinking } : {}),
      });

      let rawEventCount = 0;
      const rawEventTypes: string[] = [];
      for await (const event of stream) {
        rawEventCount++;
        rawEventTypes.push(event.type);
        const pev = this._convertEvent(event, toolCalls);
        if (pev) events.push(pev);
      }

      // 最後一個事件帶最終文字和 stopReason
      const lastEvent = events[events.length - 1];
      if (lastEvent?.type === "done") {
        finalText = lastEvent.text;
        finalStopReason = lastEvent.stopReason;
        finalUsage = lastEvent.usage;
      }

      // Debug：若 events 陣列為空（導致 estimated fallback），log 實際收到的 raw events
      if (events.length === 0) {
        log.warn(`[claude:${this.id}] ⚠ 收到 0 個 converted events，raw=${rawEventCount} rawTypes=[${rawEventTypes.join(",")}] — 可能 stream 靜默失敗`);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[claude:${this.id}] 呼叫失敗 profile=${activeProfileId ?? "token"}: ${msg}`);

      // Cooldown 判斷
      if (activeProfileId && this._store) {
        const reason = classifyError(msg);
        if (reason) this._store.setCooldown(activeProfileId, reason);
      }

      throw new Error(`[claude:${this.id}] ${msg}`);
    }

    const est = Math.round(finalText.length / 4);
    const resolvedUsage: import("./base.js").ProviderUsage = finalUsage
      ? {
          input: finalUsage.input, output: finalUsage.output, totalTokens: finalUsage.totalTokens,
          cacheRead: finalUsage.cacheRead || undefined,
          cacheWrite: finalUsage.cacheWrite || undefined,
          model: this.modelId,
          providerType: "claude",
        }
      : { input: 0, output: est, totalTokens: est, model: this.modelId, providerType: "claude", estimated: true };

    if (finalUsage) {
      log.debug(`[claude:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 inputTokens=${finalUsage.input} outputTokens=${finalUsage.output} cacheRead=${finalUsage.cacheRead} cacheWrite=${finalUsage.cacheWrite} total=${finalUsage.totalTokens}`);
    } else {
      log.debug(`[claude:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 ~outputTokens=${resolvedUsage.output}`);
    }

    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
      usage: resolvedUsage,
    };
  }

  // ── pi-ai event → catclaw ProviderEvent ──────────────────────────────────────

  private _convertEvent(event: AssistantMessageEvent, toolCalls: ToolCall[]): ProviderEvent | null {
    switch (event.type) {
      case "text_delta":
        return { type: "text_delta", text: event.delta };

      case "thinking_delta":
        return { type: "thinking_delta", thinking: event.delta };

      case "toolcall_end": {
        const tc = event.toolCall;
        const call: ToolCall = { id: tc.id, name: tc.name, params: tc.arguments };
        toolCalls.push(call);
        return { type: "tool_use", id: call.id, name: call.name, params: call.params };
      }

      case "done": {
        const msg = event.message;
        const sr = msg.stopReason === "toolUse" ? "tool_use"
          : msg.stopReason === "length" ? "max_tokens"
          : "end_turn";
        const text = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map(c => c.text).join("");
        return { type: "done", stopReason: sr, text, usage: msg.usage };
      }

      case "error":
        return { type: "error", message: event.error.errorMessage ?? "unknown error" };

      default:
        return null;
    }
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
