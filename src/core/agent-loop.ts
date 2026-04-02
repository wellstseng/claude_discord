/**
 * @file core/agent-loop.ts
 * @description Agent Loop — 核心對話迴圈
 *
 * 設計：一軌制，CatClaw 控制所有 tool，LLM 只負責思考。
 * 流程：
 *   1. 身份 + 權限檢查
 *   2. 記憶 Recall（可選）
 *   3. Context 組裝
 *   4. Tool list 物理過濾
 *   5. LLM 呼叫 → 處理 tool_use → 迴圈至 end_turn
 *   6. 萃取 + 事件通知
 *
 * 參考架構文件第 6 節（Agent Loop + Tool 執行引擎）。
 */

import { log } from "../logger.js";
import { makeToolResultMessage } from "../providers/base.js";
import type { LLMProvider, Message, ProviderEvent, ImageBlock, ContentBlock } from "../providers/base.js";
import type { SessionManager } from "./session.js";
import type { PermissionGate } from "../accounts/permission-gate.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SafetyGuard } from "../safety/guard.js";
import { eventBus as _eventBusInstance } from "./event-bus.js";
type EventBus = typeof _eventBusInstance;
import type { ToolContext } from "../tools/types.js";
import { getTurnAuditLog } from "./turn-audit-log.js";
import { getContextEngine } from "./context-engine.js";
import { getToolLogStore, ToolLogStore } from "./tool-log-store.js";
import { getSessionSnapshotStore } from "./session-snapshot.js";
import { registerTurnAbort, clearTurnAbort } from "../skills/builtin/stop.js";
import type { MemoryEngine } from "../memory/engine.js";
import { createApproval, sendApprovalDm, isCommandAllowed } from "./exec-approval.js";
import { getSessionNote, checkAndSaveNote } from "../memory/session-memory.js";
import { config } from "./config.js";
import type { MessageTrace } from "./message-trace.js";
import { getTraceStore } from "./message-trace.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const MAX_LOOPS = 20;
const DEFAULT_RESULT_TOKEN_CAP = 8000;   // 1 token ≈ 4 chars → 32000 chars

// ── Tool result 截斷 ──────────────────────────────────────────────────────────

function truncateToolResult(text: string, tokenCap: number): string {
  if (tokenCap === 0) return text;                       // 0 = 無限制
  const charCap = tokenCap * 4;
  if (text.length <= charCap) return text;

  const lines = text.split("\n");
  const totalLines = lines.length;
  const head = lines.slice(0, 50).join("\n");
  const tail = lines.slice(-20).join("\n");
  const notice = `\n[結果過長已截斷。原始共 ${totalLines} 行 / ${text.length} 字元，顯示前 50 行 + 末 20 行]\n`;
  return head + notice + tail;
}

/**
 * 計算工具結果的有效 token cap。
 * 優先序：per-tool override > per-turn remaining budget > global default
 */
function resolveResultTokenCap(
  perToolCap: number | undefined,
  turnTokensUsed: number,
): number {
  if (perToolCap !== undefined) return perToolCap;
  const globalDefault = config.toolBudget?.resultTokenCap ?? DEFAULT_RESULT_TOKEN_CAP;
  const perTurnCap = config.toolBudget?.perTurnTotalCap ?? 0;
  if (perTurnCap === 0) return globalDefault;
  const remaining = perTurnCap - turnTokensUsed;
  if (remaining <= 0) return 50; // budget 耗盡，幾乎截空
  return Math.min(globalDefault, remaining);
}

// ── LLM 呼叫重試 + backoff ────────────────────────────────────────────────────

async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseMs: number; maxMs: number; signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts) throw err;
      if (opts.signal?.aborted) throw err;

      const msg = err instanceof Error ? err.message : String(err);

      // 判斷是否可重試
      const statusMatch = msg.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (status >= 400 && status < 500 && status !== 429) throw err; // 4xx 非 rate limit → 不重試

      // 429 → 讀 Retry-After（單位：秒）
      let delay: number;
      if (status === 429) {
        const retryAfterMatch = msg.match(/retry-after[:\s]+(\d+)/i);
        delay = retryAfterMatch ? parseInt(retryAfterMatch[1]) * 1000 : opts.baseMs;
      } else {
        const jitter = Math.random() * opts.baseMs * 0.1;
        delay = Math.min(opts.baseMs * Math.pow(2, attempt - 1) + jitter, opts.maxMs);
      }

      log.warn(`[agent-loop] retry attempt=${attempt}/${opts.maxAttempts} status=${status || "network"} wait=${Math.round(delay)}ms`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        opts.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    }
  }
  throw new Error("unreachable");
}

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AgentLoopOpts {
  /** 平台識別碼（用於 session key 前綴，預設 "discord"） */
  platform?: string;
  /** 平台頻道 ID（用於 session key） */
  channelId: string;
  /** CatClaw accountId */
  accountId: string;
  /** 是否為群組頻道（影響 system prompt 多人聲明） */
  isGroupChannel?: boolean;
  /** 說話者角色（群組場景） */
  speakerRole?: string;
  /** 說話者顯示名稱 */
  speakerDisplay?: string;
  /** 已選定的 LLM Provider */
  provider: LLMProvider;
  /** System prompt（記憶 + context 已組裝） */
  systemPrompt?: string;
  /** AbortSignal（turn timeout / /cancel） */
  signal?: AbortSignal;
  /** Turn timeout 毫秒（預設無限） */
  turnTimeoutMs?: number;
  /** 是否顯示 tool calls（summary / all / none） */
  showToolCalls?: "all" | "summary" | "none";
  /** 當前專案 ID */
  projectId?: string;
  /**
   * 是否允許呼叫 spawn_subagent（預設 true）。
   * 子 agent 傳入 false — 邏輯面過濾，tool list 不含此工具。
   */
  allowSpawn?: boolean;
  /**
   * Spawn 深度（0 = 頂層 parent）。
   * ≥ 2 時 allowSpawn 強制 false（最多 3 層：parent → child → grandchild）。
   */
  spawnDepth?: number;
  /** LLM 呼叫失敗重試次數（預設 3） */
  retryMaxAttempts?: number;
  /** 重試 backoff 基礎毫秒（預設 1000） */
  retryBaseMs?: number;
  /** 重試 backoff 最大毫秒（預設 30000） */
  retryMaxMs?: number;
  /** 子 agent 工作目錄（spawn 時繼承父設定） */
  workspaceDir?: string;
  /**
   * 覆寫 session key（子 agent 用，繞過 platform:ch:channelId 格式）。
   * 正常流程不使用此欄位。
   */
  _sessionKeyOverride?: string;
  /**
   * 父 subagent runId（由 spawn-subagent 注入）。
   * 注入到 ToolContext.parentRunId，讓子 agent 呼叫 spawn_subagent 時能建立 parentId 關聯。
   */
  parentRunId?: string;
  /**
   * 圖片附件（來自 Discord 訊息）。
   * 直接作為 image content blocks 加入第一條 user 訊息，讓 LLM 可直接「看」圖。
   */
  imageAttachments?: Array<{ data: string; mimeType: string; name: string }>;
  /** Message Lifecycle Trace 收集器（由呼叫端建立並傳入） */
  trace?: MessageTrace;
  /**
   * Extended thinking 等級（Anthropic）。
   * 傳入後 LLM 會輸出 thinking_delta 事件。
   */
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * 執行指令前 DM 確認設定。
   * 啟用時，run_command 執行前會送 DM 給指定使用者等待確認。
   * 回呼由呼叫端提供（需整合 discord client）。
   */
  execApproval?: {
    enabled: boolean;
    /** 送出純文字 DM 的非同步函式（fallback，sendApprovalDm 優先） */
    sendDm: (dmUserId: string, content: string) => Promise<void>;
    dmUserId: string;
    timeoutMs?: number;
    /**
     * 指令白名單 pattern（substring match）。
     * 指令包含任一 pattern → 自動允許，跳過 DM 確認。
     * 例：["/tmp/", "echo ", "cat "]
     */
    allowedPatterns?: string[];
  };

  /**
   * Session Memory 選項（對話筆記）。
   * 注入：每次 turn 開始前讀取並前置到 system prompt。
   * 萃取：每 intervalTurns 輪 fire-and-forget 萃取一次。
   */
  sessionMemory?: {
    enabled: boolean;
    intervalTurns: number;
    maxHistoryTurns: number;
    memoryDir: string;
  };

  /**
   * 記憶 Recall 選項。
   * 啟用時於 LLM 呼叫前注入向量搜尋結果到 system prompt。
   * 呼叫端不需自行組裝記憶 context 即可注入。
   *
   * ⚠️ 若呼叫端已自行組裝 memory context 至 systemPrompt（如 discord.ts），
   * 請勿同時啟用此選項，否則同一批 atoms 會被注入兩次。
   * 此選項設計用於無前置 recall 的情境（子 agent、cron）。
   */
  memoryRecall?: {
    enabled: boolean;
    /** true = hybrid（vector + trigger），false = 僅 trigger */
    vectorSearch: boolean;
    topK?: number;
  };
}

/** AgentLoop yield 出的事件 */
export type AgentLoopEvent =
  | { type: "text_delta";   text: string }
  | { type: "thinking";     thinking: string }
  | { type: "tool_start";   name: string; id: string; params: unknown }
  | { type: "tool_result";  name: string; id: string; result: unknown; error?: string }
  | { type: "tool_blocked"; name: string; reason: string }
  | { type: "done";         text: string; turnCount: number }
  | { type: "error";        message: string };

// ── TurnTracker ───────────────────────────────────────────────────────────────

interface ToolCallRecord {
  name: string;
  params: unknown;
  result: unknown;
  error?: string;
  durationMs: number;
}

class TurnTracker {
  toolCalls: ToolCallRecord[] = [];
  editCounts = new Map<string, number>();
  private textParts: string[] = [];

  appendText(text: string): void { this.textParts.push(text); }

  getFullResponse(): string { return this.textParts.join(""); }

  recordToolCall(name: string, params: unknown, result: unknown, error: string | undefined, durationMs: number): void {
    this.toolCalls.push({ name, params, result, error, durationMs });
    if (name === "edit_file" || name === "write_file") {
      const path = (params as Record<string, unknown>)["path"] as string | undefined;
      if (path) this.editCounts.set(path, (this.editCounts.get(path) ?? 0) + 1);
    }
  }

  getRutSignals(): string[] {
    const signals: string[] = [];
    for (const [path, count] of this.editCounts) {
      if (count >= 3) signals.push(`same_file_3x:${path}`);
    }
    return signals;
  }

  classifyIntent(): string {
    const names = this.toolCalls.map(c => c.name);
    if (names.some(n => ["write_file", "edit_file"].includes(n))) return "build";
    if (names.some(n => ["run_command"].includes(n))) return "debug";
    if (names.some(n => ["memory_recall"].includes(n))) return "recall";
    if (names.some(n => ["read_file", "glob", "grep"].includes(n))) return "design";
    return "general";
  }
}

// ── before_tool_call hook 鏈 ──────────────────────────────────────────────────

type BeforeToolResult =
  | { blocked: true; reason: string }
  | { blocked: false; params: Record<string, unknown> };

function runBeforeToolCall(
  call: { id: string; name: string; params: Record<string, unknown> },
  ctx: { accountId: string; role?: string; recentCalls: ToolCallRecord[] },
  permissionGate: PermissionGate,
  safetyGuard: SafetyGuard,
): BeforeToolResult {
  // 1. Permission Gate
  const perm = permissionGate.check(ctx.accountId, call.name);
  if (!perm.allowed) return { blocked: true, reason: perm.reason ?? "權限不足" };

  // 2. Safety Guard（含 per-role/per-account 工具權限規則）
  const guard = safetyGuard.check(call.name, call.params, { accountId: ctx.accountId, role: ctx.role });
  if (guard.blocked) return { blocked: true, reason: guard.reason ?? "安全規則阻擋" };

  // 3. Tool Loop Detection（同一 tool 連續 5 次）
  const recentSame = ctx.recentCalls.slice(-5).filter(c => c.name === call.name);
  if (recentSame.length >= 5) {
    return { blocked: true, reason: `偵測到工具迴圈：${call.name} 連續呼叫超過 5 次` };
  }

  // 3b. Alternating Tool Cycle Detection（period-2：A→B→A→B→A…）
  // 最近 4 次呼叫為 [X, Y, X, Y]，且當前要再呼叫 X → 封鎖
  if (ctx.recentCalls.length >= 4) {
    const r4 = ctx.recentCalls.slice(-4).map(c => c.name);
    if (r4[0] === r4[2] && r4[1] === r4[3] && r4[0] !== r4[1] && call.name === r4[0]) {
      return { blocked: true, reason: `偵測到交替工具迴圈：${r4[1]}↔${r4[0]}（已重複 2 輪）` };
    }
  }

  return { blocked: false, params: call.params };
}

// ── Agent Loop（主函式）────────────────────────────────────────────────────────

/**
 * agentLoop：核心對話迴圈，yield AgentLoopEvent
 *
 * 呼叫端負責：
 * - 取得 provider、sessionManager 等依賴
 * - 消費 events（串流回覆 + 追蹤）
 */
export async function* agentLoop(
  prompt: string,
  opts: AgentLoopOpts,
  deps: {
    sessionManager: SessionManager;
    permissionGate: PermissionGate;
    toolRegistry: ToolRegistry;
    safetyGuard: SafetyGuard;
    eventBus: EventBus;
    /** 可選記憶引擎，配合 opts.memoryRecall 使用 */
    memoryEngine?: MemoryEngine;
  },
): AsyncGenerator<AgentLoopEvent> {
  const { sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus } = deps;
  const { channelId, accountId, provider, projectId } = opts;
  const platform = opts.platform ?? "discord";
  const spawnDepth = opts.spawnDepth ?? 0;
  const trace = opts.trace;
  // allowSpawn: depth ≥ 2 強制 false（最多 3 層）；opts.allowSpawn 明確 false 也關閉
  const allowSpawn = opts.allowSpawn !== false && spawnDepth < 2;

  // ── 1. 進門權限檢查 ────────────────────────────────────────────────────────
  const accessResult = permissionGate.checkAccess(accountId);
  if (!accessResult.allowed) {
    yield { type: "error", message: `存取拒絕：${accessResult.reason}` };
    return;
  }

  // ── 2. Session + messages ──────────────────────────────────────────────────
  const sessionKey = opts._sessionKeyOverride ?? `${platform}:ch:${channelId}`;

  // Turn Queue：序列化同一 session 的並發 turn，防止歷史交錯
  try {
    await sessionManager.enqueueTurn({ sessionKey, accountId, prompt, signal: opts.signal });
  } catch (err) {
    yield { type: "error", message: `session 佇列：${err instanceof Error ? err.message : String(err)}` };
    return;
  }

  // ── 以下受 Turn Queue 保護（讀 session → 執行 → 寫回 → dequeueTurn）──────
  try {

  const session = sessionManager.getOrCreate(sessionKey, accountId, channelId, opts.provider.id);

  // Session Snapshot（turn 開始前快照）
  const snapshotStore = getSessionSnapshotStore();
  if (snapshotStore) {
    snapshotStore.save(sessionKey, session.turnCount, session.messages);
  }

  // ContextEngine：套用 CE strategies（compaction / budget-guard / sliding-window）
  const rawHistory = sessionManager.getHistory(sessionKey);
  const contextEngine = getContextEngine();
  let processedHistory: Message[];
  if (contextEngine) {
    processedHistory = await contextEngine.build(rawHistory, {
      sessionKey,
      turnIndex: session.turnCount,
    });
    // S2: 有 strategy 觸發 → 把壓縮後的 messages 寫回 session（含備份原始）
    if (contextEngine.lastBuildBreakdown.strategiesApplied.length > 0) {
      sessionManager.replaceMessages(sessionKey, processedHistory);
    }
  } else {
    processedHistory = rawHistory;
  }

  // Trace: Context Engineering 記錄
  if (trace && contextEngine) {
    const bd = contextEngine.lastBuildBreakdown;
    trace.recordCE({
      strategiesApplied: bd.strategiesApplied,
      tokensBeforeCE: bd.tokensBeforeCE ?? bd.estimatedTokens,
      tokensAfterCE: bd.tokensAfterCE ?? bd.estimatedTokens,
    });
  }

  // Context overflow 三段 failover 第三段：CE 偵測到超硬上限 → 終止
  if (contextEngine?.lastBuildBreakdown.overflowSignaled) {
    yield { type: "error", message: "context_overflow: Context 已達上限，建議輸入 /rollback 或開新對話" };
    return;
  }

  // 若有圖片附件，建立混合 content blocks（文字 + 圖片）
  const firstUserContent: string | ContentBlock[] = (() => {
    if (!opts.imageAttachments?.length) return prompt;
    const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
    for (const img of opts.imageAttachments) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType } satisfies ImageBlock);
    }
    return blocks;
  })();

  const messages: Message[] = [
    ...processedHistory,
    { role: "user", content: firstUserContent },
  ];

  // ── 3. Tool list（物理過濾）─────────────────────────────────────────────────
  let toolDefs = permissionGate.listAvailable(accountId);
  // allowSpawn:false → 邏輯面過濾，子 agent 看不到 spawn_subagent
  if (!allowSpawn) {
    toolDefs = toolDefs.filter(d => d.name !== "spawn_subagent");
  }

  // ── 3b. Memory Recall（可選，供子 agent 等無前置 recall 的情境使用）──────────
  let memoryContextBlock = "";
  if (opts.memoryRecall?.enabled && deps.memoryEngine) {
    try {
      const recallResult = await deps.memoryEngine.recall(
        prompt,
        { accountId, projectId },
        { vectorSearch: opts.memoryRecall.vectorSearch, vectorTopK: opts.memoryRecall.topK ?? 5 },
      );
      if (recallResult.fragments.length > 0) {
        const ctx = deps.memoryEngine.buildContext(recallResult.fragments, prompt, recallResult.blindSpot);
        memoryContextBlock = ctx.text;
        log.debug(`[agent-loop] memory recall 注入 ${recallResult.fragments.length} fragments (vectorSearch=${opts.memoryRecall.vectorSearch})`);
      }
    } catch (err) {
      log.debug(`[agent-loop] memory recall 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. System prompt + 群組多人聲明 ────────────────────────────────────────
  let systemPrompt = opts.systemPrompt ?? "";
  // memory context 前置到 system prompt
  if (memoryContextBlock) {
    systemPrompt = memoryContextBlock + (systemPrompt ? `\n\n${systemPrompt}` : "");
  }
  if (opts.isGroupChannel && opts.speakerDisplay) {
    const isolation = `[多人頻道] 當前說話者：${opts.speakerDisplay}（${accountId}/${opts.speakerRole ?? "member"}）`;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${isolation}` : isolation;
  }

  // ── 4b. Token Budget Nudge（參考 Claude Code tokenBudget.ts）────────────────
  // 當 context 使用率超過 60%，主動提示 LLM 簡潔回應；超過 70% 加強提示
  if (contextEngine) {
    const estimatedTokens = contextEngine.lastBuildBreakdown.estimatedTokens;
    const windowTokens = contextEngine.getContextWindowTokens();
    const ratio = windowTokens > 0 ? estimatedTokens / windowTokens : 0;
    let nudge = "";
    if (ratio >= 0.70) {
      nudge = `【Context 已用 ${Math.round(ratio * 100)}%，接近上限】請儘量簡短回應，避免冗長說明。`;
    } else if (ratio >= 0.60) {
      nudge = `【Context 使用 ${Math.round(ratio * 100)}%】請保持回應簡潔。`;
    }
    if (nudge) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${nudge}` : nudge;
      log.debug(`[agent-loop] token-budget-nudge ratio=${ratio.toFixed(2)} appended`);
    }
  }

  // ── 4c. Session Note 注入（參考 Claude Code SessionMemory）───────────────────
  if (opts.sessionMemory?.enabled) {
    const note = getSessionNote(opts.sessionMemory.memoryDir, channelId);
    if (note) {
      systemPrompt = note + (systemPrompt ? `\n\n${systemPrompt}` : "");
      log.debug(`[agent-loop] session-note 已注入 channelId=${channelId.slice(-8)}`);
    }
  }

  // ── 5. Turn abort signal ───────────────────────────────────────────────────
  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort());
  }
  registerTurnAbort(sessionKey, controller);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (opts.turnTimeoutMs) {
    timeoutHandle = setTimeout(() => controller.abort(), opts.turnTimeoutMs);
  }

  const tracker = new TurnTracker();
  let loopCount = 0;
  const turnStartMs = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let lastModel: string | undefined;
  let lastProviderType: string | undefined;
  let lastEstimated = false;
  let turnToolResultTokens = 0; // per-turn 工具結果 token 累計（省 token 用）

  eventBus.emit("turn:before", { accountId, channelId, sessionKey, prompt, projectId });

  log.debug(`[agent-loop] ── turn 開始 ── sessionKey=${sessionKey} turnCount=${session.turnCount} accountId=${accountId} history=${processedHistory.length} msgs systemPrompt=${systemPrompt.length} chars`);

  try {
    while (loopCount++ < MAX_LOOPS) {
      // ── abort 快速出口（/stop 或 timeout 觸發後，下一輪不再呼叫 LLM）────
      if (controller.signal.aborted) break;

      // ── 5a. LLM 呼叫（帶重試）────────────────────────────────────────────
      log.debug(`[agent-loop] [loop=${loopCount}] 呼叫 LLM msgs=${messages.length}`);
      trace?.recordLLMCallStart(loopCount);
      let streamResult;
      try {
        streamResult = await callWithRetry(
          () => provider.stream(messages, {
            systemPrompt: systemPrompt || undefined,
            tools: toolDefs.length > 0 ? toolDefs.map(d => ({
              name: d.name,
              description: d.description,
              input_schema: d.input_schema,
            })) : undefined,
            abortSignal: controller.signal,
            ...(opts.thinking ? { thinking: opts.thinking } : {}),
          }),
          {
            maxAttempts: opts.retryMaxAttempts ?? 3,
            baseMs: opts.retryBaseMs ?? 1000,
            maxMs: opts.retryMaxMs ?? 30_000,
            signal: controller.signal,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 使用者主動中止（/stop 或外部 signal）→ 靜默退出，不送 Discord 錯誤訊息
        if (controller.signal.aborted) {
          log.debug(`[agent-loop] turn 已中止（abort signal），靜默退出`);
          return;
        }
        log.warn(`[agent-loop] LLM 呼叫失敗 provider=${provider.id} loop=${loopCount}: ${msg}`);
        // 辨識「所有憑證耗盡」→ 不重試，直接回報
        if (msg.includes("所有 API 憑證都在 cooldown")) {
          yield { type: "error", message: msg };
          return;
        }
        yield { type: "error", message: `LLM 呼叫失敗：[${provider.id}] ${msg}` };
        eventBus.emit("provider:error", provider.id, err instanceof Error ? err : new Error(msg));
        return;
      }

      // ── 5b. 消費串流事件 ───────────────────────────────────────────────────
      for await (const event of streamResult.events as AsyncIterable<ProviderEvent>) {
        if (event.type === "text_delta") {
          tracker.appendText(event.text);
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "thinking_delta") {
          yield { type: "thinking", thinking: event.thinking };
        }
      }

      totalInputTokens += streamResult.usage.input;
      totalOutputTokens += streamResult.usage.output;
      totalCacheRead += streamResult.usage.cacheRead ?? 0;
      totalCacheWrite += streamResult.usage.cacheWrite ?? 0;
      lastModel = streamResult.usage.model;
      lastProviderType = streamResult.usage.providerType;
      if (streamResult.usage.estimated) lastEstimated = true;

      // Trace: LLM call 結束
      trace?.recordLLMCallEnd({
        model: streamResult.usage.model ?? "",
        provider: streamResult.usage.providerType ?? provider.id,
        inputTokens: streamResult.usage.input,
        outputTokens: streamResult.usage.output,
        cacheRead: streamResult.usage.cacheRead ?? 0,
        cacheWrite: streamResult.usage.cacheWrite ?? 0,
        estimated: streamResult.usage.estimated ?? false,
        stopReason: streamResult.stopReason,
      });

      if (controller.signal.aborted) break;
      if (streamResult.stopReason === "end_turn") break;
      if (streamResult.stopReason !== "tool_use") break;
      if (streamResult.toolCalls.length === 0) break;

      // ── 5c. Tool 執行 ──────────────────────────────────────────────────────
      log.debug(`[agent-loop] [loop=${loopCount}] 執行 ${streamResult.toolCalls.length} 個 tool: ${streamResult.toolCalls.map(t => t.name).join(", ")}`);
      const toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];

      // 先把 assistant 的 tool_use 加入 messages（B: 標記 token 數）
      messages.push({
        role: "assistant",
        content: streamResult.toolCalls.map(tc => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.name,
          input: tc.params as object,
        })),
        tokens: streamResult.usage.output > 0 ? streamResult.usage.output : undefined,
      });

      // spawn_subagent 並行：同一輪多個 spawn_subagent → Promise.all（其他 tool 維持串行）
      const spawnCalls = streamResult.toolCalls.filter(tc => tc.name === "spawn_subagent");
      const otherCalls = streamResult.toolCalls.filter(tc => tc.name !== "spawn_subagent");

      if (spawnCalls.length > 1) {
        // 並行執行（不在 callback 裡 yield，收集後統一 yield）
        type SpawnEvent = AgentLoopEvent;
        type SpawnBatchResult = {
          toolResult: { tool_use_id: string; content: string; is_error: boolean };
          events: SpawnEvent[];
          toolRecord: { name: string; params: unknown; result: unknown; error?: string; durationMs: number };
        };

        const batchResults = await Promise.all(spawnCalls.map(async (call): Promise<SpawnBatchResult> => {
          const params = call.params as Record<string, unknown>;
          const toolCtx: ToolContext = { accountId, projectId, sessionId: sessionKey, channelId, eventBus, spawnDepth, parentRunId: opts.parentRunId };
          const events: SpawnEvent[] = [];
          const hookResult = runBeforeToolCall(
            { id: call.id, name: call.name, params },
            { accountId, role: opts.speakerRole, recentCalls: tracker.toolCalls },
            permissionGate, safetyGuard,
          );
          if (hookResult.blocked) {
            events.push({ type: "tool_blocked", name: call.name, reason: hookResult.reason });
            return {
              toolResult: { tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true },
              events,
              toolRecord: { name: call.name, params, result: null, error: hookResult.reason, durationMs: 0 },
            };
          }
          if (opts.showToolCalls !== "none") {
            events.push({ type: "tool_start", name: call.name, id: call.id, params: hookResult.params });
          }
          const t0 = Date.now();
          const toolResult = await toolRegistry.execute(call.name, hookResult.params, toolCtx);
          const durationMs = Date.now() - t0;
          const rawText = toolResult.error ? `錯誤：${toolResult.error}` : JSON.stringify(toolResult.result ?? null);
          const tokenCap = resolveResultTokenCap(toolRegistry.get(call.name)?.resultTokenCap, turnToolResultTokens);
          const resultText = truncateToolResult(rawText, tokenCap);
          events.push({ type: "tool_result", name: call.name, id: call.id, result: toolResult.result, error: toolResult.error });
          return {
            toolResult: { tool_use_id: call.id, content: resultText, is_error: Boolean(toolResult.error) },
            events,
            toolRecord: { name: call.name, params: hookResult.params, result: toolResult.result, error: toolResult.error, durationMs },
          };
        }));

        // 按序 yield 收集到的事件
        for (const batch of batchResults) {
          for (const evt of batch.events) yield evt;
          toolResults.push(batch.toolResult);
          turnToolResultTokens += Math.ceil(batch.toolResult.content.length / 4);
          tracker.recordToolCall(batch.toolRecord.name, batch.toolRecord.params, batch.toolRecord.result, batch.toolRecord.error, batch.toolRecord.durationMs);
          trace?.recordToolCall({
            name: batch.toolRecord.name,
            durationMs: batch.toolRecord.durationMs,
            error: batch.toolRecord.error,
            resultPreview: batch.toolRecord.error ?? String(batch.toolRecord.result ?? "").slice(0, 100),
          });
        }
      }

      const serialCalls = spawnCalls.length > 1 ? otherCalls : streamResult.toolCalls;

      for (const call of serialCalls) {
        const params = call.params as Record<string, unknown>;
        const toolCtx: ToolContext = {
          accountId,
          projectId,
          sessionId: sessionKey,
          channelId,
          eventBus,
          spawnDepth,
          parentRunId: opts.parentRunId,
        };

        // before_tool_call
        const hookResult = runBeforeToolCall(
          { id: call.id, name: call.name, params },
          { accountId, role: opts.speakerRole, recentCalls: tracker.toolCalls },
          permissionGate,
          safetyGuard,
        );

        if (hookResult.blocked) {
          yield { type: "tool_blocked", name: call.name, reason: hookResult.reason };
          toolResults.push({ tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true });
          continue;
        }

        // ── Exec Approval（run_command / write_file / edit_file DM 確認）────────
        const _approvalTools = ["run_command", "write_file", "edit_file"];
        if (_approvalTools.includes(call.name) && opts.execApproval?.enabled) {
          const p = hookResult.params as Record<string, unknown>;
          // 組成可讀的操作描述
          let displayCmd: string;
          if (call.name === "run_command") {
            displayCmd = String(p["command"] ?? "");
          } else if (call.name === "write_file") {
            displayCmd = `write_file ${String(p["path"] ?? p["file_path"] ?? "")}`;
          } else {
            displayCmd = `edit_file ${String(p["path"] ?? p["file_path"] ?? "")}`;
          }
          const timeoutMs = opts.execApproval.timeoutMs ?? 60_000;

          // 白名單檢查
          if (isCommandAllowed(displayCmd, opts.execApproval.allowedPatterns ?? [])) {
            log.debug(`[agent-loop] exec-approval 白名單通過，自動允許 command="${displayCmd.slice(0, 80)}"`);
          } else {
            const [approvalId, approvalPromise] = createApproval(displayCmd, channelId, timeoutMs);
            try {
              await sendApprovalDm({
                dmUserId: opts.execApproval.dmUserId,
                command: displayCmd,
                channelId,
                approvalId,
                timeoutMs,
                sendTextFallback: opts.execApproval.sendDm,
              });
              log.info(`[agent-loop] exec-approval 等待確認 approvalId=${approvalId} command="${displayCmd.slice(0, 80)}"`);
            } catch (err) {
              log.warn(`[agent-loop] exec-approval 送 DM 失敗，自動拒絕：${err instanceof Error ? err.message : String(err)}`);
              toolResults.push({ tool_use_id: call.id, content: "錯誤：DM 確認失敗，操作未執行", is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: "DM 確認失敗" };
              continue;
            }
            const approved = await approvalPromise;
            if (!approved) {
              log.info(`[agent-loop] exec-approval 拒絕 approvalId=${approvalId}`);
              toolResults.push({ tool_use_id: call.id, content: "錯誤：使用者拒絕執行（或確認逾時）", is_error: true });
              yield { type: "tool_blocked", name: call.name, reason: "使用者拒絕執行操作" };
              continue;
            }
            log.info(`[agent-loop] exec-approval 允許 approvalId=${approvalId}`);
          }
        }

        if (opts.showToolCalls !== "none") {
          yield { type: "tool_start", name: call.name, id: call.id, params: hookResult.params };
        }

        eventBus.emit("tool:before", { id: call.id, name: call.name, params: hookResult.params });
        const t0 = Date.now();

        const toolResult = await toolRegistry.execute(call.name, hookResult.params, toolCtx);
        const durationMs = Date.now() - t0;

        if (toolResult.error) {
          eventBus.emit("tool:error", { id: call.id, name: call.name, params: hookResult.params }, new Error(toolResult.error));
        } else {
          eventBus.emit("tool:after", { id: call.id, name: call.name, params: hookResult.params }, toolResult);
          if (toolResult.fileModified && toolResult.modifiedPath) {
            eventBus.emit("file:modified", toolResult.modifiedPath, call.name, accountId);
          }
        }

        tracker.recordToolCall(call.name, hookResult.params, toolResult.result, toolResult.error, durationMs);
        // Trace: tool call 記錄
        trace?.recordToolCall({
          name: call.name,
          durationMs,
          error: toolResult.error,
          resultPreview: toolResult.error ? toolResult.error : String(toolResult.result ?? "").slice(0, 100),
        });
        if (toolResult.error) {
          log.debug(`[agent-loop] [使用工具] (${call.name}) :: error ${durationMs}ms — ${toolResult.error}`);
        } else {
          log.debug(`[agent-loop] [使用工具] (${call.name}) :: ok ${durationMs}ms`);
        }

        const rawResultText = toolResult.error
          ? `錯誤：${toolResult.error}`
          : JSON.stringify(toolResult.result ?? null);
        const cap = resolveResultTokenCap(toolRegistry.get(call.name)?.resultTokenCap, turnToolResultTokens);
        const resultText = truncateToolResult(rawResultText, cap);
        if (resultText.length < rawResultText.length) {
          log.debug(`[agent-loop] [使用工具] (${call.name}) :: result truncated ${rawResultText.length} → ${resultText.length} chars`);
        }
        turnToolResultTokens += Math.ceil(resultText.length / 4);

        toolResults.push({
          tool_use_id: call.id,
          content: resultText,
          is_error: Boolean(toolResult.error),
        });

        yield {
          type: "tool_result",
          name: call.name,
          id: call.id,
          result: toolResult.result,
          error: toolResult.error,
        };
      }

      // 把 tool results 加入 messages
      messages.push(makeToolResultMessage(toolResults));
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    clearTurnAbort(sessionKey);
  }

  // ── 6. Turn 結束 ────────────────────────────────────────────────────────────
  const fullResponse = tracker.getFullResponse();

  // Tool Log Store：儲存 tool 執行記錄，session history 加索引摘要
  const toolLogStore = getToolLogStore();
  let toolLogPath: string | null = null;
  const extraMessages: Message[] = [];
  if (toolLogStore && tracker.toolCalls.length > 0) {
    toolLogPath = toolLogStore.save(
      sessionKey,
      session.turnCount,
      tracker.toolCalls.map(tc => ({
        id: Math.random().toString(36).slice(2),
        name: tc.name,
        params: tc.params,
        result: tc.result,
        error: tc.error,
        durationMs: tc.durationMs,
      })),
    );
    if (toolLogPath) {
      const summary = ToolLogStore.buildIndexSummary(
        tracker.toolCalls.map(tc => ({ id: "", name: tc.name, params: tc.params, result: tc.result, error: tc.error, durationMs: tc.durationMs })),
        toolLogPath,
      );
      extraMessages.push({ role: "user" as const, content: summary });
    }
  }

  // 儲存 turn 到 session（B: 標記 per-message token 數）
  const promptTokens = Math.ceil(prompt.length / 4);
  const responseTokens = totalOutputTokens > 0 ? totalOutputTokens : Math.ceil(fullResponse.length / 4);
  sessionManager.addMessages(sessionKey, [
    { role: "user", content: prompt, tokens: promptTokens },
    { role: "assistant", content: fullResponse, tokens: responseTokens },
    ...extraMessages,
  ]);

  eventBus.emit("turn:after", { accountId, channelId, sessionKey, prompt, projectId }, fullResponse);

  // Session Snapshot：正常完成 → 刪除快照（CE 壓縮時保留 48h）
  if (snapshotStore) {
    const ceApplied = (contextEngine?.lastBuildBreakdown?.strategiesApplied?.length ?? 0) > 0;
    if (!ceApplied) {
      snapshotStore.delete(sessionKey, session.turnCount);
    }
    // CE 壓縮時快照在 save 時已設定 expiresAt=48h，不需額外操作
  }

  // ── Session Note 萃取（fire-and-forget）────────────────────────────────────
  if (opts.sessionMemory?.enabled) {
    const sessionAfterForNote = sessionManager.get(sessionKey) ?? session;
    const turnCountForNote = sessionAfterForNote.turnCount;
    const historyForNote = sessionManager.getHistory(sessionKey);
    checkAndSaveNote(channelId, turnCountForNote, historyForNote, opts.sessionMemory.memoryDir, {
      enabled: true,
      intervalTurns: opts.sessionMemory.intervalTurns,
      maxHistoryTurns: opts.sessionMemory.maxHistoryTurns,
    }).catch(() => { /* 靜默 */ });
  }

  // Trace: Post-process + Finalize
  if (trace) {
    const ceApplied = (contextEngine?.lastBuildBreakdown?.strategiesApplied?.length ?? 0) > 0;
    trace.recordPostProcess({
      extractRan: false, // extract 在 discord.ts 的 handleAgentLoopReply 中 fire-and-forget
      sessionSnapshotKept: ceApplied,
      sessionNoteUpdated: !!opts.sessionMemory?.enabled,
      toolLogPath: toolLogPath ?? undefined,
    });
    trace.recordResponse(fullResponse, Date.now() - turnStartMs);

    // 如果是 abort 導致的退出（loopCount 沒到但 response 為空），標記
    if (controller.signal.aborted) {
      trace.recordAbort("stop", !!snapshotStore);
    }

    // 持久化
    const traceStore = getTraceStore();
    if (traceStore) {
      traceStore.append(trace.finalize());
    }
  }

  // Turn Audit Log 記錄
  const auditLog = getTurnAuditLog();
  if (auditLog) {
    const sessionAfter = sessionManager.get(sessionKey) ?? session;
    const ceBreakdown = contextEngine?.lastBuildBreakdown;
    auditLog.append({
      ts: new Date().toISOString(),
      platform,
      sessionKey,
      channelId,
      accountId,
      turnIndex: sessionAfter?.turnCount ?? 0,
      phase: {
        inboundReceivedMs: turnStartMs,
        completedMs: Date.now(),
      },
      ceApplied: ceBreakdown?.strategiesApplied ?? [],
      tokensBeforeCE: ceBreakdown?.tokensBeforeCE,
      tokensAfterCE: ceBreakdown?.tokensAfterCE,
      model: lastModel,
      providerType: lastProviderType,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      cacheRead: totalCacheRead > 0 ? totalCacheRead : undefined,
      cacheWrite: totalCacheWrite > 0 ? totalCacheWrite : undefined,
      estimated: lastEstimated || undefined,
      toolCalls: tracker.toolCalls.length,
      toolLogPath: toolLogPath ?? undefined,
      startTimeMs: turnStartMs,
      durationMs: Date.now() - turnStartMs,
      toolDurations: tracker.toolCalls.reduce<Record<string, number[]>>((acc, tc) => {
        (acc[tc.name] ??= []).push(tc.durationMs);
        return acc;
      }, {}),
    });
  }

  yield { type: "done", text: fullResponse, turnCount: loopCount };
  log.debug(`[agent-loop] ── turn 完成 ── accountId=${accountId} channelId=${channelId} loops=${loopCount} tools=${tracker.toolCalls.length}`);

  } finally {
    // Turn Queue 釋放：無論成功、錯誤、或 abort，都讓下一個 turn 繼續
    sessionManager.dequeueTurn(sessionKey);
  }
}
