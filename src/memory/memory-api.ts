/**
 * @file memory/memory-api.ts
 * @description Memory 管理 API — 供 Dashboard 使用的 atom CRUD + recall 測試 + 統計
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readAtom, readAllAtoms, type Atom } from "./atom.js";
import { recall, type RecallContext, type RecallPaths, type RecallResult } from "./recall.js";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AtomSummary {
  name: string;
  confidence: string;
  scope: string;
  confirmations: number;
  lastUsed?: string;
  triggers: string[];
  description: string;
}

export interface MemoryStats {
  totalAtoms: number;
  byConfidence: Record<string, number>;
  byScope: Record<string, number>;
  confirmationDistribution: { range: string; count: number }[];
  topAtoms: AtomSummary[];
  neverRecalled: AtomSummary[];
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function toSummary(atom: Atom): AtomSummary {
  return {
    name: atom.name,
    confidence: atom.confidence,
    scope: atom.scope,
    confirmations: atom.confirmations,
    lastUsed: atom.lastUsed,
    triggers: atom.triggers,
    description: atom.description,
  };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/** 列出指定目錄的所有 atom */
export function listAtoms(dirs: string[]): AtomSummary[] {
  const all: AtomSummary[] = [];
  for (const dir of dirs) {
    for (const atom of readAllAtoms(dir)) {
      all.push(toSummary(atom));
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/** 取得單一 atom 完整內容 */
export function getAtom(dirs: string[], name: string): Atom | null {
  for (const dir of dirs) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return readAtom(path);
  }
  return null;
}

/** 刪除 atom 檔案 */
export function deleteAtom(dirs: string[], name: string): boolean {
  for (const dir of dirs) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        log.info(`[memory-api] 刪除 atom: ${name}`);
        return true;
      } catch (err) {
        log.warn(`[memory-api] 刪除失敗 ${name}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
  }
  return false;
}

/** 測試 recall（skipCache=true）*/
export async function testRecall(
  prompt: string,
  ctx: RecallContext,
  paths: RecallPaths,
): Promise<RecallResult> {
  return recall(prompt, { ...ctx, skipCache: true }, paths, {});
}

/** 統計所有 atom */
export function getStats(dirs: string[]): MemoryStats {
  const allAtoms: Atom[] = [];
  for (const dir of dirs) {
    allAtoms.push(...readAllAtoms(dir));
  }

  const byConfidence: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const a of allAtoms) {
    byConfidence[a.confidence] = (byConfidence[a.confidence] ?? 0) + 1;
    byScope[a.scope] = (byScope[a.scope] ?? 0) + 1;
  }

  // Confirmation 分布
  const ranges = [
    { range: "0", min: 0, max: 0 },
    { range: "1-3", min: 1, max: 3 },
    { range: "4-10", min: 4, max: 10 },
    { range: "11+", min: 11, max: Infinity },
  ];
  const confirmationDistribution = ranges.map(r => ({
    range: r.range,
    count: allAtoms.filter(a => a.confirmations >= r.min && a.confirmations <= r.max).length,
  }));

  // Top 10 by confirmations
  const sorted = [...allAtoms].sort((a, b) => b.confirmations - a.confirmations);
  const topAtoms = sorted.slice(0, 10).map(toSummary);

  // Never recalled (confirmations === 0)
  const neverRecalled = allAtoms
    .filter(a => a.confirmations === 0)
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    totalAtoms: allAtoms.length,
    byConfidence,
    byScope,
    confirmationDistribution,
    topAtoms,
    neverRecalled,
  };
}
