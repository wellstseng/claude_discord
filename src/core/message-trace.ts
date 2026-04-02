/**
 * @file core/message-trace.ts
 * @description Message Lifecycle Trace — 訊息全鏈路追蹤
 *
 * 每條 Discord 訊息從接收到回覆的完整處理過程追蹤。
 * 包含 7 個階段：Inbound → Context → LLM Loop → CE → Abort → PostProcess → Response
 *
 * 使用方式：
 *   1. discord.ts 收到訊息 → MessageTrace.create()
 *   2. 各階段呼叫 trace.recordXxx() 記錄
 *   3. agent-loop 結束 → trace.finalize() → TraceStore 持久化
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

/** 記憶 Recall 追蹤 */
export interface TraceRecall {
  durationMs: number;
  fragmentCount: number;
  atomNames: string[];
  injectedTokens: number;
  vectorSearch: boolean;
  degraded: boolean;
}

/** Inbound History 追蹤 */
export interface TraceInbound {
  bucketA: number;
  bucketB: number;
  tokens: number;
  decayIIApplied: boolean;
}

/** 單次 LLM 呼叫中的 Tool 追蹤 */
export interface TraceToolCall {
  name: string;
  durationMs: number;
  error?: string;
  resultPreview?: string;
  /** 工具參數摘要（依工具類型提取關鍵欄位） */
  paramsPreview?: string;
}

/** 單次 LLM 呼叫追蹤 */
export interface TraceLLMCall {
  iteration: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
  durationMs: number;
  toolCalls: TraceToolCall[];
  stopReason?: string;
}

/** 完整訊息追蹤記錄 */
export interface MessageTraceEntry {
  traceId: string;
  messageId?: string;
  channelId: string;
  accountId: string;
  ts: string;

  // Phase 1: Inbound
  inbound: {
    receivedAt: number;
    textPreview: string;
    charCount: number;
    attachments: number;
    debounceMs?: number;
    debounceMergedCount?: number;
    interruptedPrevious?: boolean;
  };

  // Phase 2: Context Assembly
  context?: {
    startMs: number;
    endMs: number;
    memoryRecall?: TraceRecall;
    systemPromptTokens: number;
    historyTokens: number;
    historyMessageCount: number;
    inboundHistory?: TraceInbound;
    totalContextTokens: number;
  };

  // Phase 3: LLM Call Loop
  llmCalls: TraceLLMCall[];

  // Phase 4: Context Engineering
  contextEngineering?: {
    strategiesApplied: string[];
    tokensBeforeCE: number;
    tokensAfterCE: number;
    tokensSaved: number;
  };

  // Phase 5: Abort/Interrupt
  abort?: {
    trigger: string;
    rollback: boolean;
  };

  // Phase 6: Post-processing
  postProcess?: {
    extractRan: boolean;
    sessionSnapshotKept: boolean;
    sessionNoteUpdated: boolean;
    toolLogPath?: string;
  };

  // Phase 7: Response
  response?: {
    textPreview: string;
    charCount: number;
    durationMs: number;
  };

  // Summary
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /** input + cacheRead + cacheWrite = 實際送進 LLM 的總 context */
  effectiveInputTokens: number;
  totalToolCalls: number;
  /** 預估費用（USD），依 model pricing 計算 */
  estimatedCostUsd?: number;
  error?: string;
  status: "completed" | "aborted" | "error";
}

// ── 費用計算 ─────────────────────────────────────────────────────────────────

/** 模型價格表（per 1M tokens, USD）。與 models-config.ts BUILTIN_PROVIDERS 同步。 */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-6":              { input: 15,   output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "claude-sonnet-4-6":            { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250514":   { input: 3,    output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001":    { input: 0.8,  output: 4,   cacheRead: 0.08,  cacheWrite: 1 },
  "gpt-4o":                       { input: 2.5,  output: 10,  cacheRead: 1.25,  cacheWrite: 0 },
  "gpt-4o-mini":                  { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
};

function estimateCost(calls: TraceLLMCall[]): number {
  let total = 0;
  for (const call of calls) {
    const p = MODEL_PRICING[call.model];
    if (!p) continue; // Ollama / unknown → free
    total += (call.inputTokens * p.input
            + call.outputTokens * p.output
            + call.cacheRead * p.cacheRead
            + call.cacheWrite * p.cacheWrite) / 1_000_000;
  }
  return total;
}

// ── MessageTrace（收集器）──────────────────────────────────────────────────

/** 文字截斷 preview */
function preview(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/**
 * MessageTrace — 累積式 trace 收集器
 *
 * 由 discord.ts 建立，傳入 agentLoop opts，
 * 各模組呼叫 record 方法累積數據，最後 finalize() 產出完整記錄。
 */
export class MessageTrace {
  readonly traceId: string;
  private entry: MessageTraceEntry;
  private _currentLLMCall: Partial<TraceLLMCall> | null = null;
  private _llmCallStartMs = 0;

  private constructor(traceId: string, channelId: string, accountId: string) {
    this.traceId = traceId;
    this.entry = {
      traceId,
      channelId,
      accountId,
      ts: new Date().toISOString(),
      inbound: {
        receivedAt: Date.now(),
        textPreview: "",
        charCount: 0,
        attachments: 0,
      },
      llmCalls: [],
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      effectiveInputTokens: 0,
      totalToolCalls: 0,
      status: "completed",
    };
  }

  /** 建立新的 trace（使用已存在的 turnId） */
  static create(traceId: string, channelId: string, accountId: string): MessageTrace {
    return new MessageTrace(traceId, channelId, accountId);
  }

  // ── Phase 1: Inbound ──────────────────────────────────────────────────────

  recordInbound(opts: {
    messageId?: string;
    text: string;
    attachments: number;
    debounceMs?: number;
    debounceMergedCount?: number;
    interruptedPrevious?: boolean;
  }): void {
    this.entry.messageId = opts.messageId;
    this.entry.inbound = {
      receivedAt: Date.now(),
      textPreview: preview(opts.text),
      charCount: opts.text.length,
      attachments: opts.attachments,
      debounceMs: opts.debounceMs,
      debounceMergedCount: opts.debounceMergedCount,
      interruptedPrevious: opts.interruptedPrevious,
    };
  }

  // ── Phase 2: Context Assembly ─────────────────────────────────────────────

  recordContextStart(): void {
    this.entry.context = {
      startMs: Date.now(),
      endMs: 0,
      systemPromptTokens: 0,
      historyTokens: 0,
      historyMessageCount: 0,
      totalContextTokens: 0,
    };
  }

  recordMemoryRecall(recall: TraceRecall): void {
    if (this.entry.context) {
      this.entry.context.memoryRecall = recall;
    }
  }

  recordInboundHistory(inbound: TraceInbound): void {
    if (this.entry.context) {
      this.entry.context.inboundHistory = inbound;
    }
  }

  recordContextEnd(opts: {
    systemPromptTokens: number;
    historyTokens: number;
    historyMessageCount: number;
    totalContextTokens: number;
  }): void {
    if (this.entry.context) {
      this.entry.context.endMs = Date.now();
      this.entry.context.systemPromptTokens = opts.systemPromptTokens;
      this.entry.context.historyTokens = opts.historyTokens;
      this.entry.context.historyMessageCount = opts.historyMessageCount;
      this.entry.context.totalContextTokens = opts.totalContextTokens;
    }
  }

  // ── Phase 3: LLM Call Loop ────────────────────────────────────────────────

  recordLLMCallStart(iteration: number): void {
    this._llmCallStartMs = Date.now();
    this._currentLLMCall = {
      iteration,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      estimated: false,
    };
  }

  recordLLMCallEnd(opts: {
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    estimated: boolean;
    stopReason?: string;
  }): void {
    if (!this._currentLLMCall) return;
    const call: TraceLLMCall = {
      iteration: this._currentLLMCall.iteration ?? 0,
      model: opts.model,
      provider: opts.provider,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheRead: opts.cacheRead,
      cacheWrite: opts.cacheWrite,
      estimated: opts.estimated,
      durationMs: Date.now() - this._llmCallStartMs,
      toolCalls: this._currentLLMCall.toolCalls ?? [],
      stopReason: opts.stopReason,
    };
    this.entry.llmCalls.push(call);
    this.entry.totalInputTokens += opts.inputTokens;
    this.entry.totalOutputTokens += opts.outputTokens;
    this.entry.totalCacheRead += opts.cacheRead;
    this.entry.totalCacheWrite += opts.cacheWrite;
    this.entry.effectiveInputTokens += opts.inputTokens + opts.cacheRead + opts.cacheWrite;
    this._currentLLMCall = null;
  }

  recordToolCall(tc: TraceToolCall): void {
    if (this._currentLLMCall) {
      this._currentLLMCall.toolCalls!.push(tc);
    } else if (this.entry.llmCalls.length > 0) {
      // tool 執行在 recordLLMCallEnd 之後，歸屬到觸發它的那次 LLM call
      this.entry.llmCalls[this.entry.llmCalls.length - 1].toolCalls.push(tc);
    }
    this.entry.totalToolCalls++;
  }

  // ── Phase 4: Context Engineering ──────────────────────────────────────────

  recordCE(opts: {
    strategiesApplied: string[];
    tokensBeforeCE: number;
    tokensAfterCE: number;
  }): void {
    if (opts.strategiesApplied.length === 0) return;
    this.entry.contextEngineering = {
      strategiesApplied: opts.strategiesApplied,
      tokensBeforeCE: opts.tokensBeforeCE,
      tokensAfterCE: opts.tokensAfterCE,
      tokensSaved: opts.tokensBeforeCE - opts.tokensAfterCE,
    };
  }

  // ── Phase 5: Abort ────────────────────────────────────────────────────────

  recordAbort(trigger: string, rollback: boolean): void {
    this.entry.abort = { trigger, rollback };
    this.entry.status = "aborted";
  }

  // ── Phase 6: Post-processing ──────────────────────────────────────────────

  recordPostProcess(opts: {
    extractRan: boolean;
    sessionSnapshotKept: boolean;
    sessionNoteUpdated: boolean;
    toolLogPath?: string;
  }): void {
    this.entry.postProcess = opts;
  }

  // ── Phase 7: Response ─────────────────────────────────────────────────────

  recordResponse(text: string, durationMs: number): void {
    this.entry.response = {
      textPreview: preview(text, 200),
      charCount: text.length,
      durationMs,
    };
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  recordError(error: string): void {
    this.entry.error = error;
    this.entry.status = "error";
  }

  // ── Finalize ──────────────────────────────────────────────────────────────

  /** 結束追蹤，回傳完整記錄 */
  finalize(): MessageTraceEntry {
    this.entry.totalDurationMs = Date.now() - this.entry.inbound.receivedAt;
    this.entry.estimatedCostUsd = estimateCost(this.entry.llmCalls);
    return { ...this.entry };
  }
}

// ── TraceStore（持久化）─────────────────────────────────────────────────────

const ROLLING_DAYS = 14;

export class TraceStore {
  private logDir: string;

  constructor(dataDir: string) {
    this.logDir = resolve(
      dataDir.startsWith("~") ? dataDir.replace("~", homedir()) : dataDir,
      "traces",
    );
    mkdirSync(this.logDir, { recursive: true });
  }

  /** 追加一筆 trace 記錄 */
  append(entry: MessageTraceEntry): void {
    try {
      const dateStr = entry.ts.slice(0, 10);
      const filePath = join(this.logDir, `${dateStr}.jsonl`);
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log.warn(`[trace-store] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 查詢最近 N 筆 trace */
  recent(limit = 50, filter?: (e: MessageTraceEntry) => boolean): MessageTraceEntry[] {
    const results: MessageTraceEntry[] = [];
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const f of files) {
        if (results.length >= limit) break;
        const lines = readFileSync(join(this.logDir, f), "utf-8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          if (results.length >= limit) break;
          try {
            const entry = JSON.parse(lines[i]) as MessageTraceEntry;
            if (!filter || filter(entry)) results.push(entry);
          } catch { /* skip malformed lines */ }
        }
      }
    } catch { /* directory may not exist yet */ }
    return results;
  }

  /** 依 traceId 查詢單筆 */
  getById(traceId: string): MessageTraceEntry | null {
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const f of files) {
        const lines = readFileSync(join(this.logDir, f), "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as MessageTraceEntry;
            if (entry.traceId === traceId) return entry;
          } catch { /* skip */ }
        }
      }
    } catch { /* directory may not exist */ }
    return null;
  }

  /** 清理過期檔案 */
  cleanup(): void {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - ROLLING_DAYS);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const files = readdirSync(this.logDir).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        const dateStr = f.replace(".jsonl", "");
        if (dateStr < cutoffStr) {
          unlinkSync(join(this.logDir, f));
          log.debug(`[trace-store] 清理過期 ${f}`);
        }
      }
    } catch { /* ignore */ }
  }
}

// ── 全域單例 ─────────────────────────────────────────────────────────────────

let _traceStore: TraceStore | null = null;

export function initTraceStore(dataDir: string): TraceStore {
  _traceStore = new TraceStore(dataDir);
  return _traceStore;
}

export function getTraceStore(): TraceStore | null {
  return _traceStore;
}
