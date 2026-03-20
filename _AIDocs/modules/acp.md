# modules/acp — Claude CLI 串流對話

> 檔案：`src/acp.ts`

## 職責

Spawn `claude -p --output-format stream-json` 子程序進行對話，以 `AsyncGenerator<AcpEvent>` 串流事件給上層。

## Spawn 指令

```bash
claude -p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions [--resume <sessionId>] "<prompt>"
```

| Flag | 用途 |
|------|------|
| `-p` | Print mode（非互動） |
| `--output-format stream-json` | JSON 串流輸出 |
| `--verbose` | stream-json 必須搭配 verbose |
| `--include-partial-messages` | 啟用中間態 assistant 事件（累積文字） |
| `--dangerously-skip-permissions` | 跳過權限確認（bot 無法互動） |
| `--resume <id>` | 延續既有 session（首次不帶） |

stdio 配置：`["ignore", "pipe", "pipe"]`
env 額外傳遞：`CATCLAW_CHANNEL_ID`（當前 Discord 頻道 ID，用於重啟回報）

> **陷阱**：stdin 必須設 `"ignore"`。若為 `"pipe"` 且未關閉，claude 會等待 stdin 而永遠不輸出。

## AcpEvent 型別

```typescript
type AcpEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; title: string }
  | { type: "done" }
  | { type: "thinking_delta"; text: string }
  | { type: "error"; message: string }
  | { type: "status"; raw: unknown }
  | { type: "session_init"; sessionId: string };
```

## 串流 Diff 機制

claude `--include-partial-messages` 輸出的 `assistant` 事件包含**累積文字**（非 delta）。

追蹤三個狀態變數，每次新 message ID 重置：

| 變數 | 用途 |
|------|------|
| `lastMessageId` | 偵測新 turn，重置計數器 |
| `lastTextLength` | diff 文字長度，`fullText.slice(lastTextLength)` 提取新增部分 |
| `lastToolCount` | diff tool_use block 數量，新增的 tool block yield `tool_call` event |

## Event Queue Pattern

`proc.stdout.on("data")` → 解析 JSON → `push(event)` → `resolveNext()`

Generator 主迴圈 `await new Promise` 等待 → `eventQueue.shift()` → `yield`

結束信號：`push(null)` → generator `break`

## AbortSignal 處理

收到 abort → `SIGTERM` → 250ms 後若未結束 → `SIGKILL`

## 錯誤分類（classifyError）

非正常退出時，從 stderr 內容推測錯誤原因，產生使用者可讀訊息：

| 關鍵字 | 錯誤訊息 |
|--------|---------|
| `overloaded` / `529` | Claude API 過載（overloaded） |
| `rate` + `limit` | Claude API 速率限制（rate limit） |
| `502` / `bad gateway` | Claude API 連線失敗（502） |
| `503` | Claude API 暫時無法使用（503） |
| `timeout` / `etimedout` | Claude API 連線逾時 |
| `econnreset` / `econnrefused` | Claude API 連線中斷 |
| `401` / `unauthorized` | Claude API 認證失敗 |
| 其他 | `claude 異常退出（exit N）：stderr 尾段` |

## process close 處理

1. 沖出 buffer 殘留最後一行
2. 非正常退出（且非使用者取消）→ `classifyError()` 產生可讀錯誤訊息
3. `push(null)` 結束信號

## Log 控制

stdout chunk 和 stderr 的 debug log 預設靜音，需設環境變數 `ACP_TRACE=1` 才輸出。
避免 `logLevel: "debug"` 時被 raw data 洗版。
