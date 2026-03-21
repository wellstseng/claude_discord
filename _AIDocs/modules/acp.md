# modules/acp — Claude CLI 串流對話

> 檔案：`src/acp.ts`

## 職責

Spawn `claude -p --output-format stream-json` 子程序進行對話，以 `AsyncGenerator<AcpEvent>` 串流事件給上層（session.ts）消費。

## Spawn 指令

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --dangerously-skip-permissions \
  [--resume <sessionId>] \
  "<prompt>"
```

| Flag | 用途 |
|------|------|
| `-p` | Print mode（非互動） |
| `--output-format stream-json` | JSON 串流輸出 |
| `--verbose` | stream-json 必須搭配，否則直接報錯 |
| `--include-partial-messages` | 啟用中間態 assistant 事件（累積文字），實現串流顯示 |
| `--dangerously-skip-permissions` | 跳過互動式權限確認（bot 無法互動） |
| `--resume <id>` | 延續既有 session（首次不帶） |

stdio 配置：`["ignore", "pipe", "pipe"]`

> **陷阱**：stdin 必須設 `"ignore"`。若為 `"pipe"` 且未關閉，claude 會等待 stdin 而永遠不輸出（hang）。

env 額外傳遞：`CATCLAW_CHANNEL_ID`（當前 Discord 頻道 ID，注入到 Claude CLI 子程序環境，用於重啟回報機制）。

## AcpEvent 型別

```typescript
export type AcpEvent =
  | { type: "text_delta"; text: string }        // 新增的文字片段（diff 結果）
  | { type: "thinking_delta"; text: string }    // 新增的推理文字片段
  | { type: "tool_call"; title: string }         // 新增的工具呼叫（工具名）
  | { type: "done" }                             // turn 正常結束
  | { type: "error"; message: string }           // 錯誤（分類後的可讀訊息）
  | { type: "status"; raw: unknown }             // 其他 claude 系統事件（靜默忽略）
  | { type: "session_init"; sessionId: string }; // 首次 turn 取得 session UUID
```

> `session_init` 在 session.ts 中被攔截，reply.ts 永遠不會收到此事件。

## 串流 Diff 機制

`--include-partial-messages` 輸出的 `assistant` 事件包含**累積文字**（非 delta）。
追蹤**四個**狀態變數，每次新 message ID（新 turn）時重置：

| 變數 | 用途 |
|------|------|
| `lastMessageId` | 偵測新 turn，觸發重置所有計數器 |
| `lastThinkingLength` | thinking block 累積長度，`fullThinking.slice(lastThinkingLength)` 提取新增推理 |
| `lastTextLength` | text block 累積長度，`fullText.slice(lastTextLength)` 提取新增文字 |
| `lastToolCount` | tool_use block 數量，每個新增 block yield 一個 `tool_call` event |

### ContentBlock 型別

```typescript
interface ContentBlock {
  type: string;       // "text" | "thinking" | "tool_use"
  text?: string;      // text block 的文字
  thinking?: string;  // thinking block 的推理文字
  name?: string;      // tool_use 的工具名
  id?: string;
}
```

## Event Queue Pattern

將 callback-based 的 stdout data 事件轉為可 `yield` 的 AsyncGenerator：

```typescript
const eventQueue: Array<AcpEvent | null> = [];
let resolveNext: (() => void) | null = null;

const push = (event: AcpEvent | null) => {
  eventQueue.push(event);
  resolveNext?.();
  resolveNext = null;
};

// Generator 主迴圈
while (true) {
  if (eventQueue.length === 0) {
    await new Promise<void>(resolve => { resolveNext = resolve; });
  }
  const event = eventQueue.shift();
  if (event === null) break;  // null = 結束信號
  if (event === undefined) continue;
  yield event;
  if (event.type === "done") break;
}
```

## AbortSignal 處理

收到 abort 信號（由 session.ts turnTimeout 觸發）：
1. `proc.kill("SIGTERM")`
2. 250ms 後若 process 未結束 → `proc.kill("SIGKILL")`
3. `proc.on("close")` 中偵測 `signal?.aborted` → push `{ type: "error", message: "回應逾時，已取消" }`
4. `signal?.removeEventListener("abort", abortHandler)` 清理監聽

## 錯誤分類（classifyError）

非正常退出（exit code ≠ 0 且非 abort）時，從 stderr 內容推測錯誤原因，產生使用者可讀訊息：

| 關鍵字（小寫匹配） | 錯誤訊息 |
|-------------------|---------|
| `overloaded` 或 `529` | Claude API 過載（overloaded），請稍後再試 |
| `rate` + `limit` | Claude API 速率限制（rate limit），請稍後再試 |
| `502` 或 `bad gateway` | Claude API 連線失敗（502 Bad Gateway） |
| `503` 或 `service unavailable` | Claude API 暫時無法使用（503） |
| `timeout` 或 `etimedout` | Claude API 連線逾時 |
| `econnreset` 或 `econnrefused` | Claude API 連線中斷 |
| `authentication` 或 `401` 或 `unauthorized` | Claude API 認證失敗 |
| 其他 | `claude 異常退出（exit N）：stderr 尾段（最後 100 字元）` |

stderr 最多保留最後 **500 字元**（`stderrTail`）供診斷。

## process close 處理

1. 沖出 `buffer` 殘留的最後一行（split `"\n"` 後最後片段可能不完整）
2. `signal?.aborted` → push `error`（回應逾時，已取消）
3. `code !== 0` 且非 abort → `classifyError(stderrTail, code)` → push `error`
4. `push(null)` 結束信號
5. `signal?.removeEventListener("abort", abortHandler)` 清理監聽

## Log 控制

| 控制方式 | 效果 |
|---------|------|
| `logLevel: "debug"` | spawn 指令、process pid、event type |
| `ACP_TRACE=1`（環境變數） | stdout chunk（前 200 字元）+ stderr raw（前 200 字元）|

環境變數 `ACP_TRACE=1` 獨立控制，避免 `debug` 模式時被 raw data 洗版。
查 Claude CLI 通訊問題時使用 `ACP_TRACE=1 node dist/index.js`。

## 函式簽名

```typescript
export async function* runClaudeTurn(
  sessionId: string | null,  // null = 首次（不帶 --resume）
  text: string,              // 使用者輸入文字（positional argument）
  cwd: string,               // Claude session 工作目錄（spawn cwd）
  claudeCmd: string,         // claude binary 路徑（通常 "claude"）
  channelId: string,         // Discord channel ID（注入 CATCLAW_CHANNEL_ID env）
  signal?: AbortSignal       // 來自 session.ts AbortController（turnTimeout）
): AsyncGenerator<AcpEvent>
```
