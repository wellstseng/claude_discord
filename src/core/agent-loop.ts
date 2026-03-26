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

// ── 常數 ─────────────────────────────────────────────────────────────────────

const MAX_LOOPS = 20;

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
  },
): AsyncGenerator<AgentLoopEvent> {
  const { sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus } = deps;
  const { channelId, accountId, provider, projectId } = opts;
  const platform = opts.platform ?? "discord";

  // ── 1. 進門權限檢查 ────────────────────────────────────────────────────────
  const accessResult = permissionGate.checkAccess(accountId);
  if (!accessResult.allowed) {
    yield { type: "error", message: `存取拒絕：${accessResult.reason}` };
    return;
  }

  // ── 2. Session + messages ──────────────────────────────────────────────────
  const sessionKey = `${platform}:ch:${channelId}`;
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

  const messages: Message[] = [
    ...processedHistory,
    { role: "user", content: prompt },
  ];

  // ── 3. Tool list（物理過濾）─────────────────────────────────────────────────
  const toolDefs = permissionGate.listAvailable(accountId);

  // ── 4. System prompt + 群組多人聲明 ────────────────────────────────────────
  let systemPrompt = opts.systemPrompt ?? "";
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
      // ── 5a. LLM 呼叫 ──────────────────────────────────────────────────────
      let streamResult;
      try {
        streamResult = await provider.stream(messages, {
          systemPrompt: systemPrompt || undefined,
          tools: toolDefs.length > 0 ? toolDefs.map(d => ({
            name: d.name,
            description: d.description,
            input_schema: d.input_schema,
          })) : undefined,
          abortSignal: controller.signal,
        });
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

      for (const call of streamResult.toolCalls) {
        const params = call.params as Record<string, unknown>;
        const toolCtx: ToolContext = {
          accountId,
          projectId,
          sessionId: sessionKey,
          channelId,
          eventBus,
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

        const resultText = toolResult.error
          ? `錯誤：${toolResult.error}`
          : JSON.stringify(toolResult.result ?? null);

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
