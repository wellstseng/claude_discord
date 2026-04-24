/**
 * @file memory/extract.ts
 * @description 知識萃取 — 從 assistant response 提取可操作知識
 *
 * E1: 累積制萃取（turn:after）— accumCharThreshold 200
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
  | "fact"           // 客觀知識（事實、架構、操作步驟）
  | "decision"       // 決策理由 + 陷阱
  | "preference"     // 使用者偏好
  // 舊類型保留相容（映射到新類型）
  | "factual" | "architectural" | "procedural" | "pitfall";

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

function buildExtractPrompt(
  response: string,
  crossSessionContext?: string,
  userInput?: string,
): string {
  const crossCtx = crossSessionContext
    ? `\n# Existing knowledge (avoid duplicates)\n${crossSessionContext}\n`
    : "";

  const userCtx = userInput
    ? `\n# User Input\n${userInput.slice(0, 5000)}\n`
    : "";

  return `Extract 0-3 reusable knowledge items from this conversation.
Pay attention to BOTH user input and assistant response.
User input often contains: personal info, preferences, decisions, context, requirements, deadlines, team dynamics.
Types: fact (what is true), decision (why this choice), preference (user habit/style)
Tier: company | project | personal
Output JSON only: [{"type":"fact","tier":"project","content":"...","triggers":["..."]}]
Empty array [] if nothing worth remembering.${crossCtx}${userCtx}
# Assistant Response
${response.slice(0, 20000)}`;
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

/** 舊類型 → 新類型映射 */
const TYPE_MAP: Record<string, KnowledgeType> = {
  fact: "fact", factual: "fact", architectural: "fact", procedural: "fact",
  decision: "decision", pitfall: "decision",
  preference: "preference",
};

/**
 * 用括號深度計數找到外層 JSON array 的精確範圍。
 * 正確處理字串內 `"[...]"` 與轉義 `\"`；避免被尾巴多餘的 `]` 或補充說明干擾。
 * 找不到匹配 `]` 時回 null（可能被截斷）。
 */
function findOuterArrayRange(raw: string): { start: number; end: number } | null {
  const start = raw.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function parseExtractResult(raw: string): KnowledgeItem[] {
  // 用括號深度找精確的外層 array（避免 Ollama 在 JSON 後加補充說明 / 尾巴多餘 `]`）
  const range = findOuterArrayRange(raw);
  const fallbackFirst = raw.indexOf("[");
  if (fallbackFirst < 0) {
    log.info(`[extract] JSON parse 失敗 — 無 array。raw(200): ${raw.slice(0, 200)}`);
    return [];
  }

  try {
    let jsonStr = range
      ? raw.slice(range.start, range.end)
      : raw.slice(fallbackFirst); // 未封口（被截斷）— 進 fallback 嘗試修補

    try { JSON.parse(jsonStr); } catch {
      // 修補被截斷的 JSON array：回溯到最後一個完整的 `},` 補 `]`
      const lastComplete = jsonStr.lastIndexOf("},");
      if (lastComplete > 0) {
        jsonStr = jsonStr.slice(0, lastComplete + 1) + "]";
      } else {
        const lastObj = jsonStr.lastIndexOf("}");
        if (lastObj > 0) jsonStr = jsonStr.slice(0, lastObj + 1) + "]";
      }
    }
    const parsed = JSON.parse(jsonStr) as Array<{
      type?: string; tier?: string; content?: string; triggers?: string[];
    }>;
    if (!Array.isArray(parsed)) return [];

    const VALID_TIERS = new Set(["company", "project", "personal", "unknown"]);

    return parsed
      .filter(item => item.content && item.content.trim().length > 20)
      .map(item => {
        const type = TYPE_MAP[item.type ?? ""] ?? "fact";
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
  } catch (err) {
    log.info(`[extract] JSON parse 失敗：${err instanceof Error ? err.message : String(err)}。raw(200): ${raw.slice(0, 200)}`);
    return [];
  }
}

// ── Fire-and-Forget Queue ─────────────────────────────────────────────────────

interface ExtractTask {
  response: string;
  userInput?: string;
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

  // LLM generate（最多 2048 token 輸出，0-5 項 JSON 足夠）
  let raw: string;
  try {
    const { hasExtractionProvider, getExtractionProvider } = await import("./extraction-provider.js");
    if (!hasExtractionProvider()) {
      log.debug("[extract] ExtractionProvider 未初始化，跳過");
      return [];
    }
    const provider = getExtractionProvider();
    const prompt = buildExtractPrompt(task.response, crossCtx, task.userInput);
    raw = await provider.generate(prompt, { maxTokens: 2048 });
  } catch (err) {
    log.debug(`[extract] 萃取 LLM 不可用，跳過：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const items = parseExtractResult(raw);
  if (items.length === 0) {
    log.info(`[extract] 萃取 0 項 — raw(200): ${raw.slice(0, 200)}`);
  } else {
    log.info(`[extract] 萃取 ${items.length} 項：${items.map(i => `${i.type}/${i.tier}`).join(", ")}`);
  }
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
  /** 使用者原始輸入（萃取時同時分析） */
  userInput?: string;
  /** 覆寫 cooldown（ms），預設 EXTRACT_COOLDOWN_MS */
  cooldownMs?: number;
}

/**
 * 逐輪增量萃取（E1）
 * 預設 fire-and-forget，不阻塞 turn:after 事件鏈
 */
export function extractPerTurn(
  newText: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]> {
  // per-session cooldown（以 namespace 為 key）
  const cooldownKey = opts.namespace ?? opts.accountId;
  const lastAt = _cooldownMap.get(cooldownKey) ?? 0;
  if (Date.now() - lastAt < (opts.cooldownMs ?? EXTRACT_COOLDOWN_MS)) {
    log.info(`[extract] cooldown 中，跳過（key=${cooldownKey}）`);
    return Promise.resolve([]);
  }
  _cooldownMap.set(cooldownKey, Date.now());

  return new Promise<KnowledgeItem[]>((resolve, reject) => {
    _queue.push({
      response: newText,
      userInput: opts.userInput,
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
