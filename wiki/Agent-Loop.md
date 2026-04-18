# Agent Loop

`src/core/agent-loop.ts` — CatClaw 的核心推理引擎，實現 multi-turn tool-use 迴圈。

## 運作流程

```mermaid
flowchart TD
    START[接收 prompt + session] --> PERM[Permission Gate<br/>角色過濾可用 tools]
    PERM --> QUEUE[Turn Queue<br/>排入 per-session 佇列]
    QUEUE --> CE[Context Engine<br/>壓縮歷史訊息]
    CE --> STREAM[LLM Stream<br/>呼叫 provider.stream]
    STREAM --> PARSE{解析回應}
    PARSE -->|text| EMIT[yield text_delta 事件]
    PARSE -->|tool_use| TOOL[執行 Tool]
    PARSE -->|end_turn| DONE[結束]
    PARSE -->|max_tokens| RECOVER[Output Token Recovery]
    TOOL --> HOOK_PRE[Before Hook<br/>權限/安全/read-before-write/loop 偵測]
    HOOK_PRE --> EXEC[toolRegistry.execute<br/>timeout 0（無逾時）]
    EXEC --> TRUNC[truncateToolResult<br/>per-tool 策略<br/>error 不截斷]
    TRUNC --> HOOK_POST[Post Hook<br/>audit/logging]
    HOOK_POST --> STREAM
    RECOVER --> STREAM
    EMIT --> STREAM
```

## 關鍵機制

### Turn Queue

每個 session 有獨立的 FIFO 佇列，確保同一 channel 的訊息串行處理：

- 最大深度：5（超過直接拒絕）
- 單 turn 超時：300s（或 config `turnTimeoutMs`，最低 120s）
- 透過 `SessionManager.enqueueTurn()` 排入

### LLM Stream Loop

- 最大輪數：`MAX_LOOPS = 20`
- 每輪呼叫 `provider.stream()` 取得 LLM 回應
- 遇到 `tool_use` → 執行工具 → 結果送回下一輪
- 遇到 `end_turn` → 結束迴圈
- 遇到 `max_tokens` → 觸發 Output Token Recovery

### Output Token Recovery

LLM 輸出被截斷時（`max_tokens` stop reason），自動續接：

- 最多續接 `MAX_CONTINUATIONS = 3` 次
- 將截斷的回應作為 context 送入下一次 stream
- 讓 LLM 從截斷處繼續生成

### Tool 執行流程

每個 tool call 經過 before/after hooks：

**Before Hooks：**
- **Permission Check** — 確認帳號有權使用該 tool
- **Safety Guard** — 危險操作攔截
- **Read-Before-Write** — 寫入前必須先讀取
- **Loop Detection** — 三層防禦（見下方）

**After Hooks：**
- Audit logging
- Event bus 事件發射
- Memory extract 觸發

### Tool Loop Detection

三層防禦避免 LLM 陷入重複操作：

| 層級 | 偵測條件 | 動作 |
| ---- | -------- | ---- |
| Exact Loop | 同參數呼叫 3 次 | 中斷 + 警告 |
| Loose Retry | 最近 10 次中 8 次同 tool | 中斷 + 警告 |
| Alternating Cycle | 交替循環偵測 | 中斷 + 警告 |

### TurnTracker

監控每個 turn 的 tool 使用模式：

- **Rut Signal**：同一檔案被編輯 3 次以上 → 發出 rut 信號
- **Intent Classification**：依 tool 使用分類（coding / research / conversation）
- **Reversibility Assessment**：為 tool 操作評分 0-3，高風險操作觸發警告

### Auto-Compact

當 Context Engine 在 turn 中觸發壓縮策略時，壓縮後的訊息會回寫到 session，確保下一輪使用壓縮後的歷史。

## 事件流

`agentLoop()` 是 `AsyncGenerator`，yield 以下事件類型：

| 事件 | 說明 |
| ---- | ---- |
| `text_delta` | LLM 文字輸出（streaming） |
| `tool_use` | 開始執行 tool |
| `tool_result` | Tool 執行結果 |
| `thinking` | LLM 思考過程（extended thinking） |
| `error` | 錯誤 |
| `done` | Turn 完成 |

## Turn Cap Warning

Session 的 `turnCount` 超過 `contextEngineering.turnCapWarning`（預設 100）且為 20 的倍數時，發出 `log.warn` 建議執行 `/clear-session`。設 0 關閉。
