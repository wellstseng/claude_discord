/**
 * @file memory/extraction-provider.ts
 * @description Extraction provider 抽象層 — 將記憶萃取 LLM 從 Ollama 解耦
 *
 * Provider 實作：
 *   OllamaExtractionProvider   — 走 OllamaClient.generate()
 *   AnthropicExtractionProvider — 走 Anthropic Messages API
 *   OpenAIExtractionProvider    — 走 OpenAI Chat Completions API
 */

import { log } from "../logger.js";
import { recordSuccess as healthRecordSuccess, recordFailure as healthRecordFailure } from "../core/health-monitor.js";
import type { MemoryPipelineConfig, ExtractionProviderType } from "../core/config.js";

// ── Interface ────────────────────────────────────────────────────────────────

export interface ExtractionProvider {
  readonly providerName: ExtractionProviderType;
  readonly modelName: string;
  /** 單一 prompt → 文字回應（用於 extract） */
  generate(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
  /** system + messages → 文字回應（用於 session-memory） */
  chat(messages: Array<{ role: string; content: string }>, opts?: { system?: string; timeout?: number }): Promise<string>;
  /** 啟動時驗證 model 真的可用（fail-loud）。回 ok=false 會被 startup summary 標紅。 */
  verify?(): Promise<{ ok: boolean; error?: string }>;
}

// ── Ollama Provider ──────────────────────────────────────────────────────────

export class OllamaExtractionProvider implements ExtractionProvider {
  readonly providerName = "ollama" as const;

  constructor(
    readonly modelName: string,
    private readonly host?: string,
  ) {}

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    try {
      const result = await client.generate(prompt, {
        model: this.modelName,
        think: "auto",
        numPredict: opts?.maxTokens ?? 2048,
      });
      // 空字串視為 silent fail（OllamaClient 失敗時回傳 ""）
      if (!result) {
        healthRecordFailure("extraction:ollama", `generate 回傳空字串（model ${this.modelName} 不可用）`);
      } else {
        healthRecordSuccess("extraction:ollama");
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      healthRecordFailure("extraction:ollama", msg);
      throw err;
    }
  }

  async chat(messages: Array<{ role: string; content: string }>, opts?: { system?: string; timeout?: number }): Promise<string> {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    try {
      const result = await client.chat(
        messages.map(m => ({ role: m.role as "user" | "system" | "assistant", content: m.content })),
        { system: opts?.system, timeout: opts?.timeout },
      );
      if (!result) {
        healthRecordFailure("extraction:ollama", `chat 回傳空字串（model ${this.modelName} 不可用）`);
      } else {
        healthRecordSuccess("extraction:ollama");
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      healthRecordFailure("extraction:ollama", msg);
      throw err;
    }
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { getOllamaClient } = await import("../ollama/client.js");
      const client = getOllamaClient();
      const results = await client.verifyAllModels();
      const matched = results.find(r => r.llm.model === this.modelName);
      if (!matched) {
        return { ok: false, error: `無 backend 定義 llm model "${this.modelName}"（檢查 catclaw.json ollama.primary.model）` };
      }
      return matched.llm.ok ? { ok: true } : { ok: false, error: matched.llm.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Anthropic Provider ───────────────────────────────────────────────────────

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly providerName = "anthropic" as const;

  constructor(
    readonly modelName: string,
    private readonly apiKey: string,
  ) {}

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    return this.chat([{ role: "user", content: prompt }], { maxTokens: opts?.maxTokens });
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    opts?: { system?: string; timeout?: number; maxTokens?: number },
  ): Promise<string> {
    const url = "https://api.anthropic.com/v1/messages";
    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: opts?.maxTokens ?? 2048,
      messages: messages.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
    };
    if (opts?.system) body.system = opts.system;

    const controller = new AbortController();
    const timer = opts?.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
      return data.content
        .filter(b => b.type === "text" && b.text)
        .map(b => b.text!)
        .join("");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ── OpenAI Provider ──────────────────────────────────────────────────────────

export class OpenAIExtractionProvider implements ExtractionProvider {
  readonly providerName = "openai" as const;

  constructor(
    readonly modelName: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.openai.com/v1",
  ) {}

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    return this.chat([{ role: "user", content: prompt }], { maxTokens: opts?.maxTokens });
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    opts?: { system?: string; timeout?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const msgs: Array<{ role: string; content: string }> = [];
    if (opts?.system) msgs.push({ role: "system", content: opts.system });
    msgs.push(...messages);

    const controller = new AbortController();
    const timer = opts?.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: msgs,
          max_tokens: opts?.maxTokens ?? 2048,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ── Factory + Singleton ──────────────────────────────────────────────────────

let _provider: ExtractionProvider | null = null;

export function createExtractionProvider(cfg: MemoryPipelineConfig["extraction"]): ExtractionProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaExtractionProvider(cfg.model, cfg.host);
    case "anthropic":
      if (!cfg.apiKey) throw new Error("[extraction] Anthropic provider 需要 apiKey");
      return new AnthropicExtractionProvider(cfg.model, cfg.apiKey);
    case "openai":
      if (!cfg.apiKey) throw new Error("[extraction] OpenAI provider 需要 apiKey");
      return new OpenAIExtractionProvider(cfg.model, cfg.apiKey);
    default:
      throw new Error(`[extraction] 不支援的 provider: ${cfg.provider}`);
  }
}

export function initExtractionProvider(cfg: MemoryPipelineConfig["extraction"]): ExtractionProvider {
  _provider = createExtractionProvider(cfg);
  log.info(`[extraction] 初始化 provider: ${_provider.providerName} / ${_provider.modelName}`);
  return _provider;
}

export function getExtractionProvider(): ExtractionProvider {
  if (!_provider) throw new Error("ExtractionProvider 尚未初始化，請先呼叫 initExtractionProvider()");
  return _provider;
}

export function hasExtractionProvider(): boolean {
  return _provider !== null;
}
