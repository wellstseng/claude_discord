# modules/reply — Discord 回覆分段 + Typing

> ⚠️ **舊版參考**：以下內容描述的是 `src/reply.ts`（V1 ACP/CLI 架構，基於 `AcpEvent` + `createReplyHandler` factory）。新版 `src/core/reply-handler.ts` 採用 async generator 消費 + streaming live-edit 模式，詳見文末「新版 reply-handler」段落。

> 檔案：`src/reply.ts`（舊版）

## 職責

接收 `AcpEvent` 串流 → 累積文字 → 分段傳送到 Discord → 管理 typing indicator。

## 重要常數

| 常數 | 值 | 說明 |
|------|-----|------|
| `TEXT_LIMIT` | `2000` | Discord 單則訊息字元上限 |
| `FLUSH_DELAY_MS` | `3000` | 定時 flush 延遲（毫秒），3 秒無新增自動送出 |

> `FLUSH_DELAY_MS = 3000`（3 秒），收到 text_delta / thinking_delta 後排程，3 秒內有新增則重設 timer。

## API

### `createReplyHandler(originalMessage, bridgeConfig): (event: AcpEvent) => Promise<void>`

Factory 函式，建立閉包封裝的 event handler。回傳的函式可直接傳給 `session.enqueue` 的 `onEvent`。

呼叫後立即：
1. `channel.sendTyping()` 開始 typing 指示
2. `setInterval` 每 8 秒重發 typing（Discord typing 約 10 秒自動消失）
3. 第一則回覆送出後 `clearInterval` 停止 typing

## 分段邏輯

Discord 訊息上限 2000 字（`TEXT_LIMIT`）。

`flush(flushAll)` 切割 buffer 並傳送：

- `flushAll = false`：buffer >= 2000 才傳（串流累積中，等滿再切）
- `flushAll = true`：傳送所有剩餘 buffer（done / error / tool_call 時強制送出）

傳送順序：

- 第一段 → `message.reply()`（Discord 引用回覆，顯示回應對象）
- 後續 → `channel.send()`（直接傳送）

## Code Fence 平衡

跨 chunk 的 ` ``` ` 必須正確開關，否則 Discord 渲染破碎。

| 函式 | 邏輯 |
|------|------|
| `countCodeFences(text)` | 計算 ` ``` ` 出現次數（`/\`\`\`/g`） |
| `closeFenceIfOpen(text)` | 奇數個 → 尾端補 ` ``` ` |

**跨 chunk 狀態**：`prevChunkHadOpenFence: boolean`

```
chunk 有奇數個 fence → closeFenceIfOpen() → prevChunkHadOpenFence = true
下個 chunk 開頭補 "```\n" → 恢復 code block
```

**預留空間**：切割點使用 `safeLimit = TEXT_LIMIT - 8`（1992），預留 8 字元給補開/補關的 ` ```\n `，防止補完後超過 2000 字。

**`flushing` flag**：防止定時 flush 與手動 flush 並行衝突（race condition）。

## 定時 Flush

```
scheduleFlush() {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(FLUSH_DELAY_MS=3000, () => {
    if (thinkingBuffer) → flushThinking()
    if (buffer && !fileMode) → flush(true)
  })
}
```

收到 text_delta / thinking_delta → `scheduleFlush()`
手動 flush（tool_call / done / error）→ `cancelFlushTimer()` + 直接 flush

## Typing Indicator

- 建立 handler 時立即 `sendTyping()`
- `setInterval(8000)` 每 8 秒重發（Discord typing 持續約 10 秒）
- 第一則回覆 `sendChunk()` 送出後 `stopTyping()`
- `done` / `error` event 也會呼叫 `stopTyping()`
- thinking 送出時**不停** typing，讓 typing 持續到正式 text 送出

## Thinking 顯示格式

`showThinking = true` 時，thinking_delta 累積到 `thinkingBuffer`，flush 時格式化為 Discord 引用：

```typescript
const formatted = thinkingBuffer
  .trim()
  .split("\n")
  .map(line => `> ${line}`)
  .join("\n");
const toSend = `> 💭 **Thinking**\n${formatted}`;
```

超過 2000 字時分段送出（不使用 code fence，純引用格式）。

## 檔案上傳模式（fileMode）

切換條件（兩個都要滿足）：

```typescript
if (threshold > 0 && totalText.length > threshold) {
  fileMode = true;
  cancelFlushTimer();
  buffer = "";   // 清空已累積但未送出的 buffer
  return;
}
```

- `threshold > 0`：`fileUploadThreshold = 0` 完全停用 fileMode
- `totalText.length > threshold`：累積全文超過門檻才切換

切換後行為：
1. 只累積 `totalText`，`buffer` 不再增加
2. `done` 時統一處理（見下）

**`done` 時的 fileMode 分支**：

| 條件 | 行為 |
|------|------|
| `fileMode && mediaPaths.length === 0` | 上傳 `response.md`，附前 150 字預覽 |
| `fileMode && mediaPaths.length > 0` | 不產生 response.md；用 cleanedText 重建 buffer → flush(true) → 再上傳 MEDIA 附件 |

> 設 `fileUploadThreshold = 0` 停用此模式。

## MEDIA Token 解析

Claude CLI 回覆中若包含 `MEDIA: /path/to/file`，自動解析並上傳為 Discord 附件。

```typescript
const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi;
```

`extractMediaTokens(raw)` 流程：
1. 正規表達式抽取路徑（只接受 `/` 開頭的絕對路徑）
2. 從文字中移除 MEDIA token
3. 清理移除後的多餘空行（3 個以上換行 → 2 個）
4. 回傳 `{ text: cleanedText, mediaPaths: string[] }`

上傳：`done` event 時，先送出文字，再逐一 `uploadMediaFile(filePath)` → `readFile` → `AttachmentBuilder` → Discord 附件。

## Event 處理

| Event | 行為 |
|-------|------|
| `text_delta` | 先 flush thinkingBuffer（如有）；累積到 buffer + totalText；超過 threshold 進入 fileMode；≥2000 立即 flush，否則 scheduleFlush(3s) |
| `thinking_delta` | `showThinking` 開啟時累積到 thinkingBuffer → scheduleFlush(3s) |
| `tool_call` | `"all"` → cancelFlushTimer + flush(true) + 傳 `🔧 使用工具：{title}`；`"summary"` → 首次 tool_call 傳 `⏳ 處理中...`（後續靜默）；`"none"` → 完全不輸出 |
| `tool_result` | 有 error → 不論 showToolCalls 設定一律傳 `❌ {title} 失敗：{error}`；成功 + `"all"` → 傳 `✅ {title} (Ns)` |
| `done` | cancelFlushTimer + stopTyping → extractMediaTokens → flush 或 sendFile → uploadMediaFile |
| `error` | cancelFlushTimer + stopTyping → flush(true) → 傳 `⚠️ 發生錯誤：{message}`（截斷至 TEXT_LIMIT） |
| `status` | 靜默忽略 |

## 型別注意

使用 `SendableChannels`（非 `TextBasedChannel`）避免 `PartialGroupDMChannel` 缺少 `send()` 的 TS 編譯錯誤。

---

## 新版 reply-handler（`src/core/reply-handler.ts`）

> V2 架構。消費 `AgentLoopEvent` async generator，串流回覆到 Discord。

### 兩種回覆模式

| 模式 | 條件 | 行為 |
|------|------|------|
| **streaming**（預設） | `bridgeConfig.streamingReply !== false` | 每條訊息建立後 live-edit，體驗類似 ChatGPT 串流 |
| **chunk**（fallback） | `streamingReply = false`，或 fileMode 觸發時 | 逐段發送新訊息 |

### 重要常數

| 常數 | 值 | 說明 |
|------|-----|------|
| `TEXT_LIMIT` | `2000` | Discord 單則訊息字元上限 |
| `FLUSH_DELAY_MS` | `3000` | chunk 模式：定時 flush 延遲（毫秒） |
| `EDIT_INTERVAL_MS` | `800` | streaming 模式：最快 edit 間隔（毫秒） |
| `STREAM_SPLIT_THRESHOLD` | `1900` | streaming 模式：超過此值終結目前段開新訊息（函式內 local const） |

### API

#### `handleAgentLoopReply(gen, originalMessage, bridgeConfig, opts?): Promise<void>`

主要 entry point，消費 `AsyncGenerator<AgentLoopEvent>` 並回覆到 Discord。

```typescript
export async function handleAgentLoopReply(
  gen: AsyncGenerator<AgentLoopEvent>,
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
  opts?: { threadChannel?: SendableChannels },  // autoThread 模式
): Promise<void>
```

**與舊版差異**：舊版 `createReplyHandler()` 回傳 event callback（push 模式），新版直接消費 async generator（pull 模式）。

### Streaming Edit 機制

1. 首次 `text_delta` → `initEditMsg("💭")` 建立 placeholder 訊息
2. 後續 `text_delta` 累積到 buffer → `scheduleEdit()` 排程 800ms 後 `editMsg.edit(buffer)`
3. buffer 超過 `STREAM_SPLIT_THRESHOLD`（1900 字） → 終結目前段（最終 edit），重置 editMsg，下次 text_delta 開新訊息
4. `done` 時 `finalizeStreamEdit()` 做最後一次 edit

**Rate-limit 保護**：`editBusy` flag 防止重疊 edit，`waitEditDone()` 最多等 500ms。

### 送出目標選擇

- `opts.threadChannel` 存在 → 所有回覆 send 到 thread channel（autoThread 模式）
- 否則：第一段 `originalMessage.reply()`（Discord 引用回覆），後續 `channel.send()`

### Event 處理

| Event | 行為 |
|-------|------|
| `text_delta` | streaming：`streamEditTextDelta()`；chunk：累積 buffer + scheduleFlush |
| `thinking` | `showThinking` 開啟時累積 thinkingBuffer |
| `tool_start` | `"all"` → finalize + 傳 `🔧 使用工具：{name}`；`"summary"` → 首次傳 `⏳ 處理中...` |
| `tool_result` | 有 error 且 toolMode !== "none" → finalize + 傳 `❌ {name} 失敗：{error}`（截斷 200 字）；成功時靜默 |
| `tool_blocked` | toolMode !== "none" → finalize + 傳 `🚫 工具被阻擋：{name} — {reason}` |
| `done` | finalize → extractMediaTokens → fileMode 分支處理 → 上傳 MEDIA 附件 |
| `error` | stopTyping → 若 editMsg 空（placeholder）直接 edit 為錯誤訊息；否則 finalize + send |

### 檔案上傳模式（fileMode）

觸發條件同舊版（`threshold > 0 && totalText.length > threshold`）。
streaming 模式下觸發時先 `finalizeStreamEdit()` 再切換。

`done` 時的 fileMode 分支：
- `mediaPaths.length === 0` → 上傳 `response.md` + 前 150 字預覽
- `mediaPaths.length > 0` → 用 cleanedText 重建 buffer → flush/edit → 再逐一上傳附件

### 工具函式（模組私有）

| 函式 | 說明 |
|------|------|
| `countCodeFences(text)` | 計算 ` ``` ` 出現次數 |
| `closeFenceIfOpen(text)` | 奇數個 fence → 尾端補 ` ``` ` |
| `extractMediaTokens(raw)` | 解析 `MEDIA: /path` token，支援 Unix + Windows 絕對路徑 |
| `uploadMediaFile(filePath, originalMessage, isFirst)` | 讀取檔案 → AttachmentBuilder → Discord 附件 |
| `sendChunk(content, originalMessage, isFirst)` | 發送文字段 |
| `sendFile(content, fileName, originalMessage, isFirst, preview?)` | 以檔案附件發送 |
