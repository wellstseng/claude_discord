/**
 * @file vector/embedding.ts
 * @description Embedding 服務 — 文字 → 向量，供 LanceDB 索引與搜尋使用
 *
 * 優先使用 EmbeddingProvider（provider 抽象層），
 * 若 provider 尚未初始化則 fallback 到 OllamaClient 直接呼叫（向後相容）。
 */

import { log } from "../logger.js";
import { hasEmbeddingProvider, getEmbeddingProvider } from "./embedding-provider.js";
import type { EmbedResult } from "./embedding-provider.js";

export type { EmbedResult };

// ── 維度快取（provider 未初始化時的 fallback 用）────────────────────────────────

let _cachedDim = 0;

export function getCachedDim(): number {
  if (hasEmbeddingProvider()) {
    // provider 有自己的 dim cache，但這裡也保持同步
    return _cachedDim;
  }
  return _cachedDim;
}
export function setCachedDim(dim: number): void { _cachedDim = dim; }

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 批次 embed 文字
 * @returns EmbedResult — vectors 為空陣列代表 embedding 不可用（graceful fallback）
 */
export async function embedTexts(
  texts: string[],
  opts: { model?: string; timeout?: number } = {}
): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], dim: _cachedDim };

  // 優先走 provider 抽象層
  if (hasEmbeddingProvider()) {
    const result = await getEmbeddingProvider().embed(texts);
    if (result.dim !== _cachedDim && result.dim > 0) {
      _cachedDim = result.dim;
    }
    return result;
  }

  // fallback：直接呼叫 OllamaClient（向後相容）
  try {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    const vectors = await client.embed(texts, opts);

    if (!vectors.length) {
      log.debug("[embedding] embed 回傳空陣列（Ollama 不可用或無 embedding backend）");
      return { vectors: [], dim: _cachedDim };
    }

    const dim = vectors[0].length;
    if (dim !== _cachedDim) {
      log.debug(`[embedding] 維度更新 ${_cachedDim} → ${dim}`);
      _cachedDim = dim;
    }

    return { vectors, dim };
  } catch (err) {
    log.warn(`[embedding] embedTexts 失敗（graceful skip）：${err instanceof Error ? err.message : String(err)}`);
    return { vectors: [], dim: _cachedDim };
  }
}

/**
 * 單筆 embed（方便用）
 */
export async function embedOne(
  text: string,
  opts: { model?: string; timeout?: number } = {}
): Promise<number[]> {
  const result = await embedTexts([text], opts);
  return result.vectors[0] ?? [];
}

/**
 * 取得 embedding 維度（若尚未快取，發送一筆探測請求）
 * @returns 維度，失敗回傳 0
 */
export async function getEmbeddingDim(opts: { model?: string } = {}): Promise<number> {
  if (hasEmbeddingProvider()) {
    return getEmbeddingProvider().getDimensions();
  }
  if (_cachedDim > 0) return _cachedDim;
  const result = await embedTexts(["test"], opts);
  return result.dim;
}
