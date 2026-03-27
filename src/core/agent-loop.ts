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
import type { LLMProvider, Message, ProviderEvent } from "../providers/base.js";
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
   * 記憶 Recall 選項。
   * 啟用時於 LLM 呼叫前注入向量搜尋結果到 system prompt。
   * 呼叫端不需自行組裝記憶 context 即可注入。
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
  ctx: { accountId: string; recentCalls: ToolCallRecord[] },
  permissionGate: PermissionGate,
  safetyGuard: SafetyGuard,
): BeforeToolResult {
  // 1. Permission Gate
  const perm = permissionGate.check(ctx.accountId, call.name);
  if (!perm.allowed) return { blocked: true, reason: perm.reason ?? "權限不足" };

  // 2. Safety Guard
  const guard = safetyGuard.check(call.name, call.params);
  if (guard.blocked) return { blocked: true, reason: guard.reason ?? "安全規則阻擋" };

  // 3. Tool Loop Detection（同一 tool 連續 5 次）
  const recentSame = ctx.recentCalls.slice(-5).filter(c => c.name === call.name);
  if (recentSame.length >= 5) {
    return { blocked: true, reason: `偵測到工具迴圈：${call.name} 連續呼叫超過 5 次` };
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
  } else {
    processedHistory = rawHistory;
  }

  // Context overflow 三段 failover 第三段：CE 偵測到超硬上限 → 終止
  if (contextEngine?.lastBuildBreakdown.overflowSignaled) {
    yield { type: "error", message: "context_overflow: Context 已達上限，建議輸入 /rollback 或開新對話" };
    return;
  }

  const messages: Message[] = [
    ...processedHistory,
    { role: "user", content: prompt },
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
        const ctx = deps.memoryEngine.buildContext(recallResult.fragments, prompt);
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

  eventBus.emit("turn:before", { accountId, channelId, sessionKey, prompt, projectId });

  try {
    while (loopCount++ < MAX_LOOPS) {
      // ── 5a. LLM 呼叫（帶重試）────────────────────────────────────────────
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
        yield { type: "error", message: `LLM 呼叫失敗：${msg}` };
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

      if (streamResult.stopReason === "end_turn") break;
      if (streamResult.stopReason !== "tool_use") break;
      if (streamResult.toolCalls.length === 0) break;

      // ── 5c. Tool 執行 ──────────────────────────────────────────────────────
      const toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];

      // 先把 assistant 的 tool_use 加入 messages
      messages.push({
        role: "assistant",
        content: streamResult.toolCalls.map(tc => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.name,
          input: tc.params as object,
        })),
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
          const toolCtx: ToolContext = { accountId, projectId, sessionId: sessionKey, channelId, eventBus, spawnDepth };
          const events: SpawnEvent[] = [];
          const hookResult = runBeforeToolCall(
            { id: call.id, name: call.name, params },
            { accountId, recentCalls: tracker.toolCalls },
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
          const tokenCap = toolRegistry.get(call.name)?.resultTokenCap ?? DEFAULT_RESULT_TOKEN_CAP;
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
          tracker.recordToolCall(batch.toolRecord.name, batch.toolRecord.params, batch.toolRecord.result, batch.toolRecord.error, batch.toolRecord.durationMs);
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
        };

        // before_tool_call
        const hookResult = runBeforeToolCall(
          { id: call.id, name: call.name, params },
          { accountId, recentCalls: tracker.toolCalls },
          permissionGate,
          safetyGuard,
        );

        if (hookResult.blocked) {
          yield { type: "tool_blocked", name: call.name, reason: hookResult.reason };
          toolResults.push({ tool_use_id: call.id, content: `錯誤：${hookResult.reason}`, is_error: true });
          continue;
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

        const rawResultText = toolResult.error
          ? `錯誤：${toolResult.error}`
          : JSON.stringify(toolResult.result ?? null);
        const cap = toolRegistry.get(call.name)?.resultTokenCap ?? DEFAULT_RESULT_TOKEN_CAP;
        const resultText = truncateToolResult(rawResultText, cap);

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

  // 儲存 turn 到 session
  sessionManager.addMessages(sessionKey, [
    { role: "user", content: prompt },
    { role: "assistant", content: fullResponse },
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
      toolCalls: tracker.toolCalls.length,
      toolLogPath: toolLogPath ?? undefined,
      durationMs: Date.now() - turnStartMs,
    });
  }

  yield { type: "done", text: fullResponse, turnCount: loopCount };
  log.debug(`[agent-loop] done accountId=${accountId} channelId=${channelId} loops=${loopCount} tools=${tracker.toolCalls.length}`);
}
