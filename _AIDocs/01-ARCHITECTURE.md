# 01 — discord-claude-bridge 架構設計

> 建立日期：2026-03-18 | 最近更新：2026-03-19

---

## 專案目標

輕量獨立的 Discord bot，直接透過 Claude Code CLI 進行對話，支援：

- Persistent session per channel（頻道級對話記憶，透過 `--resume` 延續）
- 多人並行（不同 channel 完全並行，同 channel 串行）
- DM 直接觸發（無需 mention）
- 串流回覆（`--include-partial-messages` 即時顯示）
- Typing indicator（回應期間顯示「正在輸入...」）
- Turn timeout（預設 5 分鐘，超時自動取消）

---

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14 | Discord Gateway 連線、訊息收發 |
| `dotenv` ^17 | .env 環境變數載入 |
| `typescript` ^5 | 編譯 |
| `@types/node` ^22 | Node.js 型別 |
| `claude` (PATH) | Claude Code CLI，外部安裝，不在 package.json |

---

## 整體資料流

```
Discord 訊息
    │
    ▼
[discord.ts] onMessageCreate()
    │  1. 忽略 bot 自身訊息
    │  2. TRIGGER_MODE 檢查（mention / all）
    │     DM 永遠觸發，無視 TRIGGER_MODE
    │  3. ALLOWED_CHANNEL_IDS 白名單過濾
    │  4. strip mention prefix
    │
    ▼
debounce(channelId:authorId, DEBOUNCE_MS)
    │  同一人 500ms 內多則訊息 → 合併成一則（\n 連接）
    │
    ▼
[reply.ts] createReplyHandler(message)
    │  建立 event handler + 啟動 typing indicator
    │
    ▼
[session.ts] enqueue(channelId, text, onEvent)
    │  per-channel Promise chain（serialize 同 channel turns）
    │  不同 channel → 完全並行
    │  建立 AbortController + setTimeout(turnTimeoutMs)
    │
    ▼
[acp.ts] runClaudeTurn(sessionId, text) → AsyncGenerator<AcpEvent>
    │  spawn: claude -p --output-format stream-json --verbose
    │         --include-partial-messages --dangerously-skip-permissions
    │         [--resume <sessionId>] <prompt>
    │  stdout: JSON lines → diff 累積文字 → yield text_delta
    │
    ▼
[reply.ts] onEvent handler
    │  session_init → session.ts 快取 sessionId（不轉發）
    │  text_delta → 累積 buffer
    │  buffer >= 2000 → chunk → Discord send → stopTyping
    │  tool_call → 🔧 使用工具：{title}
    │  done → flush 剩餘 buffer + stopTyping
    │  error → 錯誤訊息 + stopTyping
    │
    ▼
Discord 回覆送出
```

---

## 專案結構

```
claude_discord/
├── src/
│   ├── index.ts        進入點：dotenv 載入、啟動 Discord client
│   ├── config.ts       環境變數讀取與驗證
│   ├── discord.ts      Discord client + 訊息事件 + debounce
│   ├── session.ts      Session 管理 + per-channel queue + timeout
│   ├── acp.ts          Claude CLI 串流對話（spawn + event 解析）
│   └── reply.ts        Discord 回覆（chunk + code fence 平衡 + typing）
├── _AIDocs/            知識庫（本目錄）
├── .env.example        環境變數範本
├── .env                環境變數（不上 GIT）
├── package.json
└── tsconfig.json
```

---

## 模組說明

### config.ts

讀取環境變數，export 單一 `BridgeConfig` 物件。

```typescript
interface BridgeConfig {
  discordToken: string          // DISCORD_BOT_TOKEN（必填）
  triggerMode: "mention" | "all"  // 預設 "mention"
  allowedChannelIds: Set<string>  // 空 = 全部允許
  claudeCwd: string             // 預設 $HOME
  claudeCommand: string         // 預設 "claude"
  debounceMs: number            // 預設 500
  turnTimeoutMs: number         // 預設 300000（5 分鐘）
}
```

### acp.ts

直接 spawn Claude Code CLI，以 AsyncGenerator 串流 AcpEvent。

#### runClaudeTurn(sessionId, text, cwd, claudeCmd, signal?)

- 首次（sessionId = null）：不帶 `--resume`，從 `system/init` event 取得 session_id
- 後續：帶 `--resume <sessionId>` 延續上下文
- `--include-partial-messages`：收到累積文字，diff 計算 delta 再 yield
- AbortSignal → SIGTERM(250ms) → SIGKILL

#### 串流 diff 機制

- claude CLI 的 `assistant` event 包含累積文字（非 delta）
- 追蹤 `lastMessageId` + `lastTextLength`，每次取新增部分作為 `text_delta`
- 新 message ID → 重置追蹤（處理 tool 呼叫後的新 turn）

#### AcpEvent 類型

| type | 說明 |
|------|------|
| `session_init` | 新 session 建立，攜帶 sessionId（由 session.ts 攔截） |
| `text_delta` | 輸出文字片段（diff 後的增量） |
| `tool_call` | Claude 使用工具（顯示 🔧 提示） |
| `done` | turn 完成，flush buffer |
| `error` | 錯誤，回覆錯誤訊息 |
| `status` | 略過（hook / rate_limit 等） |

### session.ts

管理 session 生命週期與 per-channel 串行佇列。

```
sessionCache: Map<channelId, sessionId>    // session UUID 快取
queues:       Map<channelId, Promise<void>> // per-channel Promise chain tail
```

- `enqueue(channelId, text, onEvent, opts)`：將 turn 加入佇列
- 每個 turn 建立 `AbortController` + `setTimeout(turnTimeoutMs)`
- 超時自動 abort → error event「回應超時，已取消」
- 佇列完成後自動清理 Map entry

### reply.ts

Discord 回覆邏輯 + Typing indicator：

- `createReplyHandler(message)` 回傳 event handler function
- 建立時立即 `sendTyping()` + 每 8 秒重發（Discord typing 持續約 10 秒）
- 2000 字硬限（Discord API 限制）
- Code fence 平衡：奇數個 ``` → 跨 chunk 自動補關/補開
- 第一段用 `message.reply()`，後續用 `channel.send()`
- 第一則回覆送出 / done / error → `clearInterval` 停止 typing

### discord.ts

discord.js Client 設定：

- Intents: Guilds + GuildMessages + MessageContent + DirectMessages
- Partials: Channel（DM 必要）
- Debounce key: `${channelId}:${authorId}`

### index.ts

進入點：

- `dotenv/config` 載入 .env（必須在 config.ts 之前 import）
- 建立 Discord client → login
- SIGINT / SIGTERM 優雅關閉
- unhandledRejection 捕捉

---

## 環境變數

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `TRIGGER_MODE` | | `mention` | `mention` 或 `all` |
| `ALLOWED_CHANNEL_IDS` | | 空（全部） | 逗號分隔 **頻道** ID（非伺服器 ID） |
| `CLAUDE_CWD` | | `$HOME` | Claude session 工作目錄 |
| `CLAUDE_COMMAND` | | `claude` | claude CLI binary 路徑 |
| `DEBOUNCE_MS` | | `500` | debounce 毫秒數 |
| `TURN_TIMEOUT_MS` | | `300000` | 回應超時毫秒數（5 分鐘） |

---

## Claude CLI 指令格式

```bash
# 首次對話（無 session）
claude -p --output-format stream-json --verbose \
       --include-partial-messages --dangerously-skip-permissions \
       "prompt text"

# 後續對話（延續 session）
claude -p --output-format stream-json --verbose \
       --include-partial-messages --dangerously-skip-permissions \
       --resume <session-id> \
       "prompt text"
```

stream-json 事件格式（關鍵事件）：

```json
{"type":"system","subtype":"init","session_id":"uuid-here"}
{"type":"assistant","message":{"id":"msg_xxx","content":[{"type":"text","text":"..."}]}}
{"type":"result","subtype":"success","result":"...","session_id":"uuid-here"}
```

---

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` → claude session UUID | 同頻道所有人共享一段對話 |
| DM | `channelId`（每人唯一） | 等同 per-user session |

首次對話 → claude CLI 自動建立 session → 從 `system/init` event 取得 UUID → 快取。
後續對話 → `--resume <UUID>` 延續。

---

## 關鍵常數

| 常數 | 值 | 來源 |
|------|-----|------|
| TEXT_LIMIT | 2000 | Discord API 訊息字數上限 |
| DEBOUNCE_MS | 500 | 多訊息合併等待時間 |
| SIGTERM_GRACE | 250ms | abort 時 SIGTERM → SIGKILL 間隔 |
| TYPING_INTERVAL | 8s | typing indicator 重發間隔 |
| TURN_TIMEOUT_MS | 300000 | 回應超時（5 分鐘） |

---

## 已知邊界條件與陷阱

1. **DM 需加 `Partials.Channel`**：discord.js 預設不接收 DM 事件
2. **Bot self-filter 必須在 debounce 前**：避免 bot 回覆訊息佔 debounce 容量
3. **Code fence 跨 chunk 必須平衡**：否則 Discord 渲染亂掉
4. **同 channel 串行不是 Node.js 限制**：是 Claude session 要求（一次一個 turn）
5. **DM trigger 無視 TRIGGER_MODE**：DM 永遠觸發，不需 mention
6. **ALLOWED_CHANNEL_IDS 是頻道 ID，不是伺服器 ID**：填錯會導致訊息被靜默過濾
7. **stdin 必須設 "ignore"**：claude CLI 的 `-p` 模式若 stdin 為 pipe 且未關閉會卡住
8. **`--verbose` 是 stream-json 必要條件**：不加會報錯
9. **dotenv 必須在 config.ts 之前 import**：否則 process.env 尚未填充
10. **TextBasedChannel 型別包含 PartialGroupDMChannel**：無 `send` 方法，需 cast 為 `SendableChannels`
