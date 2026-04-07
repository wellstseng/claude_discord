/**
 * @file memory/recall.ts
 * @description 三層記憶檢索（global + project + account）— Vector-First
 *
 * 管線（5 步）：
 *   1. Cache 檢查
 *   2. Keyword 快篩（MEMORY.md trigger match）→ 微調加分用
 *   3. Embed prompt
 *   4. Vector search（各層並行）
 *   5. Merge + dedup + keyword 微調 + touchAtom + cache + return
 *
 * 降級：Ollama / Vector 離線 → keyword fallback + degraded=true
 * 快取：同頻道 60s 內 Jaccard ≥ 0.7 直接回傳
 * Blind-Spot：所有層結果為空 → blindSpot=true
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../logger.js";
import { readAtom, touchAtom } from "./atom.js";
import { loadIndex, matchTriggers } from "./index-manager.js";
import { embedOne } from "../vector/embedding.js";

// ── 型別定義 ─────────────────────────────────────────────────────────────────

export type MemoryLayer = "global" | "project" | "account";

export interface AtomFragment {
  id: string;
  layer: MemoryLayer;
  atom: import("./atom.js").Atom;
  /** cosine 相似度 (0–1) */
  score: number;
  /** 記憶來源：vector=向量搜尋 | keyword=MD fallback */
  matchedBy: "vector" | "keyword";
}

export interface RecallContext {
  accountId: string;
  projectId?: string;
  sessionIntent?: "build" | "debug" | "design" | "recall" | "general";
  /** 用於 recall cache（同頻道相似 prompt 復用） */
  channelId?: string;
  /** 強制跳過 cache */
  skipCache?: boolean;
}

export interface RecallPaths {
  globalDir: string;
  projectDir?: string;
  accountDir?: string;
}

export interface RecallResult {
  fragments: AtomFragment[];
  /** true = 所有層均無命中 → Blind-Spot 警告 */
  blindSpot: boolean;
  /** Ollama / Vector 離線 */
  degraded: boolean;
}

// ── Recall Cache ─────────────────────────────────────────────────────────────

interface CacheEntry {
  prompt: string;
  result: RecallResult;
  ts: number;
}
const _cache = new Map<string, CacheEntry>();
const RECALL_CACHE_TTL_MS = 60_000;
const JACCARD_THRESHOLD   = 0.7;

function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function getCache(channelId: string | undefined, prompt: string): RecallResult | null {
  if (!channelId) return null;
  const entry = _cache.get(channelId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RECALL_CACHE_TTL_MS) { _cache.delete(channelId); return null; }
  if (jaccard(prompt, entry.prompt) >= JACCARD_THRESHOLD) {
    log.debug("[recall] cache 命中");
    return entry.result;
  }
  return null;
}
function setCache(channelId: string | undefined, prompt: string, result: RecallResult) {
  if (channelId) _cache.set(channelId, { prompt, result, ts: Date.now() });
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 根據 layer + context 推算 namespace（LanceDB 向量搜尋用） */
function layerToNs(layer: MemoryLayer, ctx: RecallContext): string {
  if (layer === "global")  return "global";
  if (layer === "project") return `project/${ctx.projectId ?? "default"}`;
  return `account/${ctx.accountId}`;
}

// ── 預設參數 ─────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.55;
const DEFAULT_MAX_RESULTS = 5;

// ── Keyword 快篩微調（加分但不主導排序）────────────────────────────────────
const KEYWORD_BONUS = 0.05;

// ── Keyword Fallback（向量不可用時的兜底路徑） ────────────────────────────────

function keywordFallback(
  keywordHits: Set<string>,
  layerDefs: Array<{ layer: MemoryLayer; dir: string }>,
  maxResults: number,
  channelId: string | undefined,
  prompt: string,
): RecallResult {
  if (keywordHits.size === 0) {
    log.debug("[recall] ⚠ 向量服務不可用，keyword 也無命中 → 空結果");
    const result: RecallResult = { fragments: [], blindSpot: true, degraded: true };
    setCache(channelId, prompt, result);
    return result;
  }

  const fragments: AtomFragment[] = [];
  for (const name of keywordHits) {
    for (const { layer, dir } of layerDefs) {
      const atomPath = join(dir, `${name}.md`);
      if (!existsSync(atomPath)) continue;
      const atom = readAtom(atomPath);
      if (!atom) continue;
      fragments.push({ id: atom.name, layer, atom, score: 0.5, matchedBy: "keyword" });
      break; // 同名 atom 只取第一層命中
    }
  }

  fragments.sort((a, b) => b.score - a.score);
  const topFragments = fragments.slice(0, maxResults);

  for (const f of topFragments) {
    try { touchAtom(f.atom.path); } catch { /* 靜默 */ }
  }

  const blindSpot = topFragments.length === 0;
  log.debug(`[recall] ⚠ 向量服務不可用，改用 keyword fallback（${topFragments.length} 個命中）`);

  const result: RecallResult = { fragments: topFragments, blindSpot, degraded: true };
  setCache(channelId, prompt, result);
  return result;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 三層記憶檢索主入口（Vector + keyword fallback）
 */
export async function recall(
  prompt: string,
  ctx: RecallContext,
  paths: RecallPaths,
  opts: {
    topK?: number;
    minScore?: number;
    maxResults?: number;
    // 保留舊欄位相容（engine.ts 傳入），但不再使用
    triggerMatch?: boolean;
    vectorSearch?: boolean;
    relatedEdgeSpreading?: boolean;
    vectorMinScore?: number;
    vectorTopK?: number;
    llmSelect?: boolean;
    llmSelectMax?: number;
  }
): Promise<RecallResult> {
  // ── Step 1: Cache 檢查 ──
  if (!ctx.skipCache) {
    const cached = getCache(ctx.channelId, prompt);
    if (cached) return cached;
  }

  log.debug(`[recall] prompt="${prompt.slice(0, 50)}…" intent=${ctx.sessionIntent ?? "general"}`);

  // 相容舊 config 欄位
  const topK = opts.topK ?? opts.vectorTopK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? opts.vectorMinScore ?? DEFAULT_MIN_SCORE;
  const maxResults = opts.maxResults ?? opts.llmSelectMax ?? DEFAULT_MAX_RESULTS;

  // ── 各層定義（Step 2~6 共用） ──
  const layerDefs: Array<{ layer: MemoryLayer; dir: string }> = [
    { layer: "global", dir: paths.globalDir },
    ...(paths.projectDir ? [{ layer: "project" as MemoryLayer, dir: paths.projectDir }] : []),
    ...(paths.accountDir ? [{ layer: "account" as MemoryLayer, dir: paths.accountDir }] : []),
  ];

  // ── Step 2: Progressive Retrieval — keyword 快篩 ──
  const keywordHits = new Set<string>();
  for (const { dir } of layerDefs) {
    const indexPath = join(dir, "MEMORY.md");
    const entries = loadIndex(indexPath);
    const matched = matchTriggers(prompt, entries);
    for (const m of matched) keywordHits.add(m.name);
  }
  if (keywordHits.size > 0) {
    log.debug(`[recall] keyword 快篩命中 ${keywordHits.size} 個：${[...keywordHits].join(", ")}`);
  }

  // ── Step 3: Embed prompt ──
  let queryVec: number[];
  try {
    queryVec = await embedOne(prompt);
    if (!queryVec.length) throw new Error("empty embedding");
  } catch (err) {
    log.debug(`[recall] embedding 失敗：${err instanceof Error ? err.message : String(err)}`);
    return keywordFallback(keywordHits, layerDefs, maxResults, ctx.channelId, prompt);
  }

  // ── Step 4: Vector search（各層並行） ──

  let allFragments: AtomFragment[] = [];

  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (!vsvc.isAvailable()) throw new Error("vector service not available");

    const layerResults = await Promise.all(layerDefs.map(async ({ layer, dir }) => {
      const ns = layerToNs(layer, ctx);
      const hits = await vsvc.search(queryVec, { namespace: ns, topK, minScore });
      const fragments: AtomFragment[] = [];

      for (const hit of hits) {
        let atomPath = hit.path;
        if (!atomPath || !existsSync(atomPath)) {
          atomPath = join(dir, `${hit.id}.md`);
        }
        if (!existsSync(atomPath)) continue;

        const atom = readAtom(atomPath);
        if (!atom) continue;
        fragments.push({ id: atom.name, layer, atom, score: hit.score, matchedBy: "vector" });
      }
      return fragments;
    }));

    for (const frags of layerResults) allFragments.push(...frags);
  } catch (err) {
    log.debug(`[recall] vector search 失敗：${err instanceof Error ? err.message : String(err)}`);
    return keywordFallback(keywordHits, layerDefs, maxResults, ctx.channelId, prompt);
  }

  // ── Step 5: Merge + dedup + keyword 微調 + 排序 ──
  const best = new Map<string, AtomFragment>();
  for (const f of allFragments) {
    const prev = best.get(f.id);
    if (!prev || f.score > prev.score) best.set(f.id, f);
  }

  // 純 cosine score + keyword 微調（不使用 ACT-R activation）
  const scored = Array.from(best.values());
  for (const f of scored) {
    if (keywordHits.has(f.id)) f.score += KEYWORD_BONUS;
  }

  scored.sort((a, b) => b.score - a.score);
  const topFragments = scored.slice(0, maxResults);

  // ── touchAtom + cache ──
  for (const f of topFragments) {
    try { touchAtom(f.atom.path); } catch { /* 靜默 */ }
  }

  const blindSpot = topFragments.length === 0;
  if (blindSpot) log.debug("[recall] BlindSpot — 所有層均無命中");

  const result: RecallResult = { fragments: topFragments, blindSpot, degraded: false };
  setCache(ctx.channelId, prompt, result);

  log.debug(`[recall] 命中 ${topFragments.length} 個 atom (kw=${keywordHits.size})`);
  return result;
}

/** 清除 recall cache（測試用） */
export function clearRecallCache(): void {
  _cache.clear();
}
