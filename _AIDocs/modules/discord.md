# modules/discord — Discord Client + 訊息處理

> 檔案：`src/discord.ts`

## 職責

建立 Discord Client，處理 `messageCreate` 事件：bot 自身過濾 → 訊息去重 → `getChannelAccess()` 查詢 per-channel 設定 → allowBot/allowFrom 過濾 → requireMention 判斷 → 附件下載 → debounce 合併 → 觸發 session + reply。

## Client 設定

```typescript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // NOTE: DM 必須加 Partials.Channel，否則 discord.js 不會觸發 DM 的 messageCreate 事件
  partials: [Partials.Channel],
});
```

## 訊息過濾完整 8 步流程

以下 ①–⑧ 為過濾/守衛步驟，全部通過才進入 debounce → enqueue。

```
messageCreate
  │
  ├─ ① bot 自身（author.id === client.user.id）→ 永遠忽略
  │     NOTE: 不論 allowBot 設定，永遠不回覆自己，避免無限迴圈
  │
  ├─ ② 訊息去重（processedMessages Set）
  │     └─ 已處理過此 message ID → 忽略（DM partial channel 已知重複觸發問題）
  │
  ├─ ③ getChannelAccess(guildId, channelId, parentId)
  │     └─ allowed = false → 忽略
  │
  ├─ ④ bot 訊息過濾（message.author.bot = true）
  │     └─ access.allowBot = false → 忽略
  │         NOTE: allowBot=true 但仍受 allowFrom 白名單限制（進入步驟 ⑤）
  │
  ├─ ⑤ allowFrom 白名單過濾
  │     └─ allowFrom 非空 + author.id 不在白名單 → 忽略
  │
  ├─ ⑥ requireMention 判斷
  │     ├─ botUser 為 null → 忽略（邊界情況）
  │     ├─ requireMention = true → 未 mention bot → 忽略
  │     ├─ requireMention = true → strip mention（/<@!?\d+>/g），保留後續文字
  │     └─ requireMention = false → text = message.content.trim()（直接使用完整訊息）
  │
  ├─ ⑦ 下載附件（downloadAttachments）→ 路徑嵌入 prompt
  │
  ├─ ⑧ text 為空（只有 mention 無文字，且無附件）→ 忽略
  │
  └─ 通過 → debounce(channelId:authorId) → createReplyHandler + enqueue
```

### Per-Channel 存取設定（繼承鏈）

`getChannelAccess(guildId, channelId, parentId)` 回傳 `ChannelAccess`：

| 情境 | allowed | requireMention | allowBot | allowFrom |
|------|---------|----------------|---------|-----------|
| DM（guildId=null） | `dm.enabled` | 永遠 `false` | 永遠 `false` | `[]` |
| guilds 為空物件 | `true` | `true` | `false` | `[]` |
| guild 找不到 | `false` | `true` | `false` | `[]` |
| guild 找到 | 繼承鏈 | 繼承鏈 | 繼承鏈 | 繼承鏈 |

繼承鏈：`channels[channelId] ?? channels[parentId] ?? guild預設`

## Debounce

同一人在 `debounceMs`（預設 500ms）內的多則訊息合併為一則。

**Key**：`channelId:authorId`

**三個 Map**：

| Map | Key | Value |
|-----|-----|-------|
| `debounceTimers` | key | `setTimeout` handle（用於清除上一個 timer） |
| `debounceBuffers` | key | `string[]`（累積的訊息行） |
| `debounceMessages` | key | 第一則 `Message`（用於 reply，Discord 引用回覆需要此物件） |

**流程**：

1. 收到訊息 → `clearTimeout(existing)` 清除舊 timer → 累積文字到 buffer
   → `!debounceMessages.has(key)` 才 set（只記第一則，後續訊息不覆蓋）
2. `setTimeout(debounceMs)` 到期 → `lines.join("\n")` → `onFire(combinedText, firstMessage)`
3. 清理三個 Map（`delete` key，防止記憶體洩漏）

## 訊息去重

`processedMessages: Set<string>` 追蹤已處理的 message ID，防止 DM partial channel 導致重複觸發。
超過 1000 筆時整批清除（`processedMessages.clear()`）。

## 附件下載

`downloadAttachments(message)` 將 Discord 訊息附件下載至暫存目錄：

- 暫存根目錄：`/tmp/claude-discord-uploads/`（`UPLOAD_DIR`）
- 每則訊息一個子目錄：`UPLOAD_DIR/{messageId}/{fileName}`（避免檔名衝突）
- 下載後路徑嵌入 prompt：
  ```
  [使用者附件，請用 Read 工具讀取]
  - /tmp/claude-discord-uploads/{messageId}/xxx.png
  ```
- 讓 Claude CLI 可透過 `Read` 工具存取使用者上傳的檔案

下載失敗 → `log.warn` + 繼續處理（不中斷）。

## 使用者識別

多人頻道中，prompt 前綴 `displayName:`，讓 Claude 分辨發言者：

```text
Wells: 這個 API 怎麼用？
```

DM 也加此前綴（不影響 Claude 行為，保持格式一致）。

## Thread 偵測

`getParentId(message)` 檢查 channel type 是否為 Thread：

| Channel Type | parentId |
|-------------|---------|
| `PublicThread` | Thread 的父頻道 ID |
| `PrivateThread` | Thread 的父頻道 ID |
| `AnnouncementThread` | Thread 的父頻道 ID |
| 其他 | `null` |

parentId 用於繼承鏈查找（`channels[parentId]`），讓 Thread 可以繼承父頻道的設定。

## Prompt 構成

Debounce 觸發後，組合最終 prompt：

```typescript
const prompt = `${firstMessage.author.displayName}: ${combinedText}`;
```

- 使用 `displayName`（伺服器暱稱），非 `username`（帳號名）
- DM 也加此前綴，格式統一
- 讓 Claude 在多人頻道中分辨發言者

## 對外 API

### `createDiscordClient(): Client`

建立已綁定 `messageCreate` handler 的 Client（尚未 `login`）。

> **重要**：不接收 config 參數。每次 `messageCreate` 都讀全域 `config`，支援 hot-reload。
> 若 closure 捕獲 config，hot-reload 後新設定不會生效。

## 模組層級常數

| 常數 | 類型 | 說明 |
|------|------|------|
| `processedMessages` | `Set<string>` | 已處理 message ID，超過 1000 筆整批清除 |
| `debounceTimers` | `Map<string, Timer>` | key → setTimeout handle |
| `debounceBuffers` | `Map<string, string[]>` | key → 累積訊息行 |
| `debounceMessages` | `Map<string, Message>` | key → 第一則訊息物件 |
| `UPLOAD_DIR` | `string` | 附件暫存根目錄（`/tmp/claude-discord-uploads`） |
