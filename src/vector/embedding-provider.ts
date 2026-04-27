/**
 * @file vector/embedding-provider.ts
 * @description Embedding provider 抽象層 — 將 embedding 從 Ollama 解耦
 *
 * Provider 實作：
 *   OllamaEmbeddingProvider  — 現有邏輯（走 OllamaClient）
 *   GoogleEmbeddingProvider  — gemini-embedding-001 REST API
 *   OpenAIEmbeddingProvider  — stub
 *   VoyageEmbeddingProvider  — stub
 */

import { log } from "../logger.js";
import { getOllamaClient } from "../ollama/client.js";
import { recordSuccess as healthRecordSuccess, recordFailure as healthRecordFailure } from "../core/health-monitor.js";
import type { MemoryPipelineConfig, EmbeddingProviderType } from "../core/config.js";

// ── Interface ────────────────────────────────────────────────────────────────

export interface EmbedResult {
  vectors: number[][];
  dim: number;
}

export interface EmbeddingProvider {
  readonly providerName: EmbeddingProviderType;
  readonly modelName: string;
  embed(texts: string[]): Promise<EmbedResult>;
  getDimensions(): Promise<number>;
  /** 啟動時驗證 model 真的可用（fail-loud）。回 ok=false 會被 startup summary 標紅。 */
  verify?(): Promise<{ ok: boolean; error?: string }>;
}

// ── Ollama Provider ──────────────────────────────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "ollama" as const;
  private _cachedDim = 0;

  constructor(
    readonly modelName: string,
    private readonly host?: string,
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    if (!texts.length) return { vectors: [], dim: this._cachedDim };

    try {
      const client = getOllamaClient();
      const vectors = await client.embed(texts, { model: this.modelName });

      if (!vectors.length) {
        log.debug("[embedding:ollama] embed 回傳空陣列（Ollama 不可用）");
        healthRecordFailure("embedding:ollama", "embed 回傳空陣列（Ollama 不可用或 model 拿不到）");
        return { vectors: [], dim: this._cachedDim };
      }

      const dim = vectors[0].length;
      if (dim !== this._cachedDim) {
        log.debug(`[embedding:ollama] 維度更新 ${this._cachedDim} → ${dim}`);
        this._cachedDim = dim;
      }

      healthRecordSuccess("embedding:ollama");
      return { vectors, dim };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[embedding:ollama] embedTexts 失敗（graceful skip）：${msg}`);
      healthRecordFailure("embedding:ollama", msg);
      return { vectors: [], dim: this._cachedDim };
    }
  }

  async getDimensions(): Promise<number> {
    if (this._cachedDim > 0) return this._cachedDim;
    const result = await this.embed(["test"]);
    return result.dim;
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { getOllamaClient } = await import("../ollama/client.js");
      const client = getOllamaClient();
      const results = await client.verifyAllModels();
      // 找哪個 backend 有定義這個 embedding model
      const matched = results.find(r => r.embedding?.model === this.modelName);
      if (!matched?.embedding) {
        return { ok: false, error: `無 backend 定義 embedding model "${this.modelName}"（檢查 catclaw.json ollama.primary.embeddingModel）` };
      }
      return matched.embedding.ok ? { ok: true } : { ok: false, error: matched.embedding.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Google Provider（gemini-embedding-001）────────────────────────────────────

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "google" as const;
  private _cachedDim = 0;

  constructor(
    readonly modelName: string,
    private readonly apiKey: string,
    private readonly dimensions?: number,
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    if (!texts.length) return { vectors: [], dim: this._cachedDim };

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:batchEmbedContents?key=${this.apiKey}`;
      const body = {
        requests: texts.map(text => ({
          model: `models/${this.modelName}`,
          content: { parts: [{ text }] },
          ...(this.dimensions ? { outputDimensionality: this.dimensions } : {}),
        })),
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Google embedding API ${resp.status}: ${errText}`);
      }

      const data = await resp.json() as { embeddings: Array<{ values: number[] }> };
      const vectors = data.embeddings.map(e => e.values);

      if (vectors.length) {
        this._cachedDim = vectors[0].length;
      }

      healthRecordSuccess("embedding:google");
      return { vectors, dim: this._cachedDim };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[embedding:google] 失敗（graceful skip）：${msg}`);
      healthRecordFailure("embedding:google", msg);
      return { vectors: [], dim: this._cachedDim };
    }
  }

  async getDimensions(): Promise<number> {
    if (this._cachedDim > 0) return this._cachedDim;
    const result = await this.embed(["test"]);
    return result.dim;
  }
}

// ── Stub Providers ───────────────────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "openai" as const;
  constructor(readonly modelName: string) {}
  async embed(_texts: string[]): Promise<EmbedResult> {
    throw new Error("[embedding:openai] Not implemented yet");
  }
  async getDimensions(): Promise<number> {
    throw new Error("[embedding:openai] Not implemented yet");
  }
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "voyage" as const;
  constructor(readonly modelName: string) {}
  async embed(_texts: string[]): Promise<EmbedResult> {
    throw new Error("[embedding:voyage] Not implemented yet");
  }
  async getDimensions(): Promise<number> {
    throw new Error("[embedding:voyage] Not implemented yet");
  }
}

// ── Factory + Singleton ──────────────────────────────────────────────────────

let _provider: EmbeddingProvider | null = null;

export function createEmbeddingProvider(cfg: MemoryPipelineConfig["embedding"]): EmbeddingProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaEmbeddingProvider(cfg.model, cfg.host);
    case "google":
      if (!cfg.apiKey) throw new Error("[embedding] Google provider 需要 apiKey");
      return new GoogleEmbeddingProvider(cfg.model, cfg.apiKey, cfg.dimensions);
    case "openai":
      return new OpenAIEmbeddingProvider(cfg.model);
    case "voyage":
      return new VoyageEmbeddingProvider(cfg.model);
    default:
      throw new Error(`[embedding] 不支援的 provider: ${cfg.provider}`);
  }
}

export function initEmbeddingProvider(cfg: MemoryPipelineConfig["embedding"]): EmbeddingProvider {
  _provider = createEmbeddingProvider(cfg);
  log.info(`[embedding] 初始化 provider: ${_provider.providerName} / ${_provider.modelName}`);
  return _provider;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_provider) throw new Error("EmbeddingProvider 尚未初始化，請先呼叫 initEmbeddingProvider()");
  return _provider;
}

export function hasEmbeddingProvider(): boolean {
  return _provider !== null;
}
