# CatClaw WIKI

> Codex 版 Claude Code CLI + 多人 AI 開發平台
> 最近更新：2026-04-07

---

## 目錄

1. [快速入門](#1-快速入門)
2. [架構總覽](#2-架構總覽)
3. [設定指南](#3-設定指南)
4. [功能指南](#4-功能指南)
5. [部署與維運](#5-部署與維運)
6. [常見陷阱](#6-常見陷阱)
7. [模組索引](#7-模組索引)

---

## 1. 快速入門

### CatClaw 是什麼

CatClaw 是一套以 Discord 為前端的多人 AI 開發平台，提供等同 Claude Code 的完整開發能力：
multi-turn agent loop、17+ builtin tools、25 builtin skills、多 provider failover、
三層記憶引擎、Context Engineering、subagent 編排、帳號/角色/權限系統、Web Dashboard。

### 安裝

```bash
# 1. Clone
git clone <repo-url> catclaw && cd catclaw

# 2. 安裝依賴（pnpm）
pnpm install

# 3. 初始化設定（自動複製 catclaw.example.json → ~/.catclaw/catclaw.json）
node catclaw.js init

# 4. 編輯設定：填入 discord.token，設定 guilds 權限
#    位置：~/.catclaw/catclaw.json（JSONC 格式，支援 // 註解）

# 5. 編譯 + 啟動
node catclaw.js start
```

### 最小設定

`catclaw.json` 最少只需填：

```jsonc
{
  "discord": {
    "token": "your_discord_bot_token_here",
    "guilds": {}  // 空物件 = 全部頻道允許，需 @mention 觸發
  }
}
```

### 驗證上線

```bash
node catclaw.js status   # PM2 狀態
node catclaw.js logs     # 即時 log
```

Bot 上線後 log 顯示 `[bridge] 已上線：BotName#0000`。
在 Discord 頻道發送 `@BotName ping` 確認回應。

---

## 2. 架構總覽

### 資料流圖

```
Discord Gateway
      |  messageCreate
      v
[discord.ts] 訊息過濾 + debounce(500ms) + 附件下載
      |
      +-- Skill 攔截？ --> 是 --> skill.execute() --> 回覆 --> 結束
      |
      v  否
[message-pipeline.ts] 統一訊息管線
      |  Memory Recall --> Intent Detection --> System Prompt 組裝
      v
[agent-loop.ts] 核心 Agent Loop
      |  LLM 呼叫 --> tool_use --> 執行 tool --> 結果回填 --> 迴圈至 end_turn
      |  Output Token Recovery（截斷自動續接 x3）
      |  Auto-compact（Context Engineering 壓縮）
      v
[reply-handler.ts] Streaming 回覆
      |  live-edit 模式 / chunk fallback / fileMode 上傳
      v
Discord 訊息
```

### 核心子系統

| 子系統 | 說明 |
|--------|------|
| **Agent Loop** | 一軌制：CatClaw 控制所有 tool，LLM 只負責思考 |
| **Provider** | Claude API / Ollama / OpenAI-compat / ACP CLI，failover + circuit-breaker |
| **Memory** | 三層記憶引擎（Global / Project / Personal）+ LanceDB 向量搜尋 |
| **Context Engine** | 4 策略壓縮：compaction / budget-guard / sliding-window / overflow-hard-stop |
| **Session** | Per-channel 串行佇列 + 磁碟持久化 + TTL |
| **Accounts** | 5 級角色（guest → platform-owner）+ Tool Tier 物理移除 |
| **Tools** | 17+ builtin tools + MCP tool 自動整合 |
| **Skills** | 25 builtin skills（22 TS + 3 prompt） |
| **Dashboard** | Web 監控面板 + REST API + Web Chat |
| **Cron** | 排程服務（cron/every/at）+ 4 種動作型別 |
| **Hooks** | Shell command 在 tool 執行前後觸發 |
| **Safety** | 安全攔截 + 協作衝突偵測 |

### 目錄結構

```
catclaw/                          <- 程式碼
├── src/
│   ├── core/                     核心模組（agent-loop, session, dashboard...）
│   ├── providers/                LLM Provider 抽象層
│   ├── tools/                    17+ builtin tools
│   ├── skills/                   25 builtin skills
│   ├── memory/                   三層記憶引擎
│   ├── accounts/                 帳號/角色/權限
│   ├── hooks/                    Hook 系統
│   ├── mcp/                      MCP 整合
│   ├── vector/                   向量搜尋（LanceDB）
│   ├── workflow/                 工作流自動化
│   └── safety/                   安全守衛
├── catclaw.js                    跨平台管理腳本
└── ecosystem.config.cjs          PM2 設定

~/.catclaw/                       <- 執行期資料
├── catclaw.json                  設定檔
└── workspace/
    ├── CATCLAW.md                bot 行為規則（system prompt）
    └── data/
        ├── sessions/             per-channel session 持久化
        ├── cron-jobs.json        排程定義 + 狀態
        └── active-turns/         crash recovery
```

---

## 3. 設定指南

設定檔位於 `$CATCLAW_CONFIG_DIR/catclaw.json`（預設 `~/.catclaw/catclaw.json`）。
格式為 JSONC（支援 `//` 註解，但不支援 trailing comma）。

### 主要設定區塊

| 區塊 | 用途 |
|------|------|
| `discord` | Bot token + per-guild/channel 權限控制 |
| `session` | TTL、最大 turn 數、壓縮閾值、持久化路徑 |
| `memory` | 記憶開關、context budget、vector search、自動萃取 |
| `safety` | 自我保護、協作衝突偵測、可逆性門檻 |
| `workflow` | Guardian、fix-escalation、wisdom engine |
| `accounts` | 註冊模式、預設角色、配對 |
| `dashboard` | Web Dashboard 開關、port、token |
| `agents` | 多 Agent 入口設定 |
| `modes` | 模式定義（normal / precise / custom） |
| `mcpServers` | MCP Server 定義 |
| `hooks` | Hook 定義陣列 |
| `ollama` | Ollama 雙 Backend |
| `rateLimit` | Per-role 速率限制 |
| `contextEngineering` | CE 開關 + 策略設定 |
| `cron` | 排程開關 + 並行上限 |

### 重要全域欄位

| 欄位 | 預設 | 說明 |
|------|------|------|
| `turnTimeoutMs` | 300000 | 回應超時（5 分鐘） |
| `showToolCalls` | `"all"` | 工具呼叫顯示：all / summary / none |
| `streamingReply` | `true` | 串流 live-edit 回覆模式 |
| `fileUploadThreshold` | 4000 | 超過此字數上傳為 .md |
| `debounceMs` | 500 | 訊息合併等待毫秒 |
| `logLevel` | `"info"` | Log 層級 |

### Hot-Reload

`catclaw.json` 和 `cron-jobs.json` 編輯存檔後自動生效，無需重啟。
唯一例外：`discord.token` 需重啟才能生效（Gateway 連線在啟動時建立）。

> 完整欄位說明：[02-CONFIG-REFERENCE.md](02-CONFIG-REFERENCE.md)

---

## 4. 功能指南

### 4.1 Agent Loop（對話迴圈）

核心推理迴圈，採一軌制：CatClaw 控制所有 tool，LLM 只負責思考。

**流程**：Session 載入 → Context 壓縮 → Memory Recall → System Prompt 組裝 → LLM 呼叫迴圈 → 後處理

**關鍵常數**：
- `MAX_LOOPS = 20`：單次 turn 最大 tool 迴圈數
- `MAX_CONTINUATIONS = 3`：Output Token Recovery 自動續接次數
- Turn timeout：基礎 5 分鐘，tool_call 延長至 8 分鐘

**事件型別**（AsyncGenerator）：`text_delta` / `thinking` / `tool_start` / `tool_blocked` / `done` / `error`

> 詳見：[modules/agent-loop.md](modules/agent-loop.md)

### 4.2 Tool 系統（17+ builtin tools）

自動掃描載入 + register/execute + hot-reload + MCP tool 整合。

**Tool Tier 權限**：每個 tool 有 tier（public / standard / elevated / admin / owner），
PermissionGate 依角色物理移除不可用的 tool（LLM 完全看不到）。

**Deferred Tools**：`deferred: true` 的 tool 只注入名稱到 system prompt，
LLM 需先呼叫 `tool_search` 載入完整 schema 才能使用（節省 context）。

> 詳見：[modules/tool-registry.md](modules/tool-registry.md)

### 4.3 Skill 系統（25 builtin skills）

Skill = Discord 指令層，在 agent loop 之前攔截。22 個 TypeScript 執行型 + 3 個 prompt 型。

**觸發**：前綴匹配（如 `/think`、`/mode`、`/use`、`/stop`、`/plan`、`/status`）

**Skill Tier**：與 Tool 相同的 5 級權限控制。

**Prompt Skill**：以 `SKILL.md` 格式定義，將 prompt 注入對話而非直接執行程式碼。

> 詳見：[modules/skills.md](modules/skills.md)

### 4.4 記憶引擎（recall + extract + consolidate）

三層記憶：Global + Project + Personal，以 atom（markdown 檔案）為單位。

**Recall**（5 步管線）：cache check → embed query → LanceDB vector search → merge/dedup/sort → touchAtom + cache + budget 截斷 → 注入 prompt

**Extract**：每輪對話後自動萃取知識（KnowledgeItem），經 write-gate dedup 後寫入 atom。

**Consolidate**：promotion / archive / decay — atom 的生命週期管理。

**目錄結構**：
```
{memoryRoot}/
  ├── *.md               全域 atom
  ├── MEMORY.md          索引
  ├── projects/{id}/     專案層
  ├── accounts/{id}/     個人層
  └── _vectordb/         LanceDB 向量資料庫
```

**Blind-Spot 警告**：所有層均無命中時，recall 回傳 `blindSpot: true`，提醒 LLM 可能缺乏背景知識。

> 詳見：[modules/memory-engine.md](modules/memory-engine.md)

### 4.5 Context Engineering（壓縮策略）

Strategy Pattern 架構，4 策略依序執行：

| 策略 | 觸發條件 | 行為 |
|------|---------|------|
| `compaction` | tokens > 4000 | LLM 摘要壓縮舊訊息 |
| `budget-guard` | tokens > window x 0.8 | 從最舊 message 刪除 |
| `sliding-window` | messages > maxTurns x 2 | 保留最近 N 輪 |
| `overflow-hard-stop` | tokens > window x 0.95 | 緊急截斷至 4 條 |

> 詳見：[modules/context-engine.md](modules/context-engine.md)

### 4.6 Provider 系統（多 LLM 支援 + failover）

支援 Provider：
- **Claude API** — Anthropic Messages API（主力，OAuth + API Key 自動偵測）
- **Ollama** — 本地 LLM（OpenAI-compat API）
- **OpenAI-compat** — 第三方 OpenAI 相容 API
- **Codex OAuth** — pi-ai OAuth 流程
- **ACP CLI** — 透過 AI Agent CLI spawn 推理

**Failover**：FailoverProvider + CircuitBreaker，primary 失敗自動切換 fallback。

**AuthProfileStore**：多憑證管理 + cooldown，避免單一 key 被 rate limit。

**model 設定**：`models-config.json` 為唯一真相來源（primary / fallbacks / aliases / routing）。

> 詳見：[modules/providers.md](modules/providers.md)

### 4.7 Subagent 編排

`spawn_subagent` tool 讓主 agent 啟動子 agent 執行獨立任務。

**模式**：
- `run`：一次性任務，完成後回傳結果
- `session`：持久 thread，綁定 Discord Thread 長期對話

**特性**：
- Async 模式：子 agent 背景執行，完成後通知 Discord 頻道
- Spawn 深度限制：`spawnDepth >= 2` 時禁止再 spawn（防遞迴）
- Runtime 類型：`default` / `coding` / `acp` / `explore` / `plan` / `build` / `review`

> 詳見：[modules/subagent-system.md](modules/subagent-system.md)

### 4.8 帳號/權限系統

**5 級角色**：`guest` → `member` → `developer` → `admin` → `platform-owner`

每級角色對應不同的 Tool Tier 權限，低權限角色的 tool 被物理移除（LLM 看不到）。

**Identity Linking**：一個帳號可綁定多個平台身份（Discord、Web Chat 等）。

**註冊模式**：open / invite / closed，由 `accounts.registrationMode` 控制。

> 詳見：[modules/accounts.md](modules/accounts.md)、[modules/permission-gate.md](modules/permission-gate.md)

### 4.9 Web Dashboard

內建 Web 監控面板（單檔 HTML/CSS/JS），預設 port 8088。

**分頁**：概覽 / Sessions / Traces / Subagents / Tasks / Cron / Config / Logs

**Web Chat**：跨平台 session 共用，可從瀏覽器直接與 bot 對話。

**認證**：Bearer token（`config.dashboard.token`），未設定則無認證。

啟用：`catclaw.json` 設定 `dashboard.enabled: true`。

> 詳見：[modules/dashboard.md](modules/dashboard.md)

### 4.10 Cron 排程

定時排程執行任務，三種排程模式：

| Kind | 說明 | 範例 |
|------|------|------|
| `cron` | 標準 cron 表達式 | `"0 9 * * *"`（每天 9 點） |
| `every` | 固定間隔（ms） | `3600000`（每小時） |
| `at` | 一次性 ISO 時間 | `"2026-04-01T09:00:00+08:00"` |

**動作型別**：`message`（純文字）/ `claude-acp`（CLI spawn）/ `exec`（shell）/ `subagent`（agentLoop）

Job 定義存在 `data/cron-jobs.json`，支援 hot-reload。
失敗時指數退避重試（30s / 1min / 5min）。

> 詳見：[modules/cron.md](modules/cron.md)

### 4.11 MCP 整合

連接外部 MCP server（stdio JSON-RPC 2.0），自動取得 tool 清單並註冊到 ToolRegistry。

**設定**：
```jsonc
"mcpServers": {
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"],
    "env": { "API_KEY": "..." },
    "tier": "elevated"
  }
}
```

MCP tool 註冊名稱格式：`mcp_{serverName}_{toolName}`。預設 deferred（需 tool_search 載入 schema）。

> 詳見：[modules/mcp-client.md](modules/mcp-client.md)

### 4.12 Hook 系統

Hook = 外部 shell command，在 agent-loop 關鍵時機點執行。

**4 個事件點**：

| 事件 | 時機 | 可做什麼 |
|------|------|---------|
| `PreToolUse` | Tool 執行前 | allow / block / modify params |
| `PostToolUse` | Tool 執行後 | modify result / 觸發副作用 |
| `SessionStart` | Session 建立 | 初始化 |
| `SessionEnd` | Session 結束 | 清理 |

**設定範例**：
```jsonc
"hooks": [
  {
    "name": "block-rm-rf",
    "event": "PreToolUse",
    "command": "node /path/to/check.js",
    "toolFilter": ["run_command"],
    "timeoutMs": 5000
  }
]
```

> 詳見：[modules/hooks.md](modules/hooks.md)

---

## 5. 部署與維運

### PM2 管理

```bash
node catclaw.js start     # tsc 編譯 + PM2 啟動（首次）
node catclaw.js restart   # tsc 編譯 + signal file + PM2 重啟
node catclaw.js stop      # 停止
node catclaw.js status    # PM2 狀態
node catclaw.js logs      # 即時 log
```

### Signal File 重啟機制

`signal/RESTART` 檔案攜帶 `{channelId, time}`，PM2 偵測 `signal/` 目錄變更觸發重啟。
重啟完成後自動向觸發頻道發送通知，然後刪除 signal file。

### Hot-Reload

- `catclaw.json`：所有欄位即時生效（`discord.token` 除外）
- `cron-jobs.json`：新增/修改/刪除 job 即時生效
- 監聽機制：`fs.watch` + 500ms debounce

### 健康檢查

1. `node catclaw.js status` — PM2 狀態（status = online）
2. `node catclaw.js logs` — 即時 log 確認
3. Discord 測試 — `@BotName ping`
4. Debug 模式 — `catclaw.json` 設定 `logLevel: "debug"`（hot-reload 生效）
5. ACP trace — 停 PM2 後 `ACP_TRACE=1 node dist/index.js` 前景執行

> 完整部署指南：[04-DEPLOY.md](04-DEPLOY.md)

---

## 6. 常見陷阱

以下為最常遇到的 5 個問題，完整 21 項陷阱速查見 [09-PITFALLS.md](09-PITFALLS.md)。

### 1. Bot 上線但不回應訊息

- 確認 `guilds` 中對應 guildId 的 `allow: true`
- 確認是頻道 ID 而非伺服器 ID（右鍵頻道 → 複製頻道 ID）
- 確認有 @mention bot（若 `requireMention: true`）
- `logLevel: "debug"` 查看過濾原因

### 2. Discord 訊息 2000 字上限

長回覆會被 Discord API reject。CatClaw 內建處理：
streaming 模式自動拆段（1900 字切割），超過 `fileUploadThreshold` 上傳為 .md。

### 3. catclaw.json trailing comma 導致 hot-reload 失敗

JSONC 只支援 `//` 註解，不支援 trailing comma。
strip 註解後仍需合法 JSON，否則 hot-reload 持續失敗。

### 4. Session TTL 過期後行為異常

`session.ttlHours` 預設 168h（7 天），超過後自動開新 session。
如果 bot 突然「忘記」之前的對話，檢查 session 是否過期。

### 5. cron job 沒有執行

- `catclaw.json` 的 `cron.enabled` 需為 `true`
- job 的 `enabled` 未設為 `false`
- `schedule` 格式正確（cron 表達式用 [crontab.guru](https://crontab.guru) 驗證）

---

## 7. 模組索引

| 模組文件 | 原始碼 | 主題 |
|---------|--------|------|
| [agent-loop.md](modules/agent-loop.md) | `src/core/agent-loop.ts` | 核心對話迴圈 |
| [platform.md](modules/platform.md) | `src/core/platform.ts` | 子系統初始化工廠 |
| [message-pipeline.md](modules/message-pipeline.md) | `src/core/message-pipeline.ts` | 統一訊息管線 |
| [prompt-assembler.md](modules/prompt-assembler.md) | `src/core/prompt-assembler.ts` | System prompt 組裝 |
| [context-engine.md](modules/context-engine.md) | `src/core/context-engine.ts` | Context 壓縮策略 |
| [session.md](modules/session.md) | `src/core/session.ts` | SessionManager |
| [dashboard.md](modules/dashboard.md) | `src/core/dashboard.ts` | Web Dashboard + REST API |
| [reply.md](modules/reply.md) | `src/core/reply-handler.ts` | Streaming 回覆 |
| [message-trace.md](modules/message-trace.md) | `src/core/message-trace.ts` | 7 階段訊息追蹤 |
| [event-bus.md](modules/event-bus.md) | `src/core/event-bus.ts` | 事件匯流排 |
| [mode.md](modules/mode.md) | `src/core/mode.ts` | 模式管理 |
| [rate-limiter.md](modules/rate-limiter.md) | `src/core/rate-limiter.ts` | 速率限制 |
| [exec-approval.md](modules/exec-approval.md) | `src/core/exec-approval.ts` | 執行指令 DM 確認 |
| [session-snapshot.md](modules/session-snapshot.md) | `src/core/session-snapshot.ts` | Session 快照 |
| [task-store.md](modules/task-store.md) | `src/core/task-store.ts` | 任務 CRUD |
| [task-ui.md](modules/task-ui.md) | `src/core/task-ui.ts` | Discord 任務 UI |
| [tool-log-store.md](modules/tool-log-store.md) | `src/core/tool-log-store.ts` | Tool log 持久化 |
| [memory-engine.md](modules/memory-engine.md) | `src/memory/` | 三層記憶引擎 |
| [vector-service.md](modules/vector-service.md) | `src/vector/lancedb.ts` | LanceDB 向量服務 |
| [providers.md](modules/providers.md) | `src/providers/` | LLM Provider 系統 |
| [ollama-provider.md](modules/ollama-provider.md) | `src/providers/ollama.ts` | Ollama Provider |
| [tool-registry.md](modules/tool-registry.md) | `src/tools/` | Tool 註冊 + builtin tools |
| [skills.md](modules/skills.md) | `src/skills/` | Skill 系統 |
| [accounts.md](modules/accounts.md) | `src/accounts/` | 帳號 + 權限 |
| [permission-gate.md](modules/permission-gate.md) | `src/accounts/permission-gate.ts` | 權限閘門 |
| [agent-system.md](modules/agent-system.md) | `src/core/agent-loader.ts` | Multi-Agent 設定 |
| [subagent-system.md](modules/subagent-system.md) | `src/core/subagent-registry.ts` | Subagent 編排 |
| [hooks.md](modules/hooks.md) | `src/hooks/` | Hook 系統 |
| [safety.md](modules/safety.md) | `src/safety/` | 安全攔截 |
| [workflow.md](modules/workflow.md) | `src/workflow/` | 工作流引擎 |
| [mcp-client.md](modules/mcp-client.md) | `src/mcp/client.ts` | MCP 整合 |
| [discord.md](modules/discord.md) | `src/discord.ts` | Discord 入口 |
| [inbound-history.md](modules/inbound-history.md) | `src/discord/inbound-history.ts` | 未處理訊息記錄 |
| [cron.md](modules/cron.md) | `src/cron.ts` | 排程服務 |
| [config.md](modules/config.md) | `src/core/config.ts` | JSON 設定載入 |
| [logger.md](modules/logger.md) | `src/logger.ts` | Log 系統 |
| [pm2.md](modules/pm2.md) | `catclaw.js` | PM2 進程管理 |
| [index.md](modules/index.md) | `src/index.ts` | 進入點 |
