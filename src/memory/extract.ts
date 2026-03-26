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
    ? `\n\n# 跨 Session 觀察（向量搜尋已命中以下相似知識，請避免重複）\n${crossSessionContext}`
    : "";

  return `你是知識萃取 AI。從以下 AI 回應中提取可操作、長期有價值的知識片段。

# 萃取標準
- 可操作性：未來遇到類似問題能直接參考
- 具體性：包含路徑、數值、決策理由（避免泛泛而談）
- 去噪：跳過暫時性資訊（「正在做…」「已完成…」）
- ${emphasis}

# 6 種知識類型
1. factual — 事實性知識（函式名稱、設定值、版本）
2. architectural — 架構決策（設計選擇及理由）
3. procedural — 操作步驟（SOP、指令序列）
4. decision — 決策理由（為何選 X 而非 Y）
5. pitfall — 陷阱 / 錯誤（遇到的 bug、錯誤配置）
6. preference — 使用者偏好（風格、工作習慣）

# 知識歸屬層（tier）
- company：公司 / 團隊共用知識 → 建議寫入全域記憶
- project：專案特定知識 → 寫入目前專案記憶
- personal：個人偏好 / 習慣 → 寫入個人記憶
- unknown：不確定 → 預設個人記憶（安全預設）
${crossCtx}

# AI 回應
${response.slice(0, 20000)}

# 輸出格式（JSON array，0-5 項；無值得萃取則輸出 []）
[
  {
    "type": "factual|architectural|procedural|decision|pitfall|preference",
    "tier": "company|project|personal|unknown",
    "content": "具體知識內容（1-3 句）",
    "triggers": ["關鍵詞1", "關鍵詞2"]
  }
]

只輸出 JSON，不要其他文字。`;
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
let _lastExtractAt = 0;

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
  // 跨 session 觀察（E5）
  const crossCtx = await getCrossSessionContext(task.response.slice(0, 500), task.namespace);

  // Ollama generate
  let raw: string;
  try {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    const prompt = buildExtractPrompt(task.response, task.intent, crossCtx);
    raw = await client.generate(prompt, { think: "auto", numPredict: 8192 });
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

  // cooldown 120s
  if (Date.now() - _lastExtractAt < EXTRACT_COOLDOWN_MS) {
    log.debug("[extract] cooldown 中，跳過");
    return Promise.resolve([]);
  }
  _lastExtractAt = Date.now();

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

/** 重置 extract cooldown（測試用） */
export function resetExtractCooldown(): void {
  _lastExtractAt = 0;
}
