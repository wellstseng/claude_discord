/**
 * @file vector/embedding-state.ts
 * @description 追蹤上次完整重建（dropAndSeed）使用的 embedding model + dim
 *
 * 用途：偵測使用者切換 embedding 模型後沒跑 ♻ 完整重建，導致：
 *   - 舊 dim atom 留在 vector DB 變僵屍
 *   - 新 query 用新 model embed → 跟舊向量找不到語意相似 → recall blind spot
 *
 * 寫入時機：engine.dropAndSeed() 成功後（單筆 upsert 不算，因為它不保證整層 namespace 一致）
 * 比對時機：dashboard pipeline 頁面 load → 比對 config 的 model 與此檔 model
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger.js";

export interface EmbeddingMeta {
  model: string;
  dim: number;
  updatedAt: string;
}

const FILE_NAME = "embedding-meta.json";

function metaPath(vectorDbPath: string): string {
  return join(vectorDbPath, FILE_NAME);
}

export function readEmbeddingMeta(vectorDbPath: string): EmbeddingMeta | null {
  const path = metaPath(vectorDbPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as EmbeddingMeta;
  } catch (err) {
    log.warn(`[embedding-state] 讀取失敗 ${path}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function writeEmbeddingMeta(vectorDbPath: string, meta: EmbeddingMeta): void {
  const path = metaPath(vectorDbPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(meta, null, 2), "utf-8");
    log.info(`[embedding-state] 標記當前 embedding：model=${meta.model} dim=${meta.dim}`);
  } catch (err) {
    log.warn(`[embedding-state] 寫入失敗 ${path}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 比對：當前 config 的 model 與上次重建的 model 是否一致 */
export function detectDrift(
  vectorDbPath: string,
  currentModel: string | undefined,
): { drift: boolean; configModel?: string; lastBuiltModel?: string; lastBuiltDim?: number; lastBuiltAt?: string } {
  const meta = readEmbeddingMeta(vectorDbPath);
  if (!currentModel) {
    return { drift: false, configModel: currentModel, lastBuiltModel: meta?.model, lastBuiltDim: meta?.dim, lastBuiltAt: meta?.updatedAt };
  }
  if (!meta) {
    // 從未重建過：無基準 → 不算 drift（讓使用者第一次手動跑 ♻ 完整重建建立基準）
    return { drift: false, configModel: currentModel };
  }
  return {
    drift: meta.model !== currentModel,
    configModel: currentModel,
    lastBuiltModel: meta.model,
    lastBuiltDim: meta.dim,
    lastBuiltAt: meta.updatedAt,
  };
}
