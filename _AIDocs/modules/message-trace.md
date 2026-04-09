# Message Lifecycle Trace — 訊息全鏈路追蹤

> 原始碼：`src/core/message-trace.ts`
> 更新日期：2026-04-09

## 概述

追蹤每條 Discord 訊息從接收到回覆的完整處理過程。7 個階段的結構化記錄，支援 dashboard 視覺化查詢。
支援 subagent 父子追蹤（parentTraceId）、agent 身份標記（agentId）、費用估算、context snapshot 模組模式。

## 架構

### MessageTrace（收集器）

累積式收集器，由 `discord.ts` debounce 觸發後建立（`MessageTrace.create(turnId, channelId, accountId, category?)`），傳入 `agentLoop` opts，各模組呼叫 `record*()` 累積數據，最後 `finalize()` 產出完整記錄。

分類（TraceCategory）：`"discord"` | `"subagent"` | `"cron"` | `"api"`

### TraceStore（持久化）

- 格式：JSONL（`data/traces/YYYY-MM-DD.jsonl`）
- 保留：30 天 rolling
- 初始化：`platform.ts` 啟動時 `initTraceStore(dataDir)`
- 查詢：`recent(limit, filter?)` / `getById(traceId)` / `bySession(sessionKey)` / `byParent(parentTraceId)`
- 刪除：`deleteBySession(sessionKey)` — 從 JSONL 中過濾移除

### TraceContextStore（context snapshot 持久化）

- 格式：JSON（`data/trace-contexts/YYYY-MM-DD/{traceId}.json`）
- 保留：30 天 rolling（與 TraceStore 同步）
- 獨立存放完整 system prompt + messages，避免 JSONL 過度膨脹
- 支援模組模式：`promptBreakdown.segments[]` 記錄各段落在 systemPrompt 中的 offset + length

## 7 階段追蹤

| 階段 | 記錄位置 | 記錄方法 | 內容 |
|------|---------|---------|------|
| ① Inbound | discord.ts | `recordInbound()` | 原始文字 preview、字數、附件數、debounce 資訊、是否中斷前次 |
| ② Context | discord.ts / agent-loop | `recordContextStart/End()` + `recordMemoryRecall()` + `recordPromptAssembly()` + `recordProviderSelection()` + `recordInboundHistory()` + `appendAgentLoopBlocks()` | memory recall（atom 命中明細、blind-spot、cache hit）、prompt 組裝模組、provider 選擇、inbound history |
| ③ LLM Loop | agent-loop.ts | `recordLLMCallStart/End()` + `recordToolCall()` | 每次 LLM call 的 model、input/output/cache tokens、estimated 標記、duration、tool calls（含 paramsPreview） |
| ④ CE | agent-loop.ts | `recordCE()` | 觸發的 strategy、壓縮前後 token 差 |
| ⑤ Abort | agent-loop.ts | `recordAbort()` | 觸發原因（stop/timeout/interrupt）、是否 rollback |
| ⑥ PostProcess | agent-loop.ts | `recordPostProcess()` | extract 是否執行、snapshot 是否保留、session note、tool log 路徑 |
| ⑦ Response | agent-loop.ts | `recordResponse()` | 回覆 preview、字數、總 duration |

### 附加追蹤

| 方法 | 說明 |
|------|------|
| `recordWorkflowEvent(type, detail)` | wisdom/rut/oscillation/sync 等工作流事件 |
| `recordContextSnapshot(opts)` | 完整 system prompt + messages 存入 TraceContextStore |
| `recordError(error)` | 錯誤訊息 + status 標記 |

## 費用估算

`finalize()` 時依 `MODEL_PRICING` 表計算 `estimatedCostUsd`：

| 模型 | input/1M | output/1M | cacheRead/1M | cacheWrite/1M |
|------|---------|----------|-------------|--------------|
| claude-opus-4-6 | $15 | $75 | $1.5 | $18.75 |
| claude-sonnet-4-6 | $3 | $15 | $0.3 | $3.75 |
| claude-sonnet-4-5-20250514 | $3 | $15 | $0.3 | $3.75 |
| claude-haiku-4-5-20251001 | $0.8 | $4 | $0.08 | $1 |
| gpt-4o | $2.5 | $10 | $1.25 | $0 |
| gpt-4o-mini | $0.15 | $0.6 | $0.075 | $0 |

Ollama / unknown model → $0（免費）。

## TracePromptBreakdown（模組模式）

```typescript
interface TracePromptBreakdown {
  memoryContext?: string;          // Memory recall 注入的原始文字
  channelOverride?: string;        // 頻道 system prompt 覆寫
  modeExtras?: string;             // Mode preset 額外 prompt
  assemblerModules: string[];      // prompt-assembler 模組（按 priority）
  agentLoopBlocks: string[];       // agent-loop 追加區塊
  segments?: TracePromptSegment[]; // 各段落 offset + length（模組模式切割顯示���
}
```

## Dashboard API

| 端點 | 說明 |
|------|------|
| `GET /api/traces?limit=N` | 最近 N 筆 trace 列表（預設 50） |
| `GET /api/traces/:traceId` | 單筆 trace 完整詳情 |
| `GET /api/traces/:traceId/context` | Context snapshot（lazy-load） |

## 關鍵型別

```typescript
interface MessageTraceEntry {
  traceId: string;          // turnId (UUID)
  messageId?: string;       // Discord message ID
  channelId, accountId, sessionKey?, ts;

  // 分類
  category?: TraceCategory;
  parentTraceId?: string;   // subagent 父 trace
  agentId?: string;         // Agent ID（子 agent spawn 時帶入，供 Dashboard 篩選）
  turnIndex?: number;

  // 7 階段
  inbound: { receivedAt, textPreview, charCount, attachments, debounceMs?, debounceMergedCount?, interruptedPrevious? };
  context?: { startMs, endMs, memoryRecall?, promptAssembly?, providerSelection?, systemPromptTokens, historyTokens, historyMessageCount, inboundHistory?, totalContextTokens };
  llmCalls: TraceLLMCall[];
  contextEngineering?: { strategiesApplied, tokensBeforeCE, tokensAfterCE, tokensSaved };
  abort?: { trigger, rollback };
  postProcess?: { extractRan, sessionSnapshotKept, sessionNoteUpdated, toolLogPath };
  response?: { textPreview, charCount, durationMs };

  // 統計
  totalDurationMs, totalInputTokens, totalOutputTokens;
  totalCacheRead, totalCacheWrite, effectiveInputTokens;
  totalToolCalls;
  estimatedCostUsd?: number;
  workflowEvents?: TraceWorkflowEvent[];
  hasContextSnapshot?: boolean;

  // TurnAuditLog 遷移欄位
  phase?: { inboundReceivedMs, queueWaitMs?, agentLoopStartMs?, completedMs? };
  contextBreakdown?: { systemPrompt, recall, history, inboundContext, current };
  toolDurations?: Record<string, number[]>;

  error?: string;
  status: "completed" | "aborted" | "error";
}
```

## 全域單例

```typescript
initTraceStore(dataDir: string): TraceStore         // 同時初始化 TraceContextStore
getTraceStore(): TraceStore | null
getTraceContextStore(): TraceContextStore | null
```
