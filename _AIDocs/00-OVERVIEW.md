# 00 — CatClaw 全貌

> 版本：v2.0.0 | 最近更新：2026-04-18

## 是什麼

CatClaw = **Codex 版 Claude Code CLI + 多人 AI 開發平台**。
以 Discord 為前端，提供等同 Claude Code 的完整開發能力。

- **Multi-turn Agent Loop**：tool 迴圈 + output token recovery + auto-compact
- **多 Provider**：Claude API / Ollama / OpenAI-compat / ACP CLI，failover 自動切換
- **25 builtin tools**：file read/write/edit、run_command、search、memory、subagent、hook 管理等
- **28 builtin skills**：Discord 指令層（/think、/mode、/use、/stop、/plan、/remind、/hook 等）
- **34-event hook 系統**：folder-convention 掛載（global + per-agent）+ fs.watch 熱重載 + TS/JS/sh/ps1 多 runtime + defineHook SDK
- **四層記憶引擎**：recall（vector + keyword）、extract、consolidate
- **Context Engineering**：decay（漸進衰減+外部化）/ compaction（結構化摘要+意圖錨點）/ overflow-hard-stop
- **帳號/角色/權限**：identity linking、role-based tool sets、rate limit
- **Web Dashboard**：Trace 視覺化 + Web Chat + REST API
- **串流回覆**：live-edit streaming + chunk fallback + code fence 平衡
- **多人並行**：不同 channel 並行，同 channel 串行
- **熱重載**：catclaw.json + cron-jobs.json 編輯存檔即生效

---

## 系統架構圖（文字版）

```
Discord Gateway
      │  messageCreate 事件
      ▼
[discord.ts] handleMessage()
      │  ① bot 自身過濾
      │  ② getChannelAccess() → allowed / requireMention / allowBot / allowFrom
      │  ③ allowBot / allowFrom / blockGroupMentions 過濾
      │  ④ requireMention → strip mention <@id>（未 mention → inbound-history 記錄）
      │  ⑤ downloadAttachments() → 圖片 base64 + 非圖片存 tmpdir
      │  ⑥ text 為空 → 忽略
      ▼
[discord.ts] debounce(channelId:authorId, debounceMs=500ms)
      │  多則訊息 \n 合併，圖片累積，記錄第一則 Message
      ▼
    ┌─── skill 攔截？matchSkill(text)
    │  是 → skill.execute() → reply → 結束
    │  否 ▼
[discord.ts] 身份解析 + 權限檢查
      │  resolveDiscordIdentity() → accountId
      │  Rate Limit 檢查 → 超限回絕
      │  Provider 路由（channel override > role > project > default）
      ▼
[message-pipeline.ts] runMessagePipeline()
      │  ① Trace 建立
      │  ② Memory Recall（vector + keyword）
      │  ③ Mode Extras 載入
      │  ④ Intent Detection + Module Filter
      │  ⑤ System Prompt 組裝（prompt-assembler）
      │  ⑥ Inbound History 注入
      │  ⑦ Session Memory opts
      ▼
[agent-loop.ts] agentLoop(prompt, opts, deps)
      │  SessionManager 取 session → per-channel 串行佇列
      │  Context 組裝 → Tool list 物理過濾
      │  LLM Provider HTTP API 呼叫（streaming）
      │  tool_use → 執行 tool → 結果回填 → 迴圈至 end_turn
      │  Output Token Recovery（max_tokens 截斷自動續接 ×3）
      │  Auto-compact（decay / LLM compaction / overflow）
      │  萃取 + 事件通知
      ▼
AgentLoopEvent stream (AsyncGenerator)
      │  text_delta / thinking / tool_start / tool_blocked / done / error
      ▼
[reply-handler.ts] handleAgentLoopReply()
      │  streaming 模式：live-edit（EDIT_INTERVAL_MS=800ms）
      │  chunk fallback：FLUSH_DELAY_MS=3000ms 定時 flush
      │  fileMode → totalText > fileUploadThreshold → 等 done 上傳 response.md
      │  tool_start → all:顯示工具名 / summary:首次「處理中」/ none:隱藏
      │  done → extractMediaTokens → flush or sendFile → uploadMediaFile
      │  error → ⚠️ {message}
      ▼
Discord 訊息（reply / edit / send / attachment upload）
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
      │  runJob() → execMessage() / execCommand() / execClaude() / execSubagent()
      │  成功：更新狀態 / at job 刪除 / 計算 nextRunAtMs
      │  失敗：指數退避 (30s/1m/5m) / 超上限跳下次排程
      │  saveStore() 原子寫入
      ▼
armTimer() 重新排程
```

---

## 模組關係圖

```
src/
├── index.ts                 (啟動入口)
├── logger.ts                (log level 控制)
├── discord.ts               (Client + messageCreate + debounce + 附件下載 + skill 攔截)
├── session.ts               (舊版 ACP session，cron claude-acp 仍用)
├── reply.ts                 (舊版 AcpEvent → Discord 回覆，cron claude-acp 仍用)
├── acp.ts                   (Claude CLI spawn，cron claude-acp 仍用)
├── history.ts               (user message 歷史 DB)
├── cron.ts                  (排程服務：timer loop + job 持久化)
├── slash.ts                 (Discord slash commands 註冊)
├── core/
│   ├── config.ts            (全域設定 + hot-reload + getChannelAccess + 型別定義)
│   ├── platform.ts          (子系統初始化工廠)
│   ├── agent-loop.ts        (核心 Agent Loop：multi-turn tool 迴圈)
│   ├── message-pipeline.ts  (統一訊息管線：recall/intent/assembler/trace)
│   ├── prompt-assembler.ts  (模組化 system prompt 組裝)
│   ├── reply-handler.ts     (AgentLoopEvent → Discord streaming 回覆)
│   ├── session.ts           (SessionManager：per-channel 佇列 + 持久化)
│   ├── context-engine.ts    (decay / compaction / overflow-hard-stop)
│   ├── message-trace.ts     (7 階段全鏈路追蹤 + TraceStore)
│   ├── dashboard.ts         (Web Dashboard + REST API + Web Chat)
│   ├── event-bus.ts         (強型別事件匯流排)
│   ├── mode.ts              (模式管理：normal / precise / custom)
│   ├── rate-limiter.ts      (per-role 速率限制)
│   ├── exec-approval.ts     (DM 確認核准)
│   ├── agent-loader.ts      (多 Agent 載入)
│   ├── agent-registry.ts    (Agent 註冊表)
│   ├── subagent-registry.ts (Subagent 管理)
│   ├── subagent-discord-bridge.ts (Subagent ↔ Discord Thread 橋接)
│   ├── session-snapshot.ts  (Session snapshot 儲存)
│   ├── task-store.ts        (Task 持久化)
│   ├── task-ui.ts           (Discord Components v2 Task UI)
│   └── tool-log-store.ts    (Tool 執行日誌)
├── providers/               (LLM Provider 抽象層)
│   ├── registry.ts          (Provider 註冊 + failover 解析)
│   ├── base.ts              (Provider 介面 + 通用型別)
│   ├── claude-api.ts        (Claude HTTP API)
│   ├── ollama.ts            (Ollama 本地 LLM)
│   ├── openai-compat.ts     (OpenAI 相容 API)
│   ├── acp-cli.ts           (Claude CLI spawn wrapper)
│   ├── failover-provider.ts (自動 failover)
│   ├── model-ref.ts         (模型參照解析：alias / "provider/model" 格式)
│   ├── models-config.ts     (models.json 產生與載入 — 模型目錄管理)
│   ├── auth-profile-store.ts (Auth Profile 多憑證 Round-Robin + Cooldown)
│   ├── circuit-breaker.ts   (Provider 層級 circuit breaker)
│   └── codex-oauth.ts       (OpenAI Codex OAuth provider)
├── tools/                   (25 builtin tools)
│   ├── registry.ts          (Tool 註冊表)
│   └── builtin/             (file read/write/edit、run_command、search、hook 管理等)
├── skills/                  (28 builtin skills)
│   ├── registry.ts          (Skill 註冊 + trigger match)
│   ├── builtin/             (25 TS skills)
│   └── builtin-prompt/      (3 prompt skill 子目錄：commit/ discord/ pr/，各含 SKILL.md)
├── memory/                  (四層記憶引擎)
│   ├── engine.ts            (recall + extract + consolidate 統合)
│   ├── recall.ts / extract.ts / consolidate.ts
│   ├── atom.ts / context-builder.ts / session-memory.ts
│   └── write-gate.ts / episodic.ts / index-manager.ts
├── accounts/                (帳號/角色/權限)
│   ├── registry.ts / permission-gate.ts / role-tool-sets.ts
│   └── identity-linker.ts / registration.ts
├── safety/                  (安全守衛)
│   ├── guard.ts / collab-conflict.ts
├── hooks/                   (Hook 系統)
│   ├── hook-registry.ts / hook-runner.ts / hook-runtime.ts / hook-scanner.ts / types.ts
│   ├── metadata-parser.ts / sdk.ts / index.ts
│   └── file-watcher.ts     (檔案變更監控 → hook 觸發)
├── vector/                  (向量搜尋)
│   ├── embedding.ts / lancedb.ts
├── ollama/                  (Ollama client)
│   └── client.ts
├── workflow/                (工作流自動化)
│   ├── memory-extractor.ts / sync-reminder.ts / fix-escalation.ts
│   └── wisdom-engine.ts / rut-detector.ts / oscillation-detector.ts 等
├── discord/                 (Discord 擴充)
│   ├── inbound-history.ts
│   └── bot-circuit-breaker.ts (Bot-to-Bot 對話防呆 circuit breaker)
├── mcp/                     (MCP 整合)
│   ├── client.ts / discord-server.ts
└── projects/                (專案管理)
    └── manager.ts
```

---

## 核心概念詞彙表

| 詞彙 | 說明 |
|------|------|
| **Session** | Claude CLI 的對話上下文，由 UUID 識別，per-channel（guild 頻道全員共享） |
| **session_init** | claude 首次輸出的系統事件，包含新建立的 session_id UUID |
| **--resume** | Claude CLI flag，用 session_id 延續既有對話上下文 |
| **AgentLoopEvent** | agent-loop.ts 產出的事件型別聯集（text_delta / thinking / tool_start / done / error） |
| **AcpEvent** | acp.ts 從 claude CLI 串流解析出的事件型別聯集（舊版，cron claude-acp 仍用） |
| **text_delta** | 累積文字的新增部分 |
| **debounce** | 同一人 debounceMs（預設500ms）內多則訊息合併為一則 |
| **per-channel queue** | Promise chain 實作的串行佇列，同 channel 的 turn 依序執行 |
| **Turn timeout** | AbortController + setTimeout(turnTimeoutMs)，超時自動取消 |
| **TTL** | Session 閒置超時（session.ttlHours，預設 168h=7天），超過開新 session |
| **fileMode** | 回覆超過 fileUploadThreshold 後切換，等 done 時上傳 response.md |
| **MEDIA token** | Claude 回覆中 `MEDIA: /path` 語法，reply-handler.ts 解析後上傳為 Discord 附件 |
| **hot-reload** | config.json / cron-jobs.json 變更後無需重啟自動生效 |
| **selfWriting** | cron.ts 寫入 cron-jobs.json 時的 flag，防止觸發自身的 fs.watch |
| **signal file** | `signal/RESTART` 檔案，PM2 監聽此目錄變更觸發重啟 |
| **原子寫入** | 先寫 .tmp 再 rename 覆蓋，防止 crash 導致 JSON 損壞 |
| **CATCLAW_CHANNEL_ID** | acp.ts spawn claude 時傳入的環境變數，讓 Claude 知道當前 Discord 頻道 |

---

## 重要常數速查表

| 常數 | 值 | 說明 | 所在檔案 |
|------|-----|------|---------|
| `TEXT_LIMIT` | 2000 | Discord 訊息字數硬上限 | core/reply-handler.ts, reply.ts |
| `FLUSH_DELAY_MS` | 3000ms | chunk 模式定時 flush 延遲 | core/reply-handler.ts, reply.ts |
| `EDIT_INTERVAL_MS` | 800ms | streaming 模式最快 edit 間隔 | core/reply-handler.ts |
| `STREAM_SPLIT_THRESHOLD` | 1900 (TEXT_LIMIT-100) | streaming edit 超過此值拆段 | core/reply-handler.ts |
| `debounceMs` | 500ms（預設） | 多則訊息合併等待時間，config 可調 | discord.ts / core/config.ts |
| `typingInterval` | 8000ms | Typing indicator 重發間隔（Discord 約 10s 自動消失） | core/reply-handler.ts |
| `turnTimeoutMs` | 300000ms（預設） | 基礎回應超時（5分鐘），config 可調 | core/config.ts |
| `turnTimeoutToolCallMs` | turnTimeoutMs×1.6（預設） | tool_call 延長超時（預設 8 分鐘），config 可調 | core/config.ts |
| `session.ttlHours` | 168h（預設） | Session 閒置超時（7天），config 可調 | core/config.ts |
| `fileUploadThreshold` | 4000（預設） | 超過此字數上傳為 .md，0=停用，config 可調 | core/config.ts |
| `MAX_LOOPS` | 20 | Agent Loop 單次 turn 最大 tool 迴圈數 | core/agent-loop.ts |
| `MAX_CONTINUATIONS` | 3 | Output Token Recovery 最多自動續接次數 | core/agent-loop.ts |
| `MIN_TIMER_MS` | 2000ms | cron timer 最短間隔 | cron.ts |
| `MAX_TIMER_MS` | 60000ms | cron timer 最長間隔 | cron.ts |
| `BACKOFF_SCHEDULE_MS` | [30000, 60000, 300000] | cron 重試退避：30s / 1min / 5min | cron.ts |
| `maxConcurrentRuns` | 1（預設） | cron 同時執行 job 上限，config 可調 | core/config.ts |
| processedMessages 上限 | 1000 | 去重 Set 超過此數清空 | discord.ts |
| UPLOAD_DIR | `tmpdir()/claude-discord-uploads` | 附件暫存根目錄（os.tmpdir()） | discord.ts |
| SIGTERM delay | 250ms | abort 後等多久若未結束才 SIGKILL | acp.ts |
| stderrTail | 500 chars | 保留 stderr 最後幾字元用於錯誤診斷 | acp.ts |
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
| `turnTimeoutToolCallMs` | number | `turnTimeoutMs×1.6` | — | tool_call 延長超時（預設 8 分鐘） |
| `showToolCalls` | "all"/"summary"/"none" | `"all"` | — | 工具呼叫顯示模式（舊版 boolean 相容） |
| `showThinking` | boolean | `false` | — | 顯示 Claude 推理過程 |
| `debounceMs` | number | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | number | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `streamingReply` | boolean | `true` | — | 串流 live-edit 回覆模式（false=chunk fallback） |
| `logLevel` | "debug"/"info"/"warn"/"error"/"silent" | `"info"` | — | Log 層級 |
| `cron.enabled` | boolean | `false` | — | 啟用排程服務 |
| `cron.maxConcurrentRuns` | number | `1` | — | 同時執行 job 上限 |
| **session** | | | | |
| `session.ttlHours` | number | `168` | — | Session 閒置 TTL（7 天） |
| `session.maxHistoryTurns` | number | `50` | — | 最大保留 turn 數 |
| `session.compactAfterTurns` | number | `30` | — | 超過此值觸發 CE 壓縮 |
| `session.persistPath` | string | `"${workspaceDir}/data/sessions/"` | — | 持久化目錄 |
| **memory** | | | | |
| `memory.enabled` | boolean | `true` | — | 記憶系統開關 |
| `memory.root` | string | `"memory"` | — | 記憶根目錄 |
| `memory.contextBudget` | number | `3000` | — | 注入 token 上限 |
| `memory.recall.vectorSearch` | boolean | `true` | — | 啟用向量搜尋 |
| `memory.extract.perTurn` | boolean | `true` | — | 每輪自動萃取 |
| **safety** | | | | |
| `safety.enabled` | boolean | `true` | — | 安全攔截總開關 |
| `safety.selfProtect` | boolean | `true` | — | 自我保護（禁止修改自身設定） |
| `safety.collabConflict.enabled` | boolean | `true` | — | 協作衝突偵測 |
| `safety.reversibility.threshold` | number | `2` | — | 可逆性警告門檻（0-3） |
| **workflow** | | | | |
| `workflow.guardian.enabled` | boolean | `true` | — | Workflow Guardian 總開關 |
| `workflow.fixEscalation.enabled` | boolean | `true` | — | 精確修正升級 |
| `workflow.wisdomEngine.enabled` | boolean | `true` | — | 經驗累積引擎 |
| `workflow.aidocs.enabled` | boolean | `true` | — | _AIDocs 自動維護 |
| **accounts** | | | | |
| `accounts.registrationMode` | string | `"invite"` | — | 註冊模式（open/invite/closed） |
| `accounts.defaultRole` | string | `"member"` | — | 新帳號預設角色 |
| `accounts.pairingEnabled` | boolean | `true` | — | 是否允許配對 |
| `accounts.pairingExpireMinutes` | number | `10` | — | 配對邀請過期分鐘 |
| **admin** | | | | |
| `admin.allowedUserIds` | string[] | `[]` | — | 管理員 Discord User ID 清單 |
| **agentDefaults** | | | | |
| `agentDefaults.model.primary` | string | — | — | 主要模型（alias 或 "provider/model" 格式） |
| `agentDefaults.model.fallbacks` | string[] | — | — | 備援模型清單 |
| `agentDefaults.models` | Record | — | — | 模型對照表（"provider/model" → alias） |
| **modelsConfig** | | | | |
| `modelsConfig.mode` | "merge"/"replace" | `"merge"` | — | 內建+自訂合併（merge）或僅用自訂（replace） |
| `modelsConfig.providers` | Record | — | — | 自訂 Provider 定義（baseUrl + api + models） |
| **authConfig** | | | | |
| `authConfig.profiles` | Record | — | — | 憑證 profile（provider + mode，不含 credential） |
| `authConfig.order` | Record | — | — | 輪替順序覆寫 |
| `authConfig.cooldowns` | object | — | — | Cooldown 設定覆寫（billingBackoffHours 等） |
| **memoryPipeline** | | | | |
| `memoryPipeline.embedding` | object | — | — | Embedding provider 設定（provider / model / host / apiKey） |
| `memoryPipeline.extraction` | object | — | — | Extraction provider 設定 |
| `memoryPipeline.reranker` | object | — | — | Reranker provider 設定 |
| **dashboard** | | | | |
| `dashboard.enabled` | boolean | `false` | — | Web Dashboard 開關 |
| `dashboard.port` | number | `8088` | — | Dashboard 監聽 port |
| `dashboard.token` | string | — | — | Dashboard 認證 token |
| **defaultAgent** | | | | |
| `defaultAgent` | string | `"default"` | — | 無 --agent 參數時的預設 boot agent ID |
| **agents** | | | | |
| `agents` | Record | — | — | 多 Agent 入口設定（`agents.<id>` 為 BridgeConfig 子集） |
| **subagents** | | | | |
| `subagents.maxConcurrent` | number | `3` | — | 同一 parent session 最多同時執行子 agent 數 |
| `subagents.defaultTimeoutMs` | number | `120000` | — | Subagent 預設逾時毫秒 |
| `subagents.defaultKeepSession` | boolean | `false` | — | 完成後是否預設保留 session |
| **botCircuitBreaker** | | | | |
| `botCircuitBreaker.enabled` | boolean | `true` | — | Bot-to-Bot 對話防呆開關 |
| `botCircuitBreaker.maxRounds` | number | `10` | — | 連續 bot 互動最大來回輪數 |
| `botCircuitBreaker.maxDurationMs` | number | `180000` | — | 連續 bot 互動最大持續時間 ms（3 分鐘） |
| **fileWatcher** | | | | |
| `fileWatcher.enabled` | boolean | — | — | File Watcher 開關 |
| `fileWatcher.watches` | array | — | — | 監看項目清單（FileWatchEntry[]） |
| `fileWatcher.maxEventsPerWindow` | number | — | — | 速率限制：每視窗最多事件數 |
| `fileWatcher.eventWindowMs` | number | `60000` | — | 速率限制視窗毫秒 |
| **homeClaudeCode** | | | | |
| `homeClaudeCode.enabled` | boolean | `false` | — | 啟用與 Claude Code 共用全域記憶（~/.claude/memory/global）（已棄用） |
| `homeClaudeCode.path` | string | `"~/.claude/memory/global"` | — | 自訂 Claude Code 記憶路徑 |
| **modes** | | | | |
| `modes.defaultMode` | string | `"normal"` | — | 預設模式名稱 |
| `modes.presets` | Record | — | — | 模式定義表（thinking / compaction / systemPromptExtras） |
| **mcpServers** | | | | |
| `mcpServers` | Record | — | — | MCP Server 定義（command / args / cwd / env） |
| **hooks** | | | | |
| `hooks` | array | — | — | Hook 定義陣列（HookDefinition[]） |
| **ollama** | | | | |
| `ollama.enabled` | boolean | `false` | — | Ollama 雙 Backend 開關 |
| `ollama.primary.host` | string | — | — | 主要 Ollama host |
| `ollama.primary.model` | string | — | — | 主要 model 名稱 |
| `ollama.primary.embeddingModel` | string | — | — | Embedding model |
| `ollama.fallback` | object | — | — | 備援 Ollama（host / model） |
| **rateLimit** | | | | |
| `rateLimit` | Record | per-role 預設 | — | 速率限制（`rateLimit.<role>.requestsPerMinute`） |
| **inboundHistory** | | | | |
| `inboundHistory.enabled` | boolean | `false` | — | Inbound History 開關 |
| `inboundHistory.fullWindowHours` | number | `24` | — | 完整收錄時窗 |
| `inboundHistory.decayWindowHours` | number | `168` | — | 衰減時窗 |
| `inboundHistory.inject.enabled` | boolean | `false` | — | 注入到 prompt 開關 |
| **contextEngineering** | | | | |
| `contextEngineering.enabled` | boolean | `false` | — | Context Engineering 開關 |
| `contextEngineering.strategies` | object | — | — | Compaction 策略（model / maxTokens） |
| `contextEngineering.toolBudget.resultTokenCap` | number | `0` | — | 單一工具結果 token 上限（0=無限制） |
| `contextEngineering.toolBudget.perTurnTotalCap` | number | `0` | — | 每 turn 所有工具結果合計 token 上限 |
| `contextEngineering.toolBudget.toolTimeoutMs` | number | `30000` | — | 單一 tool 執行超時毫秒（0=無限制） |
| `contextEngineering.toolBudget.maxWriteFileBytes` | number | `512000` | — | write/edit_file 單次寫入上限 bytes（500KB） |

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
        ├── sessions/         per-channel session 持久化目錄
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
