/**
 * @file memory/extract.ts
 * @description 知識萃取 — 從 assistant response 提取可操作知識
 *
 * E1: 逐輪增量萃取（turn:after）— minNewChars 500
 * E2: 全量掃描（session:idle / platform:shutdown）
 * E3: 萃取 prompt + 6 知識類型 + JSON format
 * E4: 情境感知（session intent 調整 prompt）
 * E5: 跨 session 觀察（vector search top_k=5, min_score=0.75）
 * E6: 結果一律 [臨]
 * E7: fire-and-forget queue（不阻塞 turn:after）
 * E8: 分流（公司→全域 / 專案→專案 / 個人→個人 / 不確定→個人）
 */

import { log } from "../logger.js";
import type { MemoryLayer } from "./recall.js";

// ── 知識類型 ─────────────────────────────────────────────────────────────────

export type KnowledgeType =
  | "factual"        // 事實性知識
  | "architectural"  // 架構決策
  | "procedural"     // 操作步驟
  | "decision"       // 決策理由
  | "pitfall"        // 陷阱 / 錯誤
  | "preference";    // 使用者偏好

export type KnowledgeTier =
  | "company"   // 公司/團隊層 → 全域
  | "project"   // 專案層
  | "personal"  // 個人層
  | "unknown";  // 不確定 → 個人

export interface KnowledgeItem {
  type: KnowledgeType;
  tier: KnowledgeTier;
  content: string;
  triggers: string[];
  /** 分流目標 layer */
  targetLayer: MemoryLayer;
  /** 萃取日期（ISO 8601） */
  extractedAt: string;
}

// ── 萃取 Prompt ───────────────────────────────────────────────────────────────

const INTENT_EMPHASIS: Record<string, string> = {
  build:   "重點萃取：架構決策、API 設計、模組邊界",
  debug:   "重點萃取：錯誤模式、陷阱、root cause 分析",
  design:  "重點萃取：架構原則、設計取捨、最佳實踐",
  recall:  "重點萃取：記憶引用邏輯、知識組織方式",
  general: "均衡萃取所有類型",
};

function buildExtractPrompt(
  response: string,
  intent: string,
  crossSessionContext?: string
): string {
  const emphasis = INTENT_EMPHASIS[intent] ?? INTENT_EMPHASIS.general;
  const crossCtx = crossSessionContext
    ? `\n# 已有類似知識（避免重複）\n${crossSessionContext}\n`
    : "";

  return `知識萃取：從以下回應提取可操作、長期有價值的片段（0-5 項）。${emphasis}
類型：factual|architectural|procedural|decision|pitfall|preference
層級：company→全域 / project→專案 / personal|unknown→個人${crossCtx}
# 回應
${response.slice(0, 20000)}

輸出 JSON array（僅 JSON）：
[{"type":"factual","tier":"project","content":"具體內容1-3句","triggers":["詞1"]}]`;
}

// ── 分流邏輯（E8） ────────────────────────────────────────────────────────────

function resolveTargetLayer(tier: KnowledgeTier): MemoryLayer {
  switch (tier) {
    case "company": return "global";
    case "project": return "project";
    case "personal":
    case "unknown":
    default:        return "account";
  }
}

// ── 跨 Session 觀察（E5） ────────────────────────────────────────────────────

async function getCrossSessionContext(
  content: string,
  namespace: string
): Promise<string | undefined> {
  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (!vsvc.isAvailable()) return undefined;

    const results = await vsvc.search(content, {
      namespace,
      topK: 5,
      minScore: 0.75,
    });
    if (!results.length) return undefined;
    return results.map(r => `- ${r.text.slice(0, 100)}`).join("\n");
  } catch {
    return undefined;
  }
}

// ── 解析 LLM JSON 輸出 ────────────────────────────────────────────────────────

function parseExtractResult(raw: string): KnowledgeItem[] {
  // 找 JSON array
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as Array<{
      type?: string; tier?: string; content?: string; triggers?: string[];
    }>;
    if (!Array.isArray(parsed)) return [];

    const VALID_TYPES = new Set(["factual", "architectural", "procedural", "decision", "pitfall", "preference"]);
    const VALID_TIERS = new Set(["company", "project", "personal", "unknown"]);

    return parsed
      .filter(item => item.content && item.content.trim().length > 10)
      .map(item => {
        const type = (VALID_TYPES.has(item.type ?? "") ? item.type : "factual") as KnowledgeType;
        const tier = (VALID_TIERS.has(item.tier ?? "") ? item.tier : "unknown") as KnowledgeTier;
        return {
          type,
          tier,
          content: item.content!.trim(),
          triggers: Array.isArray(item.triggers) ? item.triggers.map(t => String(t)) : [],
          targetLayer: resolveTargetLayer(tier),
          extractedAt: new Date().toISOString(),
        };
      });
  } catch {
    return [];
  }
}

// ── Fire-and-Forget Queue ─────────────────────────────────────────────────────

interface ExtractTask {
  response: string;
  accountId: string;
  projectId?: string;
  intent: string;
  namespace: string;
  maxItems: number;
  resolve: (items: KnowledgeItem[]) => void;
  reject: (err: unknown) => void;
}

let _queue: ExtractTask[] = [];
let _running = false;
const EXTRACT_COOLDOWN_MS = 120_000;
// per-session cooldown（key = namespace），避免全域鎖阻塞無關 session
const _cooldownMap = new Map<string, number>();

async function runQueue() {
  if (_running) return;
  _running = true;
  while (_queue.length > 0) {
    const task = _queue.shift()!;
    try {
      const items = await doExtract(task);
      task.resolve(items);
    } catch (err) {
      task.reject(err);
    }
  }
  _running = false;
}

async function doExtract(task: ExtractTask): Promise<KnowledgeItem[]> {
  // Pre-LLM 相似度跳過：輸入 embedding 高度相似已有知識 → 直接跳過 LLM 呼叫
  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (vsvc.isAvailable()) {
      const hits = await vsvc.search(task.response.slice(0, 500), {
        namespace: task.namespace,
        topK: 1,
        minScore: 0.92,
      });
      if (hits.length > 0 && hits[0].score >= 0.92) {
        log.debug(`[extract] 跳過 LLM — 輸入相似度 ${hits[0].score.toFixed(3)} ≥ 0.92`);
        return [];
      }
    }
  } catch { /* vector 不可用，繼續 */ }

  // 跨 session 觀察（E5）
  const crossCtx = await getCrossSessionContext(task.response.slice(0, 500), task.namespace);

  // Ollama generate（最多 2048 token 輸出，0-5 項 JSON 足夠）
  let raw: string;
  try {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    const prompt = buildExtractPrompt(task.response, task.intent, crossCtx);
    raw = await client.generate(prompt, { think: "auto", numPredict: 2048 });
  } catch (err) {
    log.debug(`[extract] Ollama 不可用，跳過：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const items = parseExtractResult(raw);
  log.debug(`[extract] 萃取 ${items.length} 項`);
  return items.slice(0, task.maxItems);
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export interface ExtractOpts {
  accountId: string;
  projectId?: string;
  sessionIntent?: string;
  /** 向量搜尋 namespace（用於跨 session 觀察） */
  namespace?: string;
  maxItems?: number;
  /** false = fire-and-forget；true = 等待結果 */
  await?: boolean;
}

/**
 * 逐輪增量萃取（E1）
 * 預設 fire-and-forget，不阻塞 turn:after 事件鏈
 */
export function extractPerTurn(
  newText: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]> {
  if (newText.length < 500) {
    log.debug("[extract] 新增文字 < 500 字元，跳過");
    return Promise.resolve([]);
  }

  // per-session cooldown（以 namespace 為 key）
  const cooldownKey = opts.namespace ?? opts.accountId;
  const lastAt = _cooldownMap.get(cooldownKey) ?? 0;
  if (Date.now() - lastAt < EXTRACT_COOLDOWN_MS) {
    log.debug(`[extract] cooldown 中，跳過（key=${cooldownKey}）`);
    return Promise.resolve([]);
  }
  _cooldownMap.set(cooldownKey, Date.now());

  return new Promise<KnowledgeItem[]>((resolve, reject) => {
    _queue.push({
      response: newText,
      accountId: opts.accountId,
      projectId: opts.projectId,
      intent: opts.sessionIntent ?? "general",
      namespace: opts.namespace ?? (opts.projectId ? `project/${opts.projectId}` : `account/${opts.accountId}`),
      maxItems: opts.maxItems ?? 3,
      resolve,
      reject,
    });

    if (opts.await) {
      runQueue();
    } else {
      // fire-and-forget
      runQueue().catch(err => log.warn(`[extract] queue error：${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/**
 * 全量掃描萃取（E2）
 * 用於 session:idle / platform:shutdown
 */
export async function extractFullScan(
  fullResponse: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]> {
  const truncated = fullResponse.slice(0, 20000);
  if (truncated.length < 200) return [];

  return doExtract({
    response: truncated,
    accountId: opts.accountId,
    projectId: opts.projectId,
    intent: opts.sessionIntent ?? "general",
    namespace: opts.namespace ?? (opts.projectId ? `project/${opts.projectId}` : `account/${opts.accountId}`),
    maxItems: opts.maxItems ?? 5,
    resolve: () => {},
    reject: () => {},
  });
}

/** 重置 extract cooldown（測試用）；傳入 namespace 僅清除該 session，不傳則清全部 */
export function resetExtractCooldown(namespace?: string): void {
  if (namespace) {
    _cooldownMap.delete(namespace);
  } else {
    _cooldownMap.clear();
  }
}
