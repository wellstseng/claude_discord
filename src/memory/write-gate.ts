/**
 * @file memory/write-gate.ts
 * @description Write Gate — 品質閘門，防止重複/注入知識持久化
 *
 * Q1: 向量相似度 ≥ 0.80 → 跳過（dedup）
 * Q2: 使用者明確說「記住」→ 跳過 gate
 * Q4: Prompt Injection 過濾
 */

import { log } from "../logger.js";

// ── Prompt Injection 過濾（Q4） ───────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions?/i,
  /forget\s+(everything|all|your|previous)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /pretend\s+(you|to)\s+(are|be)/i,
  /act\s+as\s+(if\s+you\s+are|a\s+)/i,
  /your\s+new\s+(role|persona|instruction)/i,
  /system\s+prompt/i,
  /<\|?(im_start|im_end|user|assistant|system)\|?>/i,
  /\[INST\]|\[\/INST\]/,
  /###\s+(Human|Assistant|System):/,
];

export function hasInjectionPattern(text: string): boolean {
  return INJECTION_PATTERNS.some(pat => pat.test(text));
}

// ── 主要 Write Gate 邏輯 ──────────────────────────────────────────────────────

export interface WriteGateOpts {
  /** 若 true，跳過向量 dedup（使用者明確說「記住」） */
  bypass?: boolean;
  /** dedup 向量相似度門檻（預設 0.80） */
  dedupThreshold?: number;
  /** 向量搜尋 namespace */
  namespace?: string;
}

export interface WriteGateResult {
  allowed: boolean;
  reason: "bypass" | "injection" | "duplicate" | "ok";
  similarity?: number;
}

/**
 * 檢查知識項目是否通過 write gate
 *
 * @param content   要寫入的知識文字
 * @param namespace 向量搜尋 namespace（用於 dedup 比對）
 * @param opts      選項
 */
export async function checkWriteGate(
  content: string,
  namespace: string,
  opts: WriteGateOpts = {}
): Promise<WriteGateResult> {
  const threshold = opts.dedupThreshold ?? 0.80;

  // ── Q2: bypass（使用者明確指示） ──
  if (opts.bypass) {
    log.debug("[write-gate] bypass — 跳過 gate");
    return { allowed: true, reason: "bypass" };
  }

  // ── Q4: Prompt Injection 過濾 ──
  if (hasInjectionPattern(content)) {
    log.warn("[write-gate] 阻擋疑似 prompt injection");
    return { allowed: false, reason: "injection" };
  }

  // ── Q1: 向量相似度 dedup ──
  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (vsvc.isAvailable()) {
      const results = await vsvc.search(content, {
        namespace,
        topK: 1,
        minScore: threshold,
      });
      if (results.length > 0 && results[0].score >= threshold) {
        log.debug(`[write-gate] dedup — 相似度 ${results[0].score.toFixed(3)} ≥ ${threshold}，跳過`);
        return { allowed: false, reason: "duplicate", similarity: results[0].score };
      }
    }
  } catch (err) {
    // Vector service 不可用 → 放行（graceful）
    log.debug(`[write-gate] vector 不可用，放行：${err instanceof Error ? err.message : String(err)}`);
  }

  return { allowed: true, reason: "ok" };
}
