/**
 * @file core/context-engine.ts
 * @description Context Engineering — Strategy Pattern 架構
 *
 * 設計：
 * - ContextEngine 持有 Strategy Map，build() 依序套用啟用的 strategies
 * - 各 strategy 可獨立開關（A/B 比較），不動核心
 * - CompactionStrategy：turn 數超閾值時用 LLM 摘要壓縮舊訊息
 * - BudgetGuardStrategy：token 超 budget 時強制壓縮
 * - SlidingWindowStrategy：保留最近 N 輪（現況升級版）
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

// ── Token 估算（~4 chars/token 粗估） ────────────────────────────────────────

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.content.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ── CompactionStrategy ────────────────────────────────────────────────────────

export interface CompactionConfig {
  enabled: boolean;
  model?: string;              // CE 壓縮用 LLM model（不填則用 platform 傳入的 ceProvider）
  triggerTurns: number;        // 超過此 turn 數才觸發（預設 20）
  preserveRecentTurns: number; // 保留最近 N 輪不壓縮（預設 5）
}

export class CompactionStrategy implements ContextStrategy {
  name = "compaction";
  enabled: boolean;
  private cfg: CompactionConfig;

  constructor(cfg: Partial<CompactionConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      triggerTurns: cfg.triggerTurns ?? 20,
      preserveRecentTurns: cfg.preserveRecentTurns ?? 5,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    return this.enabled && ctx.turnIndex >= this.cfg.triggerTurns;
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
          const content = typeof m.content === "string" ? m.content : "[tool interaction]";
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
    const sliced = ctx.messages.slice(-preserve);
    return { ...ctx, messages: sliced, estimatedTokens: estimateTokens(sliced) };
  }
}

// ── BudgetGuardStrategy ───────────────────────────────────────────────────────

export interface BudgetGuardConfig {
  enabled: boolean;
  maxUtilization: number;  // 0~1，超過則觸發（預設 0.8）
  contextWindowTokens: number;  // 模型 context window 大小（預設 100000）
}

export class BudgetGuardStrategy implements ContextStrategy {
  name = "budget-guard";
  enabled: boolean;
  private cfg: BudgetGuardConfig;

  constructor(cfg: Partial<BudgetGuardConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      maxUtilization: cfg.maxUtilization ?? 0.8,
      contextWindowTokens: cfg.contextWindowTokens ?? 100_000,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    if (!this.enabled) return false;
    const threshold = this.cfg.contextWindowTokens * this.cfg.maxUtilization;
    return ctx.estimatedTokens > threshold;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    const targetTokens = Math.floor(this.cfg.contextWindowTokens * this.cfg.maxUtilization * 0.7);
    let messages = [...ctx.messages];

    // 從最舊的非 system message 開始刪
    while (estimateTokens(messages) > targetTokens && messages.length > 4) {
      const firstNonSystem = messages.findIndex(m => (m as unknown as { role: string }).role !== "system");
      if (firstNonSystem === -1) break;
      messages.splice(firstNonSystem, 1);
    }

    log.info(`[context-engine:budget-guard] 修剪 ${ctx.messages.length} → ${messages.length} messages`);
    return { ...ctx, messages, estimatedTokens: estimateTokens(messages) };
  }
}

// ── SlidingWindowStrategy ─────────────────────────────────────────────────────

export interface SlidingWindowConfig {
  enabled: boolean;
  maxTurns: number;  // 保留最近 N 輪（預設 50）
}

export class SlidingWindowStrategy implements ContextStrategy {
  name = "sliding-window";
  enabled: boolean;
  private cfg: SlidingWindowConfig;

  constructor(cfg: Partial<SlidingWindowConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? false,  // 預設關閉（已有 session.ts 的 compact）
      maxTurns: cfg.maxTurns ?? 50,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    return this.enabled && ctx.messages.length > this.cfg.maxTurns * 2;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    const sliced = ctx.messages.slice(-this.cfg.maxTurns * 2);
    return { ...ctx, messages: sliced, estimatedTokens: estimateTokens(sliced) };
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
    // 預設內建 strategies
    this.register(new SlidingWindowStrategy());
    this.register(new BudgetGuardStrategy());
    this.register(new CompactionStrategy());
  }

  register(strategy: ContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  getStrategy(name: string): ContextStrategy | undefined {
    return this.strategies.get(name);
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

    // 依照 compaction → budget-guard → sliding-window 順序套用
    const order = ["compaction", "budget-guard", "sliding-window"];
    for (const name of order) {
      const strategy = this.strategies.get(name);
      if (!strategy?.enabled) continue;
      if (strategy.shouldApply(ctx)) {
        ctx = await strategy.apply(ctx, opts.ceProvider ?? this._ceProvider);
        applied.push(name);
        log.debug(`[context-engine] strategy=${name} applied`);
      }
    }

    this.lastBuildBreakdown = {
      totalMessages: ctx.messages.length,
      estimatedTokens: ctx.estimatedTokens,
      strategiesApplied: applied,
      tokensBeforeCE,
      tokensAfterCE: applied.length > 0 ? ctx.estimatedTokens : undefined,
    };
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
  budgetGuard?: Partial<BudgetGuardConfig>;
  slidingWindow?: Partial<SlidingWindowConfig>;
}): ContextEngine {
  _contextEngine = new ContextEngine();

  if (cfg?.compaction) {
    _contextEngine.register(new CompactionStrategy(cfg.compaction));
  }
  if (cfg?.budgetGuard) {
    _contextEngine.register(new BudgetGuardStrategy(cfg.budgetGuard));
  }
  if (cfg?.slidingWindow) {
    _contextEngine.register(new SlidingWindowStrategy(cfg.slidingWindow));
  }

  return _contextEngine;
}

export function getContextEngine(): ContextEngine | null {
  return _contextEngine;
}
