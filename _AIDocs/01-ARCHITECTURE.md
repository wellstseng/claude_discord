# 01 — 架構概覽

> 最近更新：2026-04-18

## 專案目標

獨立多人 AI 平台 — 以 Discord 為前端介面，內建 Agent Loop、Provider 抽象層、四層記憶系統、權限控制的完整 AI 平台。

- **Agent Loop（一軌制）**：CatClaw 自有 agent loop 控制所有 tool，LLM 只負責思考
- **HTTP API 直連**：透過 pi-ai `streamSimpleAnthropic` 直接呼叫 Claude API，不 spawn CLI
- **Provider 抽象**：claude-api / ollama / openai-compat / codex-oauth，hot-swap via registry
- **models.json**：model 設定唯一真相來源（per-agent，位於 agents/{agentId}/models.json）
- **四層記憶**：Global + Project + Account + Agent（atom memory + LanceDB vector search）
- **權限系統**：5 級角色（guest → platform-owner）+ Tool Tier 物理移除
- **Message Trace**：7 階段訊息生命週期追蹤
- **Web Dashboard**：設定、traces、sessions、auth profiles、model switching
- **熱重載**：catclaw.json + models.json 編輯存檔即生效

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14.16.3 | Discord Gateway 連線、訊息收發 |
| `@mariozechner/pi-ai` 0.58.0 | LLM HTTP API 串流（streamSimpleAnthropic） |
| `@mariozechner/pi-agent-core` 0.58.0 | Agent 核心工具 |
| `@lancedb/lancedb` ^0.27.1 | 向量資料庫（記憶 recall） |
| `apache-arrow` ^18.1.0 | LanceDB 底層依賴 |
| `croner` ^10.0.1 | Cron 排程表達式解析 |
| `typescript` ^5.7.2 | 編譯 |
| `pm2` ^6.0.14（devDep） | 進程管理 + signal file 重啟 |

套件管理：**pnpm**

## 系統架構圖

```
Discord Gateway
      │  messageCreate 事件
      ▼
[discord.ts] handleMessage()
      │  ① bot 自身過濾
      │  ② getChannelAccess() → allowed / requireMention / allowBot / allowFrom
      │  ③ allowBot / allowFrom 過濾
      │  ④ requireMention → strip mention <@id>
      │  ⑤ downloadAttachments() → {tmpdir()}/claude-discord-uploads/{msgId}/
      │  ⑥ text 為空 → 忽略
      ▼
[discord.ts] debounce(channelId:authorId, debounceMs=500ms)
      │  多則訊息 \n 合併
      ▼
[slash.ts] Skill 指令攔截
      │  /configure, /use, /system, /session, /status ...
      │  命中 → skill handler 直接處理，不進 agent loop
      │  未命中 ↓
      ▼
[session.ts] enqueue(channelId, prompt, opts)
      │  Promise chain 串行（同 channel 等前一個完成）
      │  AbortController + setTimeout(turnTimeoutMs)
      ▼
[platform.ts] 身份解析 + 子系統初始化
      │  ProviderRegistry / AccountRegistry / ToolRegistry / PermissionGate
      │  SafetyGuard / SessionManager / MemoryEngine / ContextEngine
      ▼
[agent-loop.ts] runAgentLoop()
      │  ① 身份 + 權限檢查
      │  ② 記憶 Recall（atom + vector search）
      │  ③ Context 組裝（ContextEngine strategy pipeline）
      │  ④ Tool list 物理過濾（依角色 tier）
      │  ⑤ LLM 呼叫 → 處理 tool_use → 迴圈至 end_turn
      │  ⑥ Post-compact Recovery + 萃取 + 事件通知
      ▼
[providers/] LLM Provider（HTTP API 串流）
      │  claude-api.ts    → Anthropic Messages API
      │  ollama.ts        → Ollama API
      │  openai-compat.ts → OpenAI-compatible API
      │  codex-oauth.ts   → Codex OAuth 流程
      │  failover-provider.ts → 自動 failover
      ▼
[reply-handler.ts] AgentLoopEvent → Discord 訊息
      │  streaming 模式：live-edit（類 ChatGPT）
      │  chunk 模式：逐段發送
      │  fileMode → 超閾值上傳 response.md
      │  MEDIA token → 解析上傳為 Discord 附件
      ▼
Discord 訊息（reply / edit / attachment upload）
```

### Message Trace（7 階段生命週期追蹤）

```
Inbound → Context → LLM Loop → CE → Abort → PostProcess → Response
  收到訊息   記憶recall   tool迴圈   壓縮    中斷處理    萃取/事件    回覆送出
              context組裝
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
      │  runJob() → execMessage() / execClaude() / execCommand() / execSubagent()
      │  成功：更新狀態 / at job 刪除 / 計算 nextRunAtMs
      │  失敗：指數退避 (30s/1m/5m) / 超上限跳下次排程
      │  saveStore() 原子寫入
      ▼
armTimer() 重新排程
```

## 模組關係圖

```
index.ts                          ← 進入點：Discord login + 事件綁定
  ├── core/config.ts              設定載入 + hot-reload + env expansion
  ├── logger.ts                   log level 控制
  ├── discord.ts                  Client + messageCreate + debounce + 附件下載
  │     └── slash.ts              Skill 指令攔截（/ 前綴命令）
  ├── core/platform.ts            V2 平台子系統初始化器（singleton factory）
  │     ├── providers/registry.ts    Provider 註冊 + 路由解析
  │     ├── accounts/registry.ts     帳號 + 角色管理
  │     ├── accounts/permission-gate.ts  角色 Tier 權限閘門
  │     ├── tools/registry.ts        Tool 註冊 + 物理過濾
  │     ├── safety/guard.ts          安全防護
  │     ├── core/session.ts          Session 管理 + 持久化
  │     ├── memory/engine.ts         四層記憶引擎
  │     ├── core/context-engine.ts   Context 壓縮 + token 追蹤
  │     └── core/message-trace.ts    訊息全鏈路追蹤
  ├── core/agent-loop.ts          Agent Loop 核心迴圈
  │     ├── providers/base.ts        LLM Provider 介面
  │     ├── tools/builtin/*          Tool 實作（LLM 可呼叫）
  │     ├── core/context-engine.ts   Context 策略管線
  │     ├── core/agent-types.ts      Typed Agent 定義（explore/plan/build/review）
  │     ├── core/task-store.ts       Per-session 任務追蹤
  │     ├── core/prompt-assembler.ts System Prompt 模組化組裝
  │     └── safety/collab-conflict.ts 協作衝突偵測
  ├── core/reply-handler.ts       AgentLoopEvent → Discord 分段回覆
  ├── core/dashboard.ts           Web Dashboard（HTTP server）
  ├── skills/registry.ts          Skill 註冊表
  │     └── skills/builtin/*         Skill 實作（使用者 / 指令觸發）
  ├── workflow/bootstrap.ts       工作流自動化（萃取、同步提醒等）
  ├── cron.ts                     排程服務
  └── acp.ts                      Legacy CLI spawn（相容路徑，非主流程）
```

## Provider 架構

```
providers/
  ├── base.ts              LLMProvider 介面 + Message 格式（遵循 Anthropic Messages API）
  ├── registry.ts          ProviderRegistry — 初始化、路由、解析
  ├── models-config.ts     models.json 產生與載入（唯一 model 真相來源）
  ├── model-ref.ts         ModelRef 解析（provider:model 格式）
  ├── auth-profile-store.ts  OAuth profile 持久化
  ├── claude-api.ts        Anthropic Claude API（pi-ai streamSimpleAnthropic）
  ├── ollama.ts            Ollama 本地模型
  ├── openai-compat.ts     OpenAI 相容 API
  ├── codex-oauth.ts       Codex OAuth 登入流程
  ├── failover-provider.ts 自動 failover（primary → fallback chain）
  └── circuit-breaker.ts   熔斷器（連續失敗暫停）

路由優先序：
  1. 頻道綁定（channels.{channelId}）
  2. 專案綁定（projects.{projectId}）
  3. 角色綁定（roles.{role}）
  4. 全域預設（defaultProvider）
```

## 核心概念詞彙表

| 詞彙 | 說明 |
|------|------|
| **Agent Loop** | CatClaw 自有的 LLM 對話迴圈（一軌制），控制 tool 執行，LLM 只負責思考。MAX_LOOPS=20 |
| **Provider** | LLM 供應商抽象（claude-api / ollama / openai-compat / codex-oauth），實作 LLMProvider 介面 |
| **ProviderRegistry** | Provider 註冊表，依路由規則解析出當前 channel/project/role 應使用的 provider |
| **models.json** | Model 設定唯一真相來源（V2 per-agent）：primary / fallback / aliases / routing |
| **ModelRef** | `provider:model` 格式字串，用於跨 provider 引用 model |
| **FailoverProvider** | 包裝層，primary 失敗自動切換 fallback chain |
| **CircuitBreaker** | 熔斷器，連續失敗暫停呼叫，防止雪崩 |
| **Tool Tier** | Tool 分級：public / standard / elevated / admin / owner |
| **PermissionGate** | 依角色 tier 物理過濾 LLM 可見的 tool list（非 prompt 提示，直接移除） |
| **Role** | 5 級角色：guest → member → developer → admin → platform-owner |
| **Skill** | 使用者觸發的 `/` 前綴指令（/configure、/use、/session 等），不經 agent loop |
| **Tool** | LLM 可呼叫的函式（config_get、memory_recall、run_command 等），由 agent loop 執行 |
| **ContextEngine** | Strategy Pattern 架構，管線式套用三段策略（Decay 漸進衰減+外部化 → Compaction 結構化摘要+意圖錨點 → OverflowHardStop 緊急截斷） |
| **MessageTrace** | 7 階段訊息生命週期追蹤：Inbound → Context → LLM Loop → CE → Abort → PostProcess → Response |
| **TraceStore** | 統一追蹤系統，持久化所有 MessageTrace 記錄 |
| **Session** | per-channel 對話上下文（guild 頻道共享），per-user for DM |
| **SessionManager** | Session 快取 + 磁碟持久化 + TTL + per-channel queue |
| **MemoryEngine** | 四層記憶引擎（Global + Project + Account + Agent），atom + LanceDB vector search |
| **Atom Memory** | 原子記憶系統：知識以 atom 為最小單位，分 [固]/[觀]/[臨] 三級 |
| **LanceDB** | 向量資料庫，用於記憶 recall 時的語義搜尋 |
| **Dashboard** | Web 監控面板：概覽 / Sessions / 日誌 / 操作 / Config |
| **EventBus** | 內部事件匯流排，子系統間鬆耦合通訊 |
| **Output Token Recovery** | max_tokens 截斷時自動續接（MAX_CONTINUATIONS=3） |
| **Post-compact Recovery** | compact 後自動恢復 + batch partition |
| **debounce** | 同一人 debounceMs（預設500ms）內多則訊息合併為一則 |
| **per-channel queue** | Promise chain 實作的串行佇列，同 channel 的 turn 依序執行 |
| **Turn timeout** | AbortController + setTimeout(turnTimeoutMs)，超時自動取消 |
| **TTL** | Session 閒置超時（sessionTtlHours，預設 168h=7天），超過開新 session |
| **fileMode** | 回覆超過 fileUploadThreshold 後切換，等完成時上傳 response.md |
| **MEDIA token** | LLM 回覆中 `MEDIA: /path` 語法，reply-handler 解析後上傳為 Discord 附件 |
| **hot-reload** | catclaw.json / models.json 變更後無需重啟自動生效 |
| **signal file** | `signal/RESTART` 檔案，PM2 監聽此目錄變更觸發重啟 |
| **原子寫入** | 先寫 .tmp 再 rename 覆蓋，防止 crash 導致 JSON 損壞 |
| **SafetyGuard** | 安全防護層，輸入/輸出檢查 |
| **Workflow** | 自動化工作流（記憶萃取、同步提醒、失敗偵測、振盪偵測等） |
| **Subagent** | Agent Loop 可 spawn 的子代理，獨立 context 執行子任務 |
| **AuthProfileStore** | OAuth profile 持久化（Codex 等外部登入憑證管理） |
| **AgentType** | Typed Agent 定義（explore/plan/build/review），每型別有 tool 白名單、system prompt、model 覆寫 |
| **TaskStore** | Per-session 結構化任務追蹤（create/update/list/get/delete），支援 dependencies |
| **PromptAssembler** | System Prompt 模組化組裝器，按 mode + 角色動態組裝 PromptModule（priority 排序） |
| **ToolSearch** | Deferred Tool 載入機制——低頻 tool 僅列名稱，LLM 需要時呼叫 tool_search 取得完整 schema |
| **Deferred Tool** | 標記 `deferred: true` 的 tool，不在每次 LLM 呼叫注入完整 schema，減少 token 開銷 |
| **RoleToolSet** | 角色 Tool Set 定義，developer=完整 coding set、guest=read-only，疊加 tier 過濾 |
| **CollabConflict** | 多人同頻道同時編輯同一檔案時的衝突偵測 + EventBus 警告 |
| **Reversibility** | before_tool_call 評估操作可逆性（destructive score 0-3），≥2 注入警告訊息 |
| **Worktree Isolation** | spawn_subagent `isolation:"worktree"` → git worktree 隔離分支工作，完成後判定 merge/丟棄 |
| **Git Safety** | run_command 內建 checkGitSafety，攔截 force push、amend、skip hooks 等危險 git 操作 |

## 專案結構

```
~/project/catclaw/              ← 純程式碼
├── src/
│   ├── index.ts                進入點：Discord login + 事件綁定
│   ├── logger.ts               Log level 控制
│   ├── discord.ts              Discord client + debounce + per-channel 過濾 + 附件下載
│   ├── slash.ts                Skill 指令攔截（/ 前綴命令 router）
│   ├── reply.ts                Legacy 回覆（舊 ACP 路徑用）
│   ├── session.ts              Legacy session（舊路徑用）
│   ├── acp.ts                  Legacy CLI spawn（相容路徑，非主流程）
│   ├── history.ts              歷史訊息管理
│   ├── cron.ts                 排程服務（cron-jobs.json hot-reload + timer + job runner）
│   │
│   ├── core/                   ★ 核心子系統
│   │   ├── platform.ts            V2 平台初始化器（所有子系統 singleton factory）
│   │   ├── agent-loop.ts          Agent Loop 核心迴圈（一軌制）
│   │   ├── agent-loader.ts        Agent 載入器
│   │   ├── agent-registry.ts      Agent 註冊表
│   │   ├── config.ts              擴充版設定載入器（含 providers/memory/workflow 等區塊）
│   │   ├── context-engine.ts      Context 壓縮 + token 追蹤（Strategy Pattern）
│   │   ├── dashboard.ts           Web Dashboard（HTTP 多分頁監控面板）
│   │   ├── event-bus.ts           內部事件匯流排
│   │   ├── exec-approval.ts       指令執行審批
│   │   ├── message-trace.ts       訊息全鏈路追蹤（7 階段）
│   │   ├── mode.ts                精密模式系統
│   │   ├── rate-limiter.ts        速率限制
│   │   ├── reply-handler.ts       AgentLoopEvent → Discord 分段回覆（streaming / chunk）
│   │   ├── session.ts             Session 管理 + 持久化 + TTL
│   │   ├── session-snapshot.ts    Session snapshot 持久化
│   │   ├── subagent-registry.ts   Subagent 註冊表
│   │   ├── subagent-discord-bridge.ts  Subagent ↔ Discord 橋接
│   │   ├── tool-log-store.ts      Tool 執行日誌
│   │   ├── agent-types.ts         Typed Agent 定義（explore/plan/build/review + tool 白名單）
│   │   ├── task-store.ts          Per-session 結構化任務追蹤
│   │   └── prompt-assembler.ts    System Prompt 模組化組裝器（PromptModule + priority）
│   │
│   ├── providers/              ★ LLM Provider 抽象層
│   │   ├── base.ts                LLMProvider 介面 + Message 格式
│   │   ├── registry.ts            Provider 註冊 + 路由解析
│   │   ├── models-config.ts       models.json 產生與載入
│   │   ├── model-ref.ts           ModelRef 解析（provider:model）
│   │   ├── auth-profile-store.ts  OAuth profile 持久化
│   │   ├── claude-api.ts          Anthropic Claude API
│   │   ├── ollama.ts              Ollama 本地模型
│   │   ├── openai-compat.ts       OpenAI 相容 API
│   │   ├── codex-oauth.ts         Codex OAuth 登入
│   │   ├── failover-provider.ts   自動 failover
│   │   ├── circuit-breaker.ts     熔斷器
│   │   └── acp-cli.ts             Legacy ACP CLI Provider（spawn claude CLI）
│   │
│   ├── accounts/               ★ 帳號 + 權限
│   │   ├── registry.ts            帳號 + 角色管理
│   │   ├── permission-gate.ts     角色 Tier 權限閘門
│   │   ├── registration.ts        帳號註冊
│   │   ├── identity-linker.ts     跨平台身份連結
│   │   └── role-tool-sets.ts      角色 Tool Set（developer=完整 coding / guest=read-only）
│   │
│   ├── tools/                  ★ LLM 可呼叫 Tool
│   │   ├── registry.ts            Tool 註冊表
│   │   ├── types.ts               Tool 型別定義（ToolTier / ToolDefinition）
│   │   └── builtin/               （25 個 tool）
│   │       ├── atom-delete.ts     Atom 刪除
│   │       ├── atom-write.ts      Atom 寫入
│   │       ├── clear-session.ts   Session 清除
│   │       ├── config-get.ts      讀取設定
│   │       ├── config-patch.ts    修改設定
│   │       ├── edit-file.ts       編輯檔案
│   │       ├── filewatch.ts       檔案監視
│   │       ├── glob.ts            檔案搜尋
│   │       ├── grep.ts            內容搜尋
│   │       ├── hook-list.ts       Hook 列表
│   │       ├── hook-register.ts   Hook 註冊
│   │       ├── hook-remove.ts     Hook 移除
│   │       ├── llm-task.ts        LLM 子任務
│   │       ├── memory-recall.ts   記憶召回
│   │       ├── read-file.ts       讀檔
│   │       ├── run-command.ts     執行命令
│   │       ├── session-context.ts Session Context 查詢
│   │       ├── skill.ts           Skill 呼叫
│   │       ├── spawn-subagent.ts  Spawn 子代理
│   │       ├── subagents.ts       子代理管理
│   │       ├── task-manage.ts     結構化任務管理（create/update/list/get/delete）
│   │       ├── tool-search.ts     Deferred Tool Schema 查詢
│   │       ├── web-fetch.ts       網頁擷取
│   │       ├── web-search.ts      網路搜尋
│   │       └── write-file.ts      寫檔
│   │
│   ├── skills/                 ★ 使用者 / 指令觸發 Skill
│   │   ├── registry.ts            Skill 註冊表
│   │   ├── types.ts               Skill 型別定義
│   │   ├── builtin/               （25 個 skill）
│   │   │   ├── account.ts         /account — 帳號管理
│   │   │   ├── add-bridge.ts      /add-bridge — CLI Bridge 新增
│   │   │   ├── aidocs.ts          /aidocs — _AIDocs 管理
│   │   │   ├── compact.ts         /compact — 手動壓縮
│   │   │   ├── config-manage.ts   /config — 設定操作
│   │   │   ├── configure.ts       /configure — 設定管理 + OAuth 登入
│   │   │   ├── context.ts         /context — Context 資訊
│   │   │   ├── help.ts            /help
│   │   │   ├── hook.ts            /hook — Hook 管理
│   │   │   ├── migrate.ts         /migrate — 資料遷移
│   │   │   ├── mode.ts            /mode — 精密模式
│   │   │   ├── plan.ts            /plan — 計畫管理
│   │   │   ├── project.ts         /project — 專案管理
│   │   │   ├── register.ts        /register — 帳號註冊
│   │   │   ├── remind.ts          /remind — 提醒
│   │   │   ├── restart.ts         /restart — 重啟
│   │   │   ├── session-manage.ts  /session — session 管理
│   │   │   ├── status.ts          /status — 狀態查詢
│   │   │   ├── stop.ts            /stop — 中斷 turn
│   │   │   ├── subagents.ts       /subagents — 子代理管理
│   │   │   ├── system.ts          /system — 系統資訊
│   │   │   ├── think.ts           /think — 強制思考
│   │   │   ├── turn-audit.ts      /audit — turn 追蹤
│   │   │   ├── usage.ts           /usage — 用量統計
│   │   │   └── use.ts             /use — 切換 model
│   │   └── builtin-prompt/
│   │       └── discord/SKILL.md   Discord 平台 skill 提示詞
│   │
│   ├── memory/                 ★ 四層記憶系統
│   │   ├── engine.ts              記憶引擎（Global + Project + Account + Agent）
│   │   ├── recall.ts              記憶召回
│   │   ├── atom.ts                Atom 讀寫
│   │   ├── extract.ts             知識萃取
│   │   ├── context-builder.ts     記憶 → context 組裝
│   │   ├── consolidate.ts         記憶整合
│   │   ├── episodic.ts            情境記憶
│   │   ├── index-manager.ts       索引管理
│   │   ├── session-memory.ts      Session 記憶
│   │   └── write-gate.ts          寫入閘門
│   │
│   ├── vector/                 向量搜尋
│   │   ├── lancedb.ts             LanceDB 封裝
│   │   └── embedding.ts           Embedding 生成
│   │
│   ├── ollama/                 Ollama 本地服務
│   │   └── client.ts              Ollama client
│   │
│   ├── projects/               專案管理
│   │   └── manager.ts             專案 CRUD
│   │
│   ├── safety/                 安全防護
│   │   ├── guard.ts               輸入/輸出檢查
│   │   └── collab-conflict.ts     協作衝突偵測（多人同檔編輯警告）
│   │
│   ├── workflow/               工作流自動化
│   │   ├── bootstrap.ts           工作流初始化
│   │   ├── memory-extractor.ts    自動記憶萃取
│   │   ├── sync-reminder.ts       同步提醒
│   │   ├── failure-detector.ts    失敗偵測
│   │   ├── oscillation-detector.ts  振盪偵測
│   │   ├── rut-detector.ts        重試窠臼偵測
│   │   ├── fix-escalation.ts      修正升級
│   │   ├── wisdom-engine.ts       智慧引擎
│   │   ├── memory-vector-sync.ts  記憶向量同步
│   │   ├── consolidate-scheduler.ts  整合排程
│   │   ├── file-tracker.ts        檔案追蹤
│   │   ├── aidocs-manager.ts      _AIDocs 管理
│   │   └── types.ts               工作流型別
│   │
│   ├── cli-bridge/             CLI Bridge（外部 CLI 橋接）
│   │   ├── bridge.ts              Bridge 核心
│   │   ├── discord-sender.ts      Discord 訊息發送
│   │   ├── index.ts               進入點
│   │   ├── process.ts             程序管理
│   │   ├── reply.ts               回覆處理
│   │   ├── stdout-log.ts          stdout 日誌
│   │   └── types.ts               型別定義
│   │
│   ├── discord/                Discord 擴充
│   │   └── inbound-history.ts     入站歷史（Decay II）
│   │
│   ├── mcp/                    MCP 協議
│   │   ├── client.ts              MCP client
│   │   └── discord-server.ts      MCP Discord server
│   │
│   └── migration/              資料遷移
│       ├── rename-sessions.ts     Session 重命名
│       ├── import-claude.ts       Claude 對話匯入
│       └── rebuild-index.ts       索引重建
│
├── signal/             PM2 監聽目錄（gitignore）
│   └── RESTART         重啟 signal file（JSON: {channelId, time}）
├── _AIDocs/            知識庫
│   └── modules/        各模組詳細文件
├── config.example.json 設定範本
├── catclaw.js          跨平台管理腳本
├── ecosystem.config.cjs  PM2 設定（watch: ["signal"]）
├── CLAUDE.md           Claude CLI 專案指引（@import ~/.catclaw/workspace/AGENTS.md）
├── package.json
└── tsconfig.json

~/.catclaw/                     ← CATCLAW_CONFIG_DIR
├── catclaw.json        設定檔（含 token、guild 權限、providers、memory、workflow 等全區塊）
├── models-config.json  Legacy model 設定（V2 已改用 per-agent models.json）
└── workspace/          ← CATCLAW_WORKSPACE
    ├── AGENTS.md           bot 行為規則（system prompt）
    └── data/
        ├── sessions/           Session 持久化（per-channel context）
        ├── traces/             MessageTrace 持久化
        ├── cron-jobs.json      排程 job 定義 + 狀態
        └── auth-profiles/      OAuth profile 存放
```

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
| `discord.guilds[id].channels[chId].*` | ChannelConfig | guild 預設 | — | per-channel 覆寫（同上 4 欄位 + boundProject） |
| `providers` | object | — | — | Provider 設定區塊（啟用時走 V2 Agent Loop 路徑） |
| `admin.allowedUserIds` | string[] | `[]` | — | Platform-owner 身份的 Discord User ID |
| `turnTimeoutMs` | number | `300000` | — | 基礎回應超時毫秒（5分鐘） |
| `turnTimeoutToolCallMs` | number | `turnTimeoutMs×1.6` | — | tool_call 偵測後延長至此值（預設 8 分鐘） |
| `sessionTtlHours` | number | `168` | — | Session 閒置超時小時（7天） |
| `showToolCalls` | "all"/"summary"/"none" | `"all"` | — | 工具呼叫顯示模式 |
| `showThinking` | boolean | `false` | — | 顯示 LLM 推理過程 |
| `debounceMs` | number | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | number | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `logLevel` | string | `"info"` | — | debug/info/warn/error/silent |
| `cron.enabled` | boolean | `false` | — | 啟用排程服務 |
| `cron.maxConcurrentRuns` | number | `1` | — | 同時執行 job 上限 |
| `dashboard.port` | number | — | — | Web Dashboard 監聽埠 |

> catclaw.json 支援 JSONC（`//` 行尾 / 整行註解）。字串值符合 `${ENV_VAR_NAME}` 格式時自動展開環境變數。

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道所有人共享對話 context |
| DM | `channelId`（每人唯一） | per-user session |

- 首次 → agent-loop 建立 session → SessionManager 持久化
- 後續 → 載入既有 context 繼續
- ContextEngine 管理 token budget → 超閾值自動 compaction
- 超過 TTL → 開新 session
- 錯誤時保留 session，下次繼續
- 重啟 → SessionManager 從磁碟載入

## PM2 重啟流程

```
tsc 編譯 → dist/ 更新（不觸發重啟）
         ↓
使用者確認 → node catclaw.js restart（或直接寫 signal file）
  → 寫 signal/RESTART（JSON: {channelId, time}）
         ↓
PM2 偵測 signal/ 目錄變更 → 重啟進程
         ↓
index.ts ready 事件 → 讀 signal/RESTART
  → client.channels.fetch(channelId) → send("[CatClaw] 已重啟（時間）")
  → 刪除 signal/RESTART
```

## 重要常數速查表

| 常數 | 值 | 說明 | 所在檔案 |
|------|-----|------|---------|
| `MAX_LOOPS` | 20 | Agent Loop 單次 turn 最大迴圈數 | agent-loop.ts |
| `MAX_CONTINUATIONS` | 3 | Output Token Recovery 最多自動續接次數 | agent-loop.ts |
| `DEFAULT_RESULT_TOKEN_CAP` | 8000 | Tool result 截斷 token 上限（≈32000 chars） | agent-loop.ts |
| `TEXT_LIMIT` | 2000 | Discord 訊息字數硬上限 | reply-handler.ts |
| `FLUSH_DELAY_MS` | 3000ms | chunk 模式定時 flush 延遲 | reply-handler.ts |
| `EDIT_INTERVAL_MS` | 800ms | streaming 模式最快 edit 間隔 | reply-handler.ts |
| `debounceMs` | 500ms（預設） | 多則訊息合併等待，config 可調 | discord.ts/config.ts |
| `turnTimeoutMs` | 300000ms（預設） | 基礎回應超時（5分鐘），config 可調 | config.ts |
| `turnTimeoutToolCallMs` | turnTimeoutMs×1.6（預設） | tool_call 延長超時（預設 8 分鐘），config 可調 | config.ts |
| `sessionTtlHours` | 168h（預設） | Session 閒置超時（7天），config 可調 | config.ts |
| `fileUploadThreshold` | 4000（預設） | 超過此字數上傳 .md，0=停用，config 可調 | config.ts |
| `MIN_TIMER_MS` | 2000ms | cron timer 最短間隔 | cron.ts |
| `MAX_TIMER_MS` | 60000ms | cron timer 最長間隔 | cron.ts |
| `BACKOFF_SCHEDULE_MS` | [30000, 60000, 300000] | cron 重試退避：30s / 1min / 5min | cron.ts |
| `TIER_ORDER` | public→standard→elevated→admin→owner | Tool Tier 排序 | permission-gate.ts |
| `BACKUP_KEEP` | 5 | Dashboard config 備份保留數 | dashboard.ts |

## Log 控制

| 層級 | 內容 |
|------|------|
| `info`（預設） | session 載入/建立、bot 上線、provider 初始化、錯誤 |
| `debug` | session 決策、agent loop event、tool 執行、context 壓縮、權限判斷 |
