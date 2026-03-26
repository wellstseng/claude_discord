/**
 * @file memory/recall.ts
 * @description 三層記憶檢索（global + project + account）
 *
 * 管線（R1-R14）：
 *   Trigger 匹配 → Vector Search → Related-Edge BFS(depth=1) → 合併去重
 * 降級：Ollama / Vector 離線 → 純 keyword（R10）
 * 快取：同頻道 60s 內 Jaccard ≥ 0.7 直接回傳（F7）
 * Blind-Spot：所有層結果為空 → blindSpot=true（R9）
 */

import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../logger.js";
import { readAtom, touchAtom, type Atom } from "./atom.js";
import { loadIndex, matchTriggers } from "./index-manager.js";
import { embedOne } from "../vector/embedding.js";

// ── 型別定義 ─────────────────────────────────────────────────────────────────

export type MemoryLayer = "global" | "project" | "account";

export interface AtomFragment {
  id: string;
  layer: MemoryLayer;
  atom: Atom;
  /** cosine 相似度 or 1.0（trigger hit） */
  score: number;
  matchedBy: "trigger" | "vector" | "related";
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
  /** 降級為純 keyword（Ollama 離線） */
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

/** ~/.catclaw/memory/global → ~/.catclaw/memory */
function memoryRoot(globalDir: string): string {
  return dirname(globalDir);
}

/** 根據 layer + context 推算 namespace（LanceDB 向量搜尋用） */
function layerToNs(layer: MemoryLayer, ctx: RecallContext): string {
  if (layer === "global")  return "global";
  if (layer === "project") return `project/${ctx.projectId ?? "default"}`;
  return `account/${ctx.accountId}`;
}

/** 從 memoryDir 解析 atom 實際路徑（相對/絕對均支援） */
function resolveAtomPath(memoryDir: string, entryPath: string): string {
  if (entryPath.startsWith("/") || entryPath.startsWith("~")) return entryPath;
  return join(memoryDir, entryPath);
}

// ── 單層 recall（trigger + vector） ─────────────────────────────────────────

async function recallLayer(
  prompt: string,
  layer: MemoryLayer,
  memoryDir: string,
  ctx: RecallContext,
  queryVec: number[],
  useVector: boolean,
  opts: { vectorMinScore: number; vectorTopK: number; relatedEdge: boolean }
): Promise<AtomFragment[]> {
  const memMd = join(memoryDir, "MEMORY.md");
  if (!existsSync(memMd)) return [];

  const entries = loadIndex(memMd);
  const fragments: AtomFragment[] = [];
  const seen = new Set<string>();

  // ── R2: Trigger 匹配 ──
  const triggerHits = matchTriggers(prompt, entries);
  for (const e of triggerHits) {
    const atomPath = resolveAtomPath(memoryDir, e.path);
    const atom = readAtom(atomPath);
    if (!atom || seen.has(atom.name)) continue;
    seen.add(atom.name);
    fragments.push({ id: atom.name, layer, atom, score: 1.0, matchedBy: "trigger" });
  }

  // ── R3: Vector Search ──
  if (useVector && queryVec.length > 0) {
    try {
      const { getVectorService } = await import("../vector/lancedb.js");
      const vsvc = getVectorService();
      if (vsvc.isAvailable()) {
        const ns = layerToNs(layer, ctx);
        const results = await vsvc.search(queryVec, {
          namespace: ns,
          topK: opts.vectorTopK,
          minScore: opts.vectorMinScore,
        });
        for (const r of results) {
          if (seen.has(r.id)) continue;
          // 找到 atom 對應的 entry path
          const matchEntry = entries.find(e => e.name === r.id);
          if (!matchEntry) continue;
          const atomPath = resolveAtomPath(memoryDir, matchEntry.path);
          const atom = readAtom(atomPath);
          if (!atom) continue;
          seen.add(atom.name);
          fragments.push({ id: atom.name, layer, atom, score: r.score, matchedBy: "vector" });
        }
      }
    } catch (err) {
      log.debug(`[recall] vector search layer=${layer} 跳過：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── R5: Related-Edge Spreading（BFS depth=1） ──
  if (opts.relatedEdge && fragments.length > 0) {
    const toExpand = [...fragments];
    for (const frag of toExpand) {
      for (const relName of frag.atom.related) {
        if (seen.has(relName)) continue;
        const matchEntry = entries.find(e => e.name === relName);
        if (!matchEntry) continue;
        const atomPath = resolveAtomPath(memoryDir, matchEntry.path);
        const atom = readAtom(atomPath);
        if (!atom) continue;
        seen.add(atom.name);
        fragments.push({ id: atom.name, layer, atom, score: frag.score * 0.8, matchedBy: "related" });
      }
    }
  }

  return fragments;
}

// ── 純 keyword 降級（R10） ────────────────────────────────────────────────────

function recallKeyword(
  prompt: string,
  layer: MemoryLayer,
  memoryDir: string,
  ctx: RecallContext
): AtomFragment[] {
  const memMd = join(memoryDir, "MEMORY.md");
  if (!existsSync(memMd)) return [];

  const entries = loadIndex(memMd);
  const lower = prompt.toLowerCase();
  const scored: Array<{ entry: typeof entries[0]; score: number }> = [];

  for (const e of entries) {
    // 完整命中 description
    const descMatch = (e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase())) ? 1 : 0;
    // trigger 部分命中
    const trigScore = e.triggers.some(t => lower.includes(t.toLowerCase())) ? 0.8 : 0;
    const score = Math.max(descMatch, trigScore);
    if (score > 0) scored.push({ entry: e, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const fragments: AtomFragment[] = [];
  for (const { entry, score } of scored.slice(0, 5)) {
    const atomPath = resolveAtomPath(memoryDir, entry.path);
    const atom = readAtom(atomPath);
    if (atom) fragments.push({ id: atom.name, layer, atom, score, matchedBy: "trigger" });
  }
  return fragments;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 三層記憶檢索主入口
 *
 * @param prompt     使用者 / turn prompt
 * @param ctx        recall 上下文（accountId, projectId, sessionIntent）
 * @param paths      三層記憶目錄路徑
 * @param opts       recall 參數（來自 MemoryConfig.recall）
 */
export async function recall(
  prompt: string,
  ctx: RecallContext,
  paths: RecallPaths,
  opts: {
    triggerMatch: boolean;
    vectorSearch: boolean;
    relatedEdgeSpreading: boolean;
    vectorMinScore: number;
    vectorTopK: number;
  }
): Promise<RecallResult> {
  // ── Cache 檢查 ──
  if (!ctx.skipCache) {
    const cached = getCache(ctx.channelId, prompt);
    if (cached) return cached;
  }

  // ── R1: Intent 分類（簡化：僅影響 log） ──
  log.debug(`[recall] prompt="${prompt.slice(0, 50)}…" intent=${ctx.sessionIntent ?? "general"}`);

  // ── 取得 embedding 向量 ──
  let queryVec: number[] = [];
  let degraded = false;
  if (opts.vectorSearch) {
    try {
      queryVec = await embedOne(prompt);
    } catch {
      log.debug("[recall] embedding 失敗，降級純 keyword");
      degraded = true;
    }
  }

  const useVector = opts.vectorSearch && !degraded && queryVec.length > 0;

  // ── 三層並行查詢 ──
  const layerDefs: Array<{ layer: MemoryLayer; dir: string }> = [
    { layer: "global",  dir: paths.globalDir },
    ...(paths.projectDir ? [{ layer: "project" as MemoryLayer, dir: paths.projectDir }] : []),
    ...(paths.accountDir ? [{ layer: "account" as MemoryLayer, dir: paths.accountDir }] : []),
  ];

  const allFragments: AtomFragment[] = [];

  const results = await Promise.all(layerDefs.map(({ layer, dir }) =>
    degraded
      ? Promise.resolve(recallKeyword(prompt, layer, dir, ctx))
      : recallLayer(prompt, layer, dir, ctx, queryVec, useVector, {
          vectorMinScore: opts.vectorMinScore,
          vectorTopK: opts.vectorTopK,
          relatedEdge: opts.relatedEdgeSpreading,
        })
  ));

  for (const frags of results) allFragments.push(...frags);

  // ── 全域去重（同 atom 只保留最高分） ──
  const best = new Map<string, AtomFragment>();
  for (const f of allFragments) {
    const prev = best.get(f.id);
    if (!prev || f.score > prev.score) best.set(f.id, f);
  }
  const fragments = Array.from(best.values());

  // ── C1: touchAtom（recall 命中 → confirmations +1） ──
  for (const f of fragments) {
    try { touchAtom(f.atom.path); } catch { /* 靜默 */ }
  }

  // ── R9: Blind-Spot 偵測 ──
  const blindSpot = fragments.length === 0;
  if (blindSpot) {
    log.debug("[recall] BlindSpot — 所有層均無命中");
  }

  const result: RecallResult = { fragments, blindSpot, degraded };

  // ── 存入 Cache ──
  setCache(ctx.channelId, prompt, result);

  log.debug(`[recall] 命中 ${fragments.length} 個 atom（degraded=${degraded}）`);
  return result;
}

/** 清除 recall cache（測試用） */
export function clearRecallCache(): void {
  _cache.clear();
}
