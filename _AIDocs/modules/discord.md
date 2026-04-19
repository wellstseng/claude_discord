# modules/discord — Discord Client + 訊息處理

> 檔案：`src/discord.ts`

## 職責

建立 Discord Client，處理 `messageCreate` 事件：bot 自身過濾 → 訊息去重 → `getChannelAccess()` 查詢 per-channel 設定 → allowBot/allowFrom 過濾 → requireMention 判斷 → 附件下載 → debounce 合併 → 觸發 agentLoop + reply-handler。

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

以下 ①–⑧ 為過濾/守衛步驟，全部通過才進入 debounce → agentLoop。

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
  ├─ ④.5 外部 bot mention 過濾
  │     └─ mentions.users 含 user.bot=true 且不在 allRegisteredBotIds → hasMentionedAnyBot=true → 不是 mention 我 → 忽略
  │
  ├─ ⑤ allowFrom 白名單過濾
  │     └─ allowFrom 非空 + author.id 不在白名單 → 忽略
  │
  ├─ ⑤.5 blockGroupMentions：message.mentions.everyone → 忽略
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
  └─ 通過 → debounce(channelId:authorId) → agentLoop() + handleAgentLoopReply()
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

- 暫存根目錄：`join(tmpdir(), "claude-discord-uploads")`（`UPLOAD_DIR`，非硬編碼路徑）
- 每則訊息一個子目錄：`UPLOAD_DIR/{messageId}/{fileName}`（避免檔名衝突）
- 下載後路徑嵌入 prompt：
  ```
  [使用者附件，請用 read_file 工具讀取]
  - /tmp/claude-discord-uploads/{messageId}/xxx.png
  ```
- 讓 Claude CLI 可透過 `Read` 工具存取使用者上傳的檔案

下載失敗 → `log.warn` + 繼續處理（不中斷）。

## 使用者識別

多人頻道中，透過 `speakerDisplay` opts 傳給 agentLoop，由 prompt-assembler 在 system prompt 中注入說話者資訊。
prompt 本身不加 displayName 前綴。

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

Debounce 觸發後，prompt 直接使用 `combinedText`（不加 displayName 前綴）：

```typescript
const prompt = combinedText;
```

- `displayName` 改為透過 `speakerDisplay` opts 傳給 agentLoop
- agentLoop / prompt-assembler 在 system prompt 中注入說話者資訊
- 不在 user message 層拼接 displayName

## 帳號系統整合

Debounce 觸發後，進入平台路徑（`isPlatformReady()` 為 true 時）：

```typescript
const { accountId, isGuest } = resolveDiscordIdentity(
  firstMessage.author.id,
  config.admin?.allowedUserIds ?? [],
);
```

- `resolveDiscordIdentity()` → `discord-owner-{discordId}`（admin）或 `guest:{discordId}`（guest）格式的 accountId
- Guest 帳號自動建立（`ensureGuestAccount(accountId)`）
- DM 未知使用者 → 觸發配對流程（`getRegistrationManager().createPairingCode()`）
- 帳號角色取自 `getAccountRegistry().get(accountId).role`
- 當前專案：頻道綁定（`coreChannelAccess.boundProject`） > 帳號的 `currentProject`

### Permission Gate

Skill 執行前進行 tier 檢查：

```typescript
const tierCheck = getPlatformPermissionGate().checkTier(accountId, skill.tier);
```

### Rate Limit

```typescript
const rateLimiter = getPlatformRateLimiter();
const rlResult = rateLimiter.check(accountId, accountRole);
```

每角色有每分鐘上限，超限回傳 `retryAfterMs`。

## Provider 選擇

路由優先序：`/use` 手動覆寫 > 頻道綁定 > 角色/專案路由 > 全域預設

```typescript
const providerOverride = getChannelProviderOverride(firstMessage.channelId);
const providerId = providerOverride ?? resolveProvider({ channelAccess, channelId, role, projectId });
const provider = providerRegistry.get(providerId)
  ?? providerRegistry.resolve({ role: accountRole, projectId: resolvedProjectId });
```

## 統一訊息管線（runMessagePipeline）

Memory Recall、Intent Detection、Prompt Assembly、Trace 記錄等共用邏輯已抽出至 `message-pipeline.ts`。
discord.ts 透過 `runMessagePipeline()` 一次完成：

```typescript
const pipeline = await runMessagePipeline({
  prompt, platform: "discord", trace,
  channelId, accountId, provider,
  role: accountRole, isGroupChannel,
  speakerDisplay, modeName, modePreset,
  activeMcpServers: ["discord"],
  memoryRecall: true, inboundHistory: true,
  sessionMemory: true, modeExtras: true,
  channelOverride: getChannelSystemOverride(channelId),
});
const combinedSystemPrompt = pipeline.systemPrompt;
const { inboundContext } = pipeline;
```

詳細步驟見 [message-pipeline.md](message-pipeline.md)。

## Inbound History 注入

未被處理的訊息會記錄到 `InboundHistoryStore`，下次觸發時注入。

**記錄 / 注入解耦**（discord.ts `_recordInbound` helper）：
- `inboundHistory.enabled`（預設 true）→ 控制是否落地 JSONL
- `inboundHistory.inject.enabled`（預設 false）→ 控制下次 prompt 是否注入摘要

只要 `enabled=true` 就會記錄，避免「想開 inject 卻沒歷史可吃」。

**Scope 設計**（per-agent 隔離）：
- agent-loop 路徑 → scope = `agent:{bootAgentId}`
- CLI Bridge 路徑 → scope = `bridge:{label}`
- 寫入時同時寫入所有已註冊 agent/bridge 的 scope（各自消費、互不干擾）

**觸發 `_recordInbound()` 的早退路徑**：
1. `allowBot=false` 擋掉的 bot 訊息
2. bot-circuit-breaker 攔截
3. allowFrom 白名單擋掉
4. `@here` / `@everyone` 群組廣播被 `blockGroupMentions` 擋掉
5. 訊息 mention 別 bot，主 bot 未被 mention
6. 沒 mention 任何 bot，且 `requireMention=true`

```typescript
const ctx = await inboundStore.consumeForInjection(channelId, {
  fullWindowHours, decayWindowHours, bucketBTokenCap, decayIITokenCap,
  inject: { enabled },
});
inboundContext = ctx.text;  // 注入到 messages 層，非 system prompt
```

配置來自 `config.inboundHistory`。

## AutoThread 機制

若頻道設定 `access.autoThread = true` 且訊息不在 Thread 內：

```typescript
const replyThread = await firstMessage.startThread({
  name: combinedText.replace(/\n/g, " ").slice(0, 50) || "對話",
  autoArchiveDuration: 60,
});
effectiveChannelId = replyThread.id;
```

後續 agent-loop 使用 `effectiveChannelId`，回覆送入新 Thread。

## agent-loop 啟動

```typescript
const gen = agentLoop(prompt, {
  platform: "discord",
  channelId: effectiveChannelId,
  accountId,
  isGroupChannel,
  speakerDisplay,
  speakerRole,
  provider,
  systemPrompt: combinedSystemPrompt || undefined,
  inboundContext,
  turnTimeoutMs,
  showToolCalls,
  sessionMemory: { enabled, intervalTurns, maxHistoryTurns, memoryDir },
  execApproval: { enabled, dmUserId, timeoutMs, allowedPatterns, sendDm },
  imageAttachments,     // base64 圖片附件
  thinking,             // /think 設定 > mode preset
  modePreset,
  trace,
}, {
  sessionManager: getPlatformSessionManager(),
  permissionGate: getPlatformPermissionGate(),
  toolRegistry: getPlatformToolRegistry(),
  safetyGuard: getPlatformSafetyGuard(),
  eventBus,
});
```

回傳 `AsyncGenerator`，由 `handleAgentLoopReply()` 消費並回覆 Discord。

### Ack Reaction 狀態機

| 階段 | Reaction |
|------|----------|
| queued | ⏳ |
| thinking（text_delta） | 🤔（移除 ⏳） |
| tool 執行中 | 🔧（移除 🤔） |
| done | 移除所有 |
| error | ❌ |

## Context End Trace

context 指標由 message-pipeline / agent-loop 內部記錄（`trace.recordContextEnd`），非在 discord.ts 層。

## 其他機制

### Exec-Approval 攔截

DM 中符合「✅/❌ ABCDEF」格式的訊息 → 解析為 exec-approval 回覆，不進入一般處理。
按鈕互動（`interactionCreate`）亦支援 Task UI + exec-approval。

### Subagent Thread 路由

若頻道是子 agent 綁定的 thread（`getSubagentThreadBinding(channelId)`），直接路由到子 session。

### CLI Bridge 路由

`handleMessage` 通過訊息過濾後，若 `getCliBridge(channelId)` 命中，**依 sender mode 分流且不 fall through**：

- `independent-bot`：獨立 Client 自己監聽訊息，主 bot **直接 `return`**，不再跑 AgentLoop。這是為了避免 CliBridge 與 AgentLoop 共用同一顆 bot token 時，兩個 Client 都收到訊息、主 bot 用無記憶的 AgentLoop 搶先回覆蓋掉 CliBridge 的上下文。
- `main-bot`（fallback）：主 bot 代為 `handleCliBridgeReply()` → `return`。進入前先 `await cliBridge.ensureAlive()` 確保 suspended bridge 被喚醒（lazy start）。

換句話說，**頻道一旦綁定 CliBridge，主 bot 的 AgentLoop 就不會在該頻道執行**。

### InterruptOnNewMessage

頻道設定 `interruptOnNewMessage=true` → 新訊息自動 abort 正在執行的 turn + 清空 queue。

## 對外 API

### `createBot(): Client`

建立已綁定 `messageCreate` + `interactionCreate` handler 的 Client（尚未 `login`）。

> **重要**：不接收 config 參數。每次 `messageCreate` 都讀全域 `config`，支援 hot-reload。
> 若 closure 捕獲 config，hot-reload 後新設定不會生效。

`clientReady` 時初始化：`setDiscordClient`、`setApprovalDiscordClient`、`setTaskUiDiscordClient`、`registerTaskUiListener`、`sendRestartNotification(client)`。

### 重啟上線通知

`sendRestartNotification(client)` — `clientReady` 時觸發：
- `config.restartNotify.enabled === false` → 跳過
- `config.restartNotify.channels` 為空 → 跳過（不自動廣播所有頻道）
- 只通知明確指定的頻道，附帶未完成任務摘要（`loadAllPersistedTasks()`）

## Bot Circuit Breaker（`src/discord/bot-circuit-breaker.ts`）

Bot-to-Bot 對話防呆機制。偵測同頻道 bot 互相回覆過度活躍，超過閾值暫停等人介入。

### 觸發條件（任一）

| 條件 | 預設值 |
|------|--------|
| 連續 bot 互動來回 N 輪 | `maxRounds: 10` |
| 持續超過 M 毫秒 | `maxDurationMs: 180_000`（3 分鐘） |

### API

```typescript
checkBotMessage(channelId, cfg?): boolean     // false = 已觸發，應暫停
resetOnHumanMessage(channelId): void          // 人類訊息 → 重置
resetChannel(channelId): void                 // 手動重置（Dashboard 用）
getAllStates(): Array<{ channelId, rounds, elapsedMs, tripped }>  // Dashboard 顯示
BOT_CB_DEFAULTS                               // { enabled: true, maxRounds: 10, maxDurationMs: 180_000 }
```

設定來源：`config.botCircuitBreaker`（`BotCircuitBreakerConfig`）。
使用方：`src/cli-bridge/index.ts`（CLI Bridge 訊息處理時檢查）。

## 模組層級常數

| 常數 | 類型 | 說明 |
|------|------|------|
| `processedMessages` | `Set<string>` | 已處理 message ID，超過 1000 筆整批清除 |
| `debounceTimers` | `Map<string, Timer>` | key → setTimeout handle |
| `debounceBuffers` | `Map<string, string[]>` | key → 累積訊息行 |
| `debounceImages` | `Map<string, Array<{data, mimeType, name}>>` | key → 累積圖片附件 |
| `debounceMessages` | `Map<string, Message>` | key → 第一則訊息物件 |
| `UPLOAD_DIR` | `string` | 附件暫存根目錄（`join(tmpdir(), "claude-discord-uploads")`，非硬編碼） |
