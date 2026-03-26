/**
 * @file workflow/wisdom-engine.ts
 * @description Wisdom Engine — 2 條硬規則 + 反思指標
 *
 * 規則：
 *   W1: file_count ≥ 5 + is_feature → 建議確認
 *   W2: touches_arch + file_count ≥ 3 → 建議計畫
 *
 * 特性：
 *   - 無匹配規則時不注入（W3）
 *   - 注入上限 ≤ 90 tokens（W3）
 *   - 不可用時 graceful fallback（W4）
 *   - 注入方式：system prompt addition（W5）
 *
 * 對應架構文件第 9 節「Wisdom Engine」
 */

import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";
import type { WisdomAdvice, ReflectionMetrics } from "./types.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

// ── 架構相關路徑/關鍵詞 ────────────────────────────────────────────────────────

const ARCH_PATHS = [
  "architecture", "config", "platform", "registry", "provider", "bootstrap",
  "index.ts", "event-bus", "permission-gate", "session", "agent-loop",
];
const ARCH_KEYWORDS = [
  "架構", "重構", "設計", "介面", "型別", "refactor", "redesign", "architect",
];
const FEATURE_KEYWORDS = [
  "新增", "實作", "功能", "feature", "implement", "add ", "新功能", "系統",
];

// ── 反思指標狀態 ──────────────────────────────────────────────────────────────

/** sessionKey → { toolCalls, editsByFile } */
const _sessionMetrics = new Map<string, {
  toolCalls: number;
  editsByFile: Map<string, number>;
  totalTurns: number;
}>();

// ── 公開 API ──────────────────────────────────────────────────────────────────

/**
 * 取得本 turn 的 Wisdom 建議（注入 system prompt 用）
 *
 * @param sessionKey session 唯一識別
 * @param prompt 使用者輸入
 * @param modifiedFileCount 本 session 已修改的檔案數
 * @returns 建議字串陣列（≤90 tokens 合計）
 */
export function getWisdomAdvice(
  sessionKey: string,
  prompt: string,
  modifiedFileCount: number,
): WisdomAdvice[] {
  try {
    const advices: WisdomAdvice[] = [];
    const lowerPrompt = prompt.toLowerCase();

    const isFeature = FEATURE_KEYWORDS.some(k => lowerPrompt.includes(k.toLowerCase()));
    const touchesArch = ARCH_KEYWORDS.some(k => lowerPrompt.includes(k.toLowerCase()))
      || ARCH_PATHS.some(p => lowerPrompt.includes(p.toLowerCase()));

    // Rule W1: file_count ≥ 5 + is_feature
    if (modifiedFileCount >= 5 && isFeature) {
      advices.push({
        rule: "W1",
        message: "[Wisdom] 本 session 已修改 5+ 個檔案，建議先向使用者確認範圍再繼續。",
        tokenCount: 20,
      });
    }

    // Rule W2: touches_arch + file_count ≥ 3
    if (touchesArch && modifiedFileCount >= 3) {
      advices.push({
        rule: "W2",
        message: "[Wisdom] 變更涉及架構層並已修改 3+ 個檔案，建議先規劃再執行。",
        tokenCount: 18,
      });
    }

    // W3: 無匹配規則時不注入
    if (advices.length === 0) return [];

    // W3: 合計 token 上限 90
    let totalTokens = 0;
    const result: WisdomAdvice[] = [];
    for (const a of advices) {
      if (totalTokens + a.tokenCount <= 90) {
        result.push(a);
        totalTokens += a.tokenCount;
      }
    }

    if (result.length > 0) {
      log.debug(`[wisdom-engine] session=${sessionKey} 觸發 ${result.map(r => r.rule).join(",")} 規則`);
    }

    return result;
  } catch (err) {
    // W4: graceful fallback
    log.warn(`[wisdom-engine] getWisdomAdvice 失敗（graceful fallback）：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 從 WisdomAdvice[] 產生 system prompt 追加文字
 * 若無建議 → 回傳空字串（W3）
 */
export function buildWisdomSystemPromptAddition(advices: WisdomAdvice[]): string {
  if (advices.length === 0) return "";
  return "\n\n" + advices.map(a => a.message).join("\n");
}

/**
 * 取得 session 反思指標
 */
export function getReflectionMetrics(sessionKey: string): ReflectionMetrics {
  const m = _sessionMetrics.get(sessionKey);
  if (!m) return { overEngineeringRate: 0, totalTurns: 0, totalToolCalls: 0 };

  let overEngineerCount = 0;
  for (const count of m.editsByFile.values()) {
    if (count >= 2) overEngineerCount++;
  }
  const overEngineeringRate = m.editsByFile.size > 0
    ? overEngineerCount / m.editsByFile.size : 0;

  return {
    overEngineeringRate,
    totalTurns: m.totalTurns,
    totalToolCalls: m.toolCalls,
  };
}

// ── EventBus 訂閱 ─────────────────────────────────────────────────────────────

export function initWisdomEngine(eventBus: EventBus): void {
  // turn:after → 更新指標
  (eventBus as unknown as {
    on(event: "turn:after", listener: (...args: CatClawEvents["turn:after"]) => void): unknown;
  }).on("turn:after", (ctx, _response) => {
    if (!_sessionMetrics.has(ctx.sessionKey)) {
      _sessionMetrics.set(ctx.sessionKey, { toolCalls: 0, editsByFile: new Map(), totalTurns: 0 });
    }
    const m = _sessionMetrics.get(ctx.sessionKey)!;
    m.totalTurns++;
  });

  // file:modified → 更新 editsByFile（按 sessionKey 歸類）
  let _currentSessionKey = "_global";
  (eventBus as unknown as {
    on(event: "turn:before", listener: (...args: CatClawEvents["turn:before"]) => void): unknown;
  }).on("turn:before", (ctx) => { _currentSessionKey = ctx.sessionKey; });

  (eventBus as unknown as {
    on(event: "file:modified", listener: (...args: CatClawEvents["file:modified"]) => void): unknown;
  }).on("file:modified", (path, _tool, _accountId) => {
    const key = _currentSessionKey;
    if (!_sessionMetrics.has(key)) {
      _sessionMetrics.set(key, { toolCalls: 0, editsByFile: new Map(), totalTurns: 0 });
    }
    const m = _sessionMetrics.get(key)!;
    m.editsByFile.set(path, (m.editsByFile.get(path) ?? 0) + 1);
  });

  // session:end → 清理
  (eventBus as unknown as {
    on(event: "session:end", listener: (...args: CatClawEvents["session:end"]) => void): unknown;
  }).on("session:end", (sessionId) => {
    _sessionMetrics.delete(sessionId);
  });

  log.info("[wisdom-engine] 初始化完成");
}
