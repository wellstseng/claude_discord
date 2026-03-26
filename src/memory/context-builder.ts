/**
 * @file memory/context-builder.ts
 * @description Context 組裝 — ACT-R 排序 + Budget 分配 + Token Diet
 *
 * R6: ACT-R Activation 排序（B_i ≈ ln(confirmations * t^{-0.5})）
 * R7: Context Budget ≤3000 tokens，三層比例 30/40/30
 * R8: Token Diet：strip metadata fields + ## 行動 / ## 演化日誌 section
 * R13: Section-Level 注入（atom >300 tokens 時分區，保留 top-3 chunks）
 */

import { log } from "../logger.js";
import type { AtomFragment, MemoryLayer } from "./recall.js";

// ── Token 估算 ────────────────────────────────────────────────────────────────

/** 粗估 token 數：CJK≈1/char，ASCII≈0.75/char */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    count += (cp > 0x2E7F) ? 1 : 0.75;
  }
  return Math.ceil(count);
}

// ── ACT-R ─────────────────────────────────────────────────────────────────────

/**
 * 近似 ACT-R activation：B ≈ ln(max(1, confirmations) * max(0.1, days)^{-0.5})
 * 越近期 + 使用次數越多 → 分數越高
 */
function actRScore(frag: AtomFragment): number {
  const { atom, score } = frag;
  const confirmations = Math.max(1, atom.confirmations);

  let days = 30; // 預設 30 天前
  if (atom.lastUsed) {
    const ms = Date.now() - new Date(atom.lastUsed).getTime();
    days = Math.max(0.1, ms / (1000 * 60 * 60 * 24));
  }

  const actR = Math.log(confirmations * Math.pow(days, -0.5));
  // 與原始相似度分數加權
  return actR * 0.3 + score * 0.7;
}

// ── Token Diet ────────────────────────────────────────────────────────────────

const METADATA_PATTERNS = [
  /^-\s+(Scope|Confidence|Trigger|Triggers|Last-used|Confirmations|Related|Description):.*$/gim,
  /^##\s+行動\s*\n[\s\S]*?(?=\n##|\n$|$)/gm,
  /^##\s+演化日誌\s*\n[\s\S]*?(?=\n##|\n$|$)/gm,
];

function tokenDiet(text: string): string {
  let result = text;
  for (const pat of METADATA_PATTERNS) {
    result = result.replace(pat, "");
  }
  // 清理多餘空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// ── Section-Level 注入（R13） ────────────────────────────────────────────────

/**
 * 拆分 atom content 為 sections（以 ## 為分界）
 * 若 atom < 300 tokens → 全量回傳
 */
function splitSections(content: string): string[] {
  const sections = content.split(/(?=^##\s)/gm).filter(s => s.trim());
  return sections;
}

/**
 * 對每個 section 計算與 query 的 keyword overlap（快速粗估，不需 embedding）
 */
function sectionScore(section: string, query: string): number {
  const qWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const sWords = section.toLowerCase().split(/\s+/);
  let hits = 0;
  for (const w of sWords) if (qWords.has(w)) hits++;
  return qWords.size > 0 ? hits / qWords.size : 0;
}

function selectSections(content: string, query: string, budget: number): string {
  const tokens = estimateTokens(content);
  if (tokens <= 300) return content;

  const sections = splitSections(content);
  if (sections.length <= 1) return content;

  // 排分 → 取 top-3
  const scored = sections.map(s => ({ s, score: sectionScore(s, query) }));
  scored.sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3).map(x => x.s);
  const extracted = top3.join("\n").trim();

  // R13 fallback：0 section 命中 OR 提取 ≥70% 原文 → 全量
  const totalExtracted = estimateTokens(extracted);
  if (top3.every(s => sectionScore(s, query) === 0) || totalExtracted >= tokens * 0.7) {
    return content;
  }
  return extracted;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export interface ContextPayload {
  /** 格式化後注入 system prompt 的文字 */
  text: string;
  /** 實際使用 token 數 */
  tokenCount: number;
  /** 三層各自 fragment 數量 */
  layerCounts: Record<MemoryLayer, number>;
  /** BlindSpot 警告字串（若有） */
  blindSpotWarning?: string;
}

/**
 * 從 AtomFragment[] 建立 context payload
 *
 * @param fragments  recall 回傳的 atom 片段
 * @param prompt     原始 prompt（用於 section ranking）
 * @param budget     token 上限（預設 3000）
 * @param ratios     三層比例（預設 30/40/30）
 * @param blindSpot  若 true → 注入 BlindSpot 警告
 */
export function buildContext(
  fragments: AtomFragment[],
  prompt: string,
  budget = 3000,
  ratios: { global: number; project: number; account: number } = { global: 0.3, project: 0.4, account: 0.3 },
  blindSpot = false
): ContextPayload {

  // ── R6: ACT-R 排序 ──
  const sorted = [...fragments].sort((a, b) => actRScore(b) - actRScore(a));

  // ── 按層分組 ──
  const byLayer: Record<MemoryLayer, AtomFragment[]> = { global: [], project: [], account: [] };
  for (const f of sorted) byLayer[f.layer].push(f);

  const layerCounts: Record<MemoryLayer, number> = {
    global:  byLayer.global.length,
    project: byLayer.project.length,
    account: byLayer.account.length,
  };

  const layerBudgets: Record<MemoryLayer, number> = {
    global:  Math.floor(budget * ratios.global),
    project: Math.floor(budget * ratios.project),
    account: Math.floor(budget * ratios.account),
  };

  // ── R8 + R13: Diet + Section-Level 注入，按層填充 ──
  const parts: string[] = [];
  let totalTokens = 0;

  for (const layer of ["global", "project", "account"] as MemoryLayer[]) {
    const layerFrags = byLayer[layer];
    if (!layerFrags.length) continue;

    const layerBudget = layerBudgets[layer];
    let layerTokens = 0;
    const layerParts: string[] = [];

    for (const frag of layerFrags) {
      if (layerTokens >= layerBudget) break;

      // R8: Token Diet
      const dieted = tokenDiet(frag.atom.content);
      // R13: Section selection
      const remaining = layerBudget - layerTokens;
      const selected = selectSections(dieted, prompt, remaining);

      const header = `[${frag.id}]`;
      const block = `${header}\n${selected}`;
      const blockTokens = estimateTokens(block);

      if (layerTokens + blockTokens > layerBudget) {
        // 截斷到剩餘預算
        const chars = Math.floor(remaining * 1.2); // 反推字元
        const truncated = selected.slice(0, chars) + "…";
        layerParts.push(`${header}\n${truncated}`);
        layerTokens = layerBudget;
      } else {
        layerParts.push(block);
        layerTokens += blockTokens;
      }
    }

    if (layerParts.length > 0) {
      parts.push(`### ${layer.charAt(0).toUpperCase() + layer.slice(1)} Memory\n${layerParts.join("\n\n")}`);
      totalTokens += layerTokens;
    }
  }

  let text = parts.join("\n\n---\n\n");

  const blindSpotWarning = blindSpot
    ? "[Guardian:BlindSpot] 記憶中無相關 atom，可能是新領域或 trigger 未覆蓋。"
    : undefined;

  if (blindSpotWarning) {
    text = text ? `${text}\n\n${blindSpotWarning}` : blindSpotWarning;
  }

  log.debug(`[context-builder] ${fragments.length} fragments → ${totalTokens} tokens（budget=${budget}）`);
  return { text, tokenCount: totalTokens, layerCounts, blindSpotWarning };
}
