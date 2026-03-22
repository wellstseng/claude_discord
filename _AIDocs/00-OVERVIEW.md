# 00 — CatClaw 全貌

> 版本：v1.0.0 | 最近更新：2026-03-22

## 是什麼

CatClaw 是一個**輕量 Discord bot**，將 Discord 訊息橋接到 Claude Code CLI，提供專案知識問答能力。

- **不依賴 OpenClaw**：直接 spawn `claude -p --output-format stream-json`
- **Persistent session**：per-channel，`--resume` 延續 + 磁碟持久化
- **串流回覆**：`--include-partial-messages` + diff 機制
- **多人並行**：不同 channel 並行，同 channel 串行
- **熱重載**：config.json + cron-jobs.json 編輯存檔即生效

---

## 系統架構圖（文字版）

```
Discord Gateway
      │  messageCreate 事件
      ▼
[discord.ts] handleMessage()
      │  ① bot 自身過濾
      │  ② getChannelAccess() → allowed / requireMention / allowBot / allowFrom
      │  ③ allowBot / allowFrom 過濾
      │  ④ requireMention → strip mention <@id>
      │  ⑤ downloadAttachments() → /tmp/claude-discord-uploads/{msgId}/
      │  ⑥ text 為空 → 忽略
      ▼
[discord.ts] debounce(channelId:authorId, debounceMs=500ms)
      │  多則訊息 \n 合併，記錄第一則 Message
      ▼
[reply.ts] createReplyHandler(firstMessage, config)
      │  建立 event handler + 啟動 typing indicator（8s 重發）
      ▼
[session.ts] enqueue(channelId, prompt, onEvent, opts)
      │  Promise chain 串行（同 channel 等前一個完成）
      │  AbortController + setTimeout(turnTimeoutMs)
      │  TTL 檢查 → 取 sessionId 或 null
      ▼
[session.ts] runTurn()
      │  呼叫 runClaudeTurn()，攔截 session_init，記錄 UUID + 持久化
      │  錯誤時保留 session，下次繼續 --resume
      ▼
[acp.ts] runClaudeTurn(sessionId, text, channelId, signal?)
      │  spawn: claude -p --output-format stream-json --verbose
      │          --include-partial-messages --dangerously-skip-permissions
      │          [--resume <sessionId>] "<prompt>"
      │  env: CATCLAW_CHANNEL_ID=<channelId>
      │  stdio: ["ignore", "pipe", "pipe"]
      │  串流 diff：lastMessageId / lastTextLength / lastThinkingLength / lastToolCount
      │  Event Queue Pattern (Generator + Promise)
      │  AbortSignal → SIGTERM → 250ms → SIGKILL
      ▼
AcpEvent stream (AsyncGenerator)
      │  session_init / text_delta / thinking_delta / tool_call / done / error / status
      ▼
[reply.ts] onEvent handler
      │  text_delta → buffer → ≥2000字立即 flush / 否則 3s 定時 flush
      │  fileMode → totalText > fileUploadThreshold → 等 done 上傳 response.md
      │  tool_call → all:顯示工具名 / summary:首次「處理中」/ none:隱藏
      │  done → extractMediaTokens → flush or sendFile → uploadMediaFile
      │  error → flush + ⚠️ 發生錯誤：{message}
      ▼
Discord 訊息（reply / send / attachment upload）
```

### 獨立排程流程

```
startCron(client) [client.ready 後]
      │  initJobs() ← loadStore() / 補齊狀態 / 修正過期
      │  watchCronJobs() ← fs.watch + 500ms debounce + selfWriting flag
      │  armTimer() ← 計算最近 nextRunAtMs，clamp MIN(2s)~MAX(60s)
      ▼
onTimer() [setTimeout 觸發]
      │  collectRunnableJobs(nowMs) ← entry.enabled≠false && nextRunAtMs<=nowMs
      │  worker pool（maxConcurrentRuns 限制）
      │  runJob() → execMessage() or execClaude()
      │  成功：更新狀態 / at job 刪除 / 計算 nextRunAtMs
      │  失敗：指數退避 (30s/1m/5m) / 超上限跳下次排程
      │  saveStore() 原子寫入
      ▼
armTimer() 重新排程
```

---

## 模組關係圖

```
index.ts
  ├── config.ts     (全域設定 + hot-reload + getChannelAccess)
  ├── logger.ts     (log level 控制)
  ├── discord.ts    (Client + messageCreate + debounce + 附件下載)
  │     ├── config.ts
  │     ├── session.ts  (enqueue)
  │     └── reply.ts    (createReplyHandler)
  ├── session.ts    (per-channel queue + session 快取 + 磁碟持久化)
  │     └── acp.ts  (runClaudeTurn)
  ├── reply.ts      (AcpEvent → Discord 訊息)
  │     └── acp.ts  (AcpEvent 型別)
  └── cron.ts       (排程服務)
        ├── config.ts   (CronSchedule / CronAction 型別 + cron.enabled)
        └── acp.ts      (runClaudeTurn，供 claude action 使用)
```

---

## 核心概念詞彙表

| 詞彙 | 說明 |
|------|------|
| **Session** | Claude CLI 的對話上下文，由 UUID 識別，per-channel（guild 頻道全員共享） |
| **session_init** | claude 首次輸出的系統事件，包含新建立的 session_id UUID |
| **--resume** | Claude CLI flag，用 session_id 延續既有對話上下文 |
| **AcpEvent** | acp.ts 從 claude 串流解析出的事件型別聯集 |
| **text_delta** | 累積文字的新增部分（diff 結果） |
| **stream-json diff** | claude --include-partial-messages 輸出累積文字，需 diff lastTextLength 提取 delta |
| **debounce** | 同一人 debounceMs（預設500ms）內多則訊息合併為一則 |
| **per-channel queue** | Promise chain 實作的串行佇列，同 channel 的 turn 依序執行 |
| **Turn timeout** | AbortController + setTimeout(turnTimeoutMs)，超時自動取消 |
| **TTL** | Session 閒置超時（sessionTtlHours，預設 168h=7天），超過開新 session |
| **fileMode** | 回覆超過 fileUploadThreshold 後切換，等 done 時上傳 response.md |
| **MEDIA token** | Claude 回覆中 `MEDIA: /path` 語法，reply.ts 解析後上傳為 Discord 附件 |
| **hot-reload** | config.json / cron-jobs.json 變更後無需重啟自動生效 |
| **selfWriting** | cron.ts 寫入 cron-jobs.json 時的 flag，防止觸發自身的 fs.watch |
| **signal file** | `signal/RESTART` 檔案，PM2 監聽此目錄變更觸發重啟 |
| **原子寫入** | 先寫 .tmp 再 rename 覆蓋，防止 crash 導致 JSON 損壞 |
| **CATCLAW_CHANNEL_ID** | acp.ts spawn claude 時傳入的環境變數，讓 Claude 知道當前 Discord 頻道 |

---

## 重要常數速查表

| 常數 | 值 | 說明 | 所在檔案 |
|------|-----|------|---------|
| `TEXT_LIMIT` | 2000 | Discord 訊息字數硬上限 | reply.ts |
| `FLUSH_DELAY_MS` | 3000ms | 定時 flush 延遲（收到 text_delta 後多久自動送出） | reply.ts |
| `debounceMs` | 500ms（預設） | 多則訊息合併等待時間，config 可調 | discord.ts/config.ts |
| `typingInterval` | 8000ms | Typing indicator 重發間隔（Discord 約 10s 自動消失） | reply.ts |
| `turnTimeoutMs` | 300000ms（預設） | Claude 回應超時（5分鐘），config 可調 | config.ts |
| `sessionTtlHours` | 168h（預設） | Session 閒置超時（7天），config 可調 | config.ts |
| `fileUploadThreshold` | 4000（預設） | 超過此字數上傳為 .md，0=停用，config 可調 | config.ts |
| `MIN_TIMER_MS` | 2000ms | cron timer 最短間隔 | cron.ts |
| `MAX_TIMER_MS` | 60000ms | cron timer 最長間隔 | cron.ts |
| `BACKOFF_SCHEDULE_MS` | [30000, 60000, 300000] | cron 重試退避：30s / 1min / 5min | cron.ts |
| `maxConcurrentRuns` | 1（預設） | cron 同時執行 job 上限，config 可調 | config.ts |
| processedMessages 上限 | 1000 | 去重 Set 超過此數清空 | discord.ts |
| UPLOAD_DIR | /tmp/claude-discord-uploads | 附件暫存根目錄 | discord.ts |
| SIGTERM delay | 250ms | abort 後等多久若未結束才 SIGKILL | acp.ts |
| stderrTail | 500 chars | 保留 stderr 最後幾字元用於錯誤診斷 | acp.ts |
| CODE_FENCE_RESERVE | 8 chars | flush 時預留給 fence 補開/補關的空間 | reply.ts |
| selfWriting reset delay | 1000ms | cron saveStore 後多久重置 selfWriting flag | cron.ts |

---

## config.json 欄位完整說明

| 欄位路徑 | 型別 | 預設值 | 必填 | 說明 |
|---------|------|--------|------|------|
| `discord.token` | string | — | ✓ | Discord Bot Token |
| `discord.dm.enabled` | boolean | `true` | — | 啟用 DM 回應 |
| `discord.guilds` | Record | `{}` | — | per-guild 設定，空物件=全部允許 |
| `discord.guilds[id].allow` | boolean | `false` | — | Guild 預設：是否允許 |
| `discord.guilds[id].requireMention` | boolean | `true` | — | Guild 預設：是否需 @mention |
| `discord.guilds[id].allowBot` | boolean | `false` | — | Guild 預設：是否處理 bot 訊息 |
| `discord.guilds[id].allowFrom` | string[] | `[]` | — | Guild 預設：白名單（空=不限） |
| `discord.guilds[id].channels[chId].allow` | boolean | guild預設 | — | per-channel 覆寫 allow |
| `discord.guilds[id].channels[chId].requireMention` | boolean | guild預設 | — | per-channel 覆寫 requireMention |
| `discord.guilds[id].channels[chId].allowBot` | boolean | guild預設 | — | per-channel 覆寫 allowBot |
| `discord.guilds[id].channels[chId].allowFrom` | string[] | guild預設 | — | per-channel 覆寫 allowFrom |
| `turnTimeoutMs` | number | `300000` | — | 回應超時毫秒（5分鐘），頂層欄位 |
| `sessionTtlHours` | number | `168` | — | Session 閒置超時小時（7天），頂層欄位 |
| `showToolCalls` | "all"/"summary"/"none" | `"all"` | — | 工具呼叫顯示模式（舊版 boolean 相容） |
| `showThinking` | boolean | `false` | — | 顯示 Claude 推理過程 |
| `debounceMs` | number | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | number | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `logLevel` | "debug"/"info"/"warn"/"error"/"silent" | `"info"` | — | Log 層級 |
| `cron.enabled` | boolean | `false` | — | 啟用排程服務 |
| `cron.maxConcurrentRuns` | number | `1` | — | 同時執行 job 上限 |

> **注意**：config.json（catclaw.json）支援 JSONC（`//` 行尾 / 整行註解）。`claude.cwd` / `claude.command` 已移除，改由環境變數 `CATCLAW_CONFIG_DIR` / `CATCLAW_WORKSPACE` / `CATCLAW_CLAUDE_BIN` 控制。

---

## 部署架構

```
catclaw/                          ← 純程式碼
├── src/              TypeScript 原始碼
├── dist/             編譯後 JS（tsc 輸出，gitignore）
├── signal/           PM2 監聽目錄
│   └── RESTART           重啟 signal file（JSON: {channelId, time}）
├── catclaw.js        跨平台管理腳本
├── ecosystem.config.cjs  PM2 設定（watch: ["signal"]）
└── package.json

~/.catclaw/                       ← CATCLAW_CONFIG_DIR
├── catclaw.json          設定檔（含 token、guild 權限、全域設定）
└── workspace/            ← CATCLAW_WORKSPACE（Claude CLI cwd）
    ├── AGENTS.md             bot 行為規則（system prompt）
    └── data/
        ├── sessions.json     channelId → sessionId 映射（重啟持久化）
        ├── cron-jobs.json    排程 job 定義 + 狀態
        └── active-turns/     進行中 turn 追蹤（crash recovery 用）
```

### PM2 重啟流程

```
tsc 編譯 → dist/ 更新（不觸發重啟）
         ↓
node catclaw.js restart
  → 寫 signal/RESTART（JSON: {channelId, time}）
         ↓
PM2 偵測 signal/ 目錄變更 → 重啟進程
         ↓
index.ts ready 事件 → 讀 signal/RESTART
  → client.channels.fetch(channelId) → send("[CatClaw] 已重啟（時間）")
  → 刪除 signal/RESTART
```

> CATCLAW_CHANNEL_ID 環境變數由 acp.ts spawn claude 時傳入，讓 Claude 知道當前頻道，`catclaw.js restart` 時讀取此值寫入 signal file。

---

## Log 控制

| 層級 | 內容 |
|------|------|
| `info`（預設） | session 載入/建立、bot 上線、錯誤 |
| `debug` | session 決策、event 流、過濾判斷 |
| `ACP_TRACE=1`（環境變數） | acp.ts stdout/stderr raw chunks（獨立於 logLevel，不需重啟） |
