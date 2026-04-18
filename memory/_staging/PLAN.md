# Plan: discord-claude-bridge

## Context

用戶想從 OpenClaw 抽出 Discord 訊息處理邏輯，直接串接 Claude CLI，建立一個輕量獨立的 Discord bot。OpenClaw 功能太多太肥，用戶只需要：Discord 收訊 → Claude CLI 回覆，並支援 persistent session + 多人並行。

**Session 策略**：per-channel（同一頻道所有人共享一個 Claude session）
**位置**：新獨立 repo `~/project/discord-claude-bridge/`

---

## 架構

```
Discord 訊息
  → debounce (500ms, per channelId+authorId)
  → trigger check (mention-only 或 all messages)
  → session key = channelId
  → per-key queue (serialize 同 channel 的 turns)
  → ensureSession(channelId, "claude", cwd)
  → runTurn(handle, text) → async generator events
  → 累積 text_delta → chunk 2000字 → Discord reply
```

---

## 專案結構

```
discord-claude-bridge/
  src/
    index.ts        - entry point：載入 config、啟動 Discord client
    config.ts       - 環境變數讀取 + 驗證
    discord.ts      - Discord client + 訊息事件處理 + debounce
    session.ts      - ACP session 管理：ensureSession, per-key queue
    acp.ts          - ACP protocol：spawn acpx, event parsing
    reply.ts        - Discord 回覆：chunk 2000字, code fence 平衡
  package.json
  tsconfig.json
  .env.example
```

---

## 核心實作細節

### config.ts — 環境變數
```
DISCORD_BOT_TOKEN       必填
TRIGGER_MODE            mention | all  (預設 mention)
ALLOWED_CHANNEL_IDS     逗號分隔 channel ID，空 = 全部允許
CLAUDE_CWD              Claude session 工作目錄 (預設 $HOME)
ACPX_COMMAND            acpx binary 路徑 (預設 自動找 PATH)
DEBOUNCE_MS             (預設 500)
```

### discord.ts — Discord 訊息處理
- 使用 `discord.js` Client，Gateway Intents: Guilds + GuildMessages + MessageContent + DirectMessages
- Debounce：`Map<string, NodeJS.Timeout>`，key = `${channelId}:${authorId}`，500ms
- Trigger check：
  - `mention` mode：訊息必須 mention bot
  - `all` mode：白名單頻道內所有訊息
- Bot 自身訊息直接忽略
- 觸發後：strip mention prefix → 送入 session queue

### session.ts — Session 管理
- `Map<channelId, AcpHandle>` 快取已建立的 session
- `Map<channelId, Promise>` 作 per-key queue（Promise chain 串行）
- `ensureSession(channelId)` → 呼叫 `acpx sessions ensure --name <channelId>`
- 多人同 channel 同時說話 → queue 等待，不並行

### acp.ts — ACP Protocol（直接實作，不依賴 OpenClaw）
參考 `extensions/acpx/src/runtime.ts` 的指令格式：

```typescript
// ensureSession
spawn: ["acpx", "--format", "json", "--json-strict", "--cwd", cwd,
        "sessions", "ensure", "--name", sessionName]

// runTurn
spawn: ["acpx", "--format", "json", "--json-strict", "--cwd", cwd,
        "--approve-all",
        "prompt", "--session", sessionName, "--file", "-"]
stdin: promptText
stdout: JSON lines → parse events
```

Event 類型：
- `text_delta` → 累積輸出文字
- `done` → flush 剩餘文字
- `error` → log + 回覆錯誤訊息
- `tool_call` → 可選顯示 "🔧 使用工具: {title}"
- `status` → 略過或 debug log

AbortSignal → `acpx cancel --session <name>` → SIGTERM(250ms) → SIGKILL

### reply.ts — Discord 回覆
- 累積 text_delta，每 2000 字切一個訊息（與 OpenClaw 相同常數）
- Code fence 平衡：跨 chunk 自動補開/補關 ` ``` `
- 傳送：`message.reply()` 第一段，後續用 `channel.send()`

---

## 依賴

```json
{
  "dependencies": {
    "discord.js": "^14.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^22.x"
  }
}
```

Runtime 只需 `discord.js`。`acpx` 透過 PATH 呼叫（用戶已安裝）。

---

## 關鍵參考來源（OpenClaw）

| 概念 | 參考路徑 | 用途 |
|------|----------|------|
| ACP CLI 指令格式 | `extensions/acpx/src/runtime.ts:340-462` | spawn 格式、stdin/stdout |
| Event parsing | `extensions/acpx/src/runtime-internals/events.ts:198-323` | JSON lines 解析 |
| Process spawn | `extensions/acpx/src/runtime-internals/process.ts` | SIGTERM/SIGKILL 順序 |
| Chunk 常數 2000 | `src/discord/` (TEXT_LIMIT) | 切割邏輯 |
| Code fence balance | `src/discord/monitor/reply-delivery.ts` | 跨 chunk 平衡 |

---

## 驗證方式

1. `pnpm install` → `pnpm build` 無錯誤
2. 設定 `.env`：填入 DISCORD_BOT_TOKEN + ALLOWED_CHANNEL_IDS
3. `pnpm start` → bot 上線
4. 在 Discord 頻道 @mention bot → Claude 回覆
5. 同頻道第二人說話 → 仍有上下文（shared channel session）
6. 兩人同時說話 → 各自等待，不混訊
7. Bot 重啟後 → session resume，對話記憶保留

---

## 實作順序

1. `package.json` + `tsconfig.json` + `.env.example`
2. `config.ts`
3. `acp.ts`（核心，先寫先測）
4. `session.ts`
5. `reply.ts`
6. `discord.ts`
7. `index.ts`（串接所有模組）
