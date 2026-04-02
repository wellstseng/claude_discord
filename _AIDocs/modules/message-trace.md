# Message Lifecycle Trace — 訊息全鏈路追蹤

> 原始碼：`src/core/message-trace.ts`
> 更新日期：2026-04-02

## 概述

追蹤每條 Discord 訊息從接收到回覆的完整處理過程。7 個階段的結構化記錄，支援 dashboard 視覺化查詢。

## 架構

### MessageTrace（收集器）

累積式收集器，由 `discord.ts` debounce 觸發後建立（`MessageTrace.create(turnId, channelId, accountId)`），傳入 `agentLoop` opts，各模組呼叫 `record*()` 累積數據，最後 `finalize()` 產出完整記錄。

### TraceStore（持久化）

- 格式：JSONL（`data/traces/YYYY-MM-DD.jsonl`）
- 保留：14 天 rolling
- 初始化：`platform.ts` 啟動時 `initTraceStore(dataDir)`
- 查詢：`recent(limit, filter?)` / `getById(traceId)`

## 7 階段追蹤

| 階段 | 記錄位置 | 記錄方法 | 內容 |
|------|---------|---------|------|
| ① Inbound | discord.ts | `recordInbound()` | 原始文字 preview、字數、附件數 |
| ② Context | discord.ts | `recordContextStart/End()` + `recordMemoryRecall()` + `recordInboundHistory()` | memory recall（atom 名稱、fragment 數、token 數、是否 degraded）、system prompt token、inbound history token |
| ③ LLM Loop | agent-loop.ts | `recordLLMCallStart/End()` + `recordToolCall()` | 每次 LLM call 的 model、input/output tokens、cache、duration、tool calls（名稱、duration、error、result preview） |
| ④ CE | agent-loop.ts | `recordCE()` | 觸發的 strategy、壓縮前後 token 差 |
| ⑤ Abort | agent-loop.ts | `recordAbort()` | 觸發原因（stop/timeout/interrupt）、是否 rollback |
| ⑥ PostProcess | agent-loop.ts | `recordPostProcess()` | extract 是否執行、snapshot 是否保留、session note、tool log 路徑 |
| ⑦ Response | agent-loop.ts | `recordResponse()` | 回覆 preview、字數、總 duration |

## Dashboard API

| 端點 | 說明 |
|------|------|
| `GET /api/traces?limit=N` | 最近 N 筆 trace 列表（預設 50） |
| `GET /api/traces/:traceId` | 單筆 trace 完整詳情 |

## Dashboard UI

Traces 分頁：
- **列表**：時間、channel、duration、tokens、tools、LLM 迭代次數、CE 狀態、status、text preview
- **詳情**：點擊任一行展開 7 階段 waterfall 視圖

## 關鍵型別

```typescript
// 完整 trace 記錄
interface MessageTraceEntry {
  traceId: string;          // turnId (UUID)
  messageId?: string;       // Discord message ID
  channelId, accountId, ts;
  inbound: { receivedAt, textPreview, charCount, attachments, ... };
  context?: { startMs, endMs, memoryRecall?, systemPromptTokens, ... };
  llmCalls: TraceLLMCall[];
  contextEngineering?: { strategiesApplied, tokensBeforeCE, tokensAfterCE, tokensSaved };
  abort?: { trigger, rollback };
  postProcess?: { extractRan, sessionSnapshotKept, sessionNoteUpdated, toolLogPath };
  response?: { textPreview, charCount, durationMs };
  totalDurationMs, totalInputTokens, totalOutputTokens, totalToolCalls;
  status: "completed" | "aborted" | "error";
}
```
