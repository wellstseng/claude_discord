/**
 * @file core/context-engine.ts
 * @description Context Engineering — Strategy Pattern 架構
 *
 * 設計：
 * - ContextEngine 持有 Strategy Map，build() 依序套用啟用的 strategies
 * - 各 strategy 可獨立開關（A/B 比較），不動核心
 * - CompactionStrategy：turn 數超閾值時用 LLM 摘要壓縮舊訊息
 * - OverflowHardStopStrategy：context 超硬上限時緊急截斷
 */

import { log } from "../logger.js";
import type { Message } from "../providers/base.js";
import type { LLMProvider } from "../providers/base.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ContextBreakdown {
  totalMessages: number;
  estimatedTokens: number;
  strategiesApplied: string[];
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  /** 三段 failover 的第三段觸發：截斷後仍超硬上限，需要停止執行 */
  overflowSignaled?: boolean;
}

export interface ContextBuildContext {
  messages: Message[];
  sessionKey: string;
  turnIndex: number;
  estimatedTokens: number;
}

export interface ContextStrategy {
  name: string;
  enabled: boolean;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext>;
}

export interface BuildOpts {
  sessionKey: string;
  turnIndex: number;
  ceProvider?: LLMProvider;  // CE 用 LLM（壓縮/摘要）
}

// ── Tool Pairing Repair ───────────────────────────────────────────────────────

/**
 * 修補截斷後的 tool_use / tool_result 孤立問題
 * - 移除沒有對應 tool_use 的 tool_result block
 * - 移除沒有對應 tool_result 的 tool_use block
 * - 移除因此變空的 user/assistant messages
 */
export function repairToolPairing(messages: Message[]): Message[] {
  // 1. 收集所有 tool_use id
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id);
      }
    }
  }

  // 2. 收集有 tool_result 的 tool_use_id
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // 3. 移除孤立 blocks，過濾空 messages
  return messages
    .map(m => {
      if (typeof m.content === "string") return m;
      const cleaned = m.content.filter(b => {
        if (b.type === "tool_use") return toolResultIds.has(b.id);    // 有對應 result 才保留
        if (b.type === "tool_result") return toolUseIds.has(b.tool_use_id);  // 有對應 use 才保留
        return true;
      });
      if (cleaned.length === 0) return null;
      return { ...m, content: cleaned };
    })
    .filter((m): m is Message => m !== null);
}

// ── Token 估算（~4 chars/token 粗估） ────────────────────────────────────────

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    // 優先使用 per-message 精確 token 數
    if (m.tokens != null) {
      total += m.tokens;
      continue;
    }
    let chars = 0;
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.content.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      }
    }
    total += Math.ceil(chars / 4);
  }
  return total;
}

// ── CompactionStrategy ────────────────────────────────────────────────────────

export interface CompactionConfig {
  enabled: boolean;
  model?: string;              // CE 壓縮用 LLM model（不填則用 platform 傳入的 ceProvider）
  /** 超過此 token 數才觸發（預設 4000）。取代舊的 triggerTurns。 */
  triggerTokens: number;
  preserveRecentTurns: number; // 保留最近 N 輪不壓縮（預設 5）
}

export class CompactionStrategy implements ContextStrategy {
  name = "compaction";
  enabled: boolean;
  private cfg: CompactionConfig;

  constructor(cfg: Partial<CompactionConfig> & { triggerTurns?: number } = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      triggerTokens: cfg.triggerTokens ?? 20_000,
      preserveRecentTurns: cfg.preserveRecentTurns ?? 5,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    return this.enabled && ctx.estimatedTokens > this.cfg.triggerTokens;
  }

  async apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext> {
    if (!ceProvider) {
      log.debug("[context-engine:compaction] 無 ceProvider，改用 sliding-window 回退");
      return this._fallbackSlide(ctx);
    }

    const { messages } = ctx;
    const preserveCount = this.cfg.preserveRecentTurns * 2;  // 每 turn ≈ 2 messages
    if (messages.length <= preserveCount) return ctx;

    const toCompress = messages.slice(0, messages.length - preserveCount);
    const toKeep = messages.slice(messages.length - preserveCount);

    // system messages 不壓縮
    const sysMessages = toCompress.filter(m => (m as unknown as { role: string }).role === "system");
    const convMessages = toCompress.filter(m => (m as unknown as { role: string }).role !== "system");

    if (convMessages.length === 0) return ctx;

    try {
      const summaryPrompt = `以下是對話歷史，請用繁體中文精簡摘要（保留關鍵事實、決策、錯誤）：\n\n${
        convMessages.map(m => {
          let content: string;
          if (typeof m.content === "string") {
            content = m.content;
          } else {
            // 從 tool blocks 提取有意義的摘要文字（而非棄用 "[tool interaction]"）
            content = (m.content as Array<{ type: string; name?: string; input?: unknown; tool_use_id?: string; content?: string }>)
              .map(b => {
                if (b.type === "tool_use") {
                  const params = b.input ? JSON.stringify(b.input).slice(0, 120) : "";
                  return `[工具:${b.name}] ${params}`;
                }
                if (b.type === "tool_result") {
                  const result = typeof b.content === "string" ? b.content.slice(0, 200) : "";
                  return `[結果] ${result}`;
                }
                if (b.type === "text") return (b as unknown as { text: string }).text;
                return "";
              })
              .filter(Boolean)
              .join(" ");
          }
          return `[${m.role}]: ${content.slice(0, 500)}`;
        }).join("\n")
      }`;

      const result = await ceProvider.stream(
        [{ role: "user", content: summaryPrompt }],
        { systemPrompt: "你是摘要助手，只輸出摘要文字，不加說明。" },
      );

      let summaryText = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) summaryText += evt.text;
      }

      const summaryMessage: Message = {
        role: "user",
        content: `[對話摘要]\n${summaryText.trim()}`,
      };

      const compressed = [...sysMessages, summaryMessage, ...toKeep];
      log.info(`[context-engine:compaction] 壓縮 ${messages.length} → ${compressed.length} messages`);

      return {
        ...ctx,
        messages: compressed,
        estimatedTokens: estimateTokens(compressed),
      };
    } catch (err) {
      log.warn(`[context-engine:compaction] LLM 壓縮失敗，回退：${err instanceof Error ? err.message : String(err)}`);
      return this._fallbackSlide(ctx);
    }
  }

  private _fallbackSlide(ctx: ContextBuildContext): ContextBuildContext {
    const preserve = this.cfg.preserveRecentTurns * 2;
    const sliced = repairToolPairing(ctx.messages.slice(-preserve));
    return { ...ctx, messages: sliced, estimatedTokens: estimateTokens(sliced) };
  }
}

// ── OverflowHardStopStrategy（第三段 failover）────────────────────────────────

export interface OverflowHardStopConfig {
  enabled: boolean;
  /** 超過此比例 context window → 觸發（預設 0.95） */
  hardLimitUtilization: number;
  contextWindowTokens: number;
}

export class OverflowHardStopStrategy implements ContextStrategy {
  name = "overflow-hard-stop";
  enabled: boolean;
  private cfg: OverflowHardStopConfig;
  /** 最後一次 apply 是否觸發了 hard stop */
  lastOverflowSignaled = false;

  constructor(cfg: Partial<OverflowHardStopConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      hardLimitUtilization: cfg.hardLimitUtilization ?? 0.95,
      contextWindowTokens: cfg.contextWindowTokens ?? 100_000,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    if (!this.enabled) return false;
    const hard = this.cfg.contextWindowTokens * this.cfg.hardLimitUtilization;
    return ctx.estimatedTokens > hard;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    // 緊急截斷：只保留最後 4 條 messages（system + 最近 2 輪）
    const minMessages = ctx.messages.slice(-4);
    this.lastOverflowSignaled = true;
    log.warn(`[context-engine:overflow-hard-stop] context 超硬上限 ${ctx.estimatedTokens} tokens，截斷至 ${minMessages.length} messages`);
    return { ...ctx, messages: minMessages, estimatedTokens: estimateTokens(minMessages) };
  }
}

// ── ContextEngine ─────────────────────────────────────────────────────────────

export class ContextEngine {
  private strategies = new Map<string, ContextStrategy>();
  private _ceProvider?: LLMProvider;

  setCeProvider(p: LLMProvider): void { this._ceProvider = p; }

  /** 最後一次 build 的 breakdown */
  lastBuildBreakdown: ContextBreakdown = {
    totalMessages: 0,
    estimatedTokens: 0,
    strategiesApplied: [],
  };
  lastAppliedStrategy: string | undefined;

  constructor() {
    this.register(new CompactionStrategy());
    this.register(new OverflowHardStopStrategy());
  }

  register(strategy: ContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  getStrategy(name: string): ContextStrategy | undefined {
    return this.strategies.get(name);
  }

  /** 取得 context window 大小（供 nudge 計算用） */
  getContextWindowTokens(): number {
    const oh = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    return oh?.["cfg"]?.contextWindowTokens ?? 100_000;
  }

  async build(messages: Message[], opts: BuildOpts): Promise<Message[]> {
    const tokensBeforeCE = estimateTokens(messages);
    let ctx: ContextBuildContext = {
      messages,
      sessionKey: opts.sessionKey,
      turnIndex: opts.turnIndex,
      estimatedTokens: tokensBeforeCE,
    };

    const applied: string[] = [];

    const order = ["compaction", "overflow-hard-stop"];
    const effectiveCeProvider = opts.ceProvider ?? this._ceProvider;

    for (const name of order) {
      const strategy = this.strategies.get(name);
      if (!strategy?.enabled) continue;
      if (strategy.shouldApply(ctx)) {
        ctx = await strategy.apply(ctx, effectiveCeProvider);
        applied.push(name);
        log.debug(`[context-engine] strategy=${name} applied`);
      }
    }

    const overflowStrategy = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    this.lastBuildBreakdown = {
      totalMessages: ctx.messages.length,
      estimatedTokens: ctx.estimatedTokens,
      strategiesApplied: applied,
      tokensBeforeCE,
      tokensAfterCE: applied.length > 0 ? ctx.estimatedTokens : undefined,
      overflowSignaled: overflowStrategy?.lastOverflowSignaled ?? false,
    };
    if (overflowStrategy) overflowStrategy.lastOverflowSignaled = false; // reset for next build
    this.lastAppliedStrategy = applied.at(-1);

    return ctx.messages;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _contextEngine: ContextEngine | null = null;

export function initContextEngine(cfg?: {
  compaction?: Partial<CompactionConfig> & { model?: string };
}): ContextEngine {
  _contextEngine = new ContextEngine();

  if (cfg?.compaction) {
    _contextEngine.register(new CompactionStrategy(cfg.compaction));
  }

  return _contextEngine;
}

export function getContextEngine(): ContextEngine | null {
  return _contextEngine;
}
