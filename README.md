# CatClaw

Codex 版 Claude Code CLI + 多人 AI 開發平台。
以 Discord 為前端，提供等同 Claude Code 的完整開發能力：multi-turn agent loop、17+ builtin tools、25 builtin skills、多 provider failover、三層記憶引擎、Context Engineering、subagent 編排、帳號/角色/權限系統、Web Dashboard + Trace 追蹤。

## 功能

### 核心引擎

- **Agent Loop** — Multi-turn 推理迴圈，tool 執行、output token recovery、auto-compact
- **17+ Builtin Tools** — read/write/edit/glob/grep/run/web/memory/subagent/task...
- **25 Builtin Skills** — 22 TS + 3 prompt（status/help/configure/mode/plan/restart/...）
- **Multi-Provider Failover** — claude-api / codex-oauth / cli-claude / cli-gemini / cli-codex / ollama / openai-compat + circuit-breaker
- **MCP Support** — MCP client 連線 + tool 自動註冊、Discord MCP server

### 記憶與 Context

- **三層記憶引擎** — recall（向量+關鍵字）+ extract（自動萃取）+ consolidate（晉升/衰減）
- **Context Engine** — compaction / budget-guard / sliding-window / overflow-hard-stop
- **Prompt Assembler** — 模組化 system prompt 組裝 + context-aware intent detection

### 平台能力

- **帳號/角色/權限系統** — 註冊、identity linking、per-channel 權限閘門
- **Subagent 編排** — 子任務分派 + 追蹤 + Discord bridge
- **Web Dashboard + Trace** — REST API、trace 視覺化、Web Chat（跨平台 session 共用）
- **Cron 排程** — cron/every/at 三種排程 + message/claude-acp/exec/subagent 四種 action

### Discord 整合

- 串流即時回覆（streaming edit mode）
- Per-channel 設定（allow / requireMention / allowBot / allowFrom / autoThread）
- Thread 繼承鏈（thread → parent channel → guild 預設）
- Session 持久化（per-channel 串行佇列 + 磁碟持久化 + TTL）
- Debounce（短時間多則訊息自動合併）
- 附件下載 + MEDIA token 檔案上傳 + 長回覆自動轉 .md
- Thinking 顯示、showToolCalls 三級控制
- Crash recovery + Signal-based restart + Config hot-reload
- Slash commands 管理介面

## 架構

```mermaid
graph TB
    subgraph Discord
        User([使用者])
        DGW[Discord Gateway]
    end

    subgraph "catclaw 核心"
        DSC[discord.ts<br/>訊息過濾 + Debounce]
        MPL[message-pipeline.ts<br/>Memory Recall / Intent /<br/>Assembler / Trace]
        AGL[agent-loop.ts<br/>Multi-turn 推理迴圈]
        PRV[providers/<br/>LLM 抽象層 + Failover]
        RPL[reply-handler.ts<br/>Streaming 分段回覆]
    end

    subgraph "核心子系統"
        PLT[platform.ts<br/>子系統初始化工廠]
        SES[session.ts<br/>Session 管理 + 佇列]
        MEM[memory/<br/>三層記憶引擎]
        CTX[context-engine.ts<br/>Context 壓縮策略]
        TRG[tools/ + skills/<br/>Tool & Skill Registry]
        EVT[event-bus.ts<br/>強型別事件匯流排]
        ACC[accounts/<br/>帳號 + 角色 + 權限]
        DSH[dashboard.ts<br/>Web Dashboard + Trace]
    end

    User -->|訊息| DGW
    DGW -->|messageCreate| DSC
    DSC -->|身份解析 + 權限閘門| MPL
    MPL -->|組裝 prompt| AGL
    AGL -->|tool 迴圈| TRG
    AGL -->|LLM 請求| PRV
    PRV -->|streaming| RPL
    RPL -->|reply / edit| DGW
    DGW -->|回覆| User

    PLT -.->|初始化| SES
    PLT -.->|初始化| MEM
    PLT -.->|初始化| TRG
    PLT -.->|初始化| ACC
    MPL -.->|recall| MEM
    MPL -.->|context| CTX
    AGL -.->|事件| EVT
    DSH -.->|trace| EVT
```

## 目錄結構

程式碼與資料完全分離：

```
~/project/catclaw/          <-- 純程式碼（Git repo）
  src/
    core/                   Agent Loop, Platform, Session, Dashboard, Context Engine,
                            Prompt Assembler, Reply Handler, Event Bus, Message Pipeline,
                            Message Trace, Mode, Rate Limiter, Task Store/UI, Subagent...
    memory/                 三層記憶引擎（engine, recall, context-builder, extract）
    providers/              LLM Provider 抽象（claude-api, ollama, openai-compat, cli-*...）
    tools/                  Tool Registry + 17 builtin tools
    skills/                 Skill Registry + 25 builtin skills
    hooks/                  Hook 系統（tool 前後觸發）
    safety/                 安全攔截（guard, collab-conflict, reversibility）
    workflow/               工作流引擎（rut, oscillation, fix-escalation, sync, wisdom）
    accounts/               帳號 + 角色 + 權限 + identity linking
    mcp/                    MCP client + Discord MCP server
    vector/                 Ollama embedding + LanceDB 向量搜尋
    discord/                Discord 附加模組（inbound-history）
    projects/               專案管理
    ollama/                 Ollama 後端工具
    migration/              資料遷移腳本
    discord.ts              Discord Client 入口
    cron.ts                 排程服務
    history.ts              訊息歷史（NDJSON append-only）
    slash.ts                Slash Commands
    index.ts                進入點
    config.ts               設定載入 + hot-reload
    logger.ts               Log 系統
  catclaw.js                CLI 進入點（start/restart/stop/logs/status/reset-session）
  ecosystem.config.cjs      PM2 設定
  dist/                     編譯輸出

~/.catclaw/                 <-- CATCLAW_CONFIG_DIR（使用者資料）
  catclaw.json              主設定檔（JSONC）
  models-config.json        模型設定唯一真相源
  workspace/                CATCLAW_WORKSPACE
    CATCLAW.md              Agent 行為規則（system prompt）
    data/
      sessions/             Session 持久化（per-channel 目錄）
      cron-jobs.json        Cron 定義 + 狀態
      active-turns/         Crash recovery 追蹤
    history/                對話歷史（NDJSON）
  memory/                   記憶根目錄
    _vectordb/              LanceDB 向量資料庫
```

## 前置需求

- Node.js >= 18
- [pnpm](https://pnpm.io/)
- Discord Bot Token（從 [Discord Developer Portal](https://discord.com/developers/applications) 取得）
- LLM Provider 至少一個：Anthropic API key / Claude Code OAuth / Ollama 等

## 安裝與設定

### 1. Clone 並建置

```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
pnpm install
pnpm build
```

### 2. 建立設定目錄

```bash
mkdir -p ~/.catclaw/workspace/data/{sessions,active-turns}
cp catclaw.example.json ~/.catclaw/catclaw.json
# models-config.json 手動建立（參考下方範例）或啟動後由 init 自動產生
```

### 3. 編輯設定檔

**`~/.catclaw/catclaw.json`**（JSONC 格式）— 主要設定：

```jsonc
{
  "discord": {
    "token": "你的 Discord Bot Token",
    "dm": { "enabled": true },
    "guilds": {
      "<伺服器 ID>": {
        "allow": true,
        "requireMention": true,
        "channels": {
          "<頻道 ID>": { "allow": true, "requireMention": false }
        }
      }
    }
  },
  "turnTimeoutMs": 300000,
  "sessionTtlHours": 168,
  "showToolCalls": "summary",
  "showThinking": false,
  "streamingReply": true,
  "debounceMs": 500,
  "logLevel": "info",
  "memory": { "enabled": true },
  "accounts": { "registrationMode": "invite" },
  "providerRouting": {
    "failoverChain": ["anthropic", "ollama"],
    "circuitBreaker": { "threshold": 3, "cooldownMs": 60000 }
  },
  "cron": { "enabled": false }
}
```

**`~/.catclaw/models-config.json`** — 模型設定：

```jsonc
{
  "mode": "merge",
  "primary": "sonnet",
  "fallbacks": ["haiku"],
  "aliases": {
    "sonnet": "anthropic/claude-sonnet-4-6",
    "opus": "anthropic/claude-opus-4-6",
    "haiku": "anthropic/claude-haiku-4-5-20251001"
  },
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "api": "ollama",
      "embeddingModel": "qwen3-embedding:8b"
    }
  }
}
```

> 完整設定欄位參考：[`_AIDocs/02-CONFIG-REFERENCE.md`](_AIDocs/02-CONFIG-REFERENCE.md)

### 4. 啟動

```bash
node catclaw.js start
```

## 環境變數

| 變數 | 預設 | 說明 |
| ---- | ---- | ---- |
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json 所在目錄 |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Agent 工作目錄 + data/ |
| `CATCLAW_CLAUDE_BIN` | `"claude"` | Claude CLI binary 路徑（legacy V1 用） |
| `ACP_TRACE` | — | `1` 啟用 ACP debug 串流輸出（legacy V1 用） |

## CLI 管理指令

```bash
node catclaw.js start        # tsc 編譯 + PM2 啟動
node catclaw.js restart      # tsc 重新編譯 + PM2 重啟
node catclaw.js stop         # PM2 停止
node catclaw.js logs         # PM2 即時 log
node catclaw.js status       # PM2 狀態
node catclaw.js reset-session             # 清除所有 session
node catclaw.js reset-session <channelId> # 清除指定 channel
```

## Claude CLI 介接（Legacy V1）

> V1 透過 spawn Claude Code CLI 子程序進行推理（`acp.ts`）。
> V2 改為 HTTP API 透過 Provider 抽象層直接呼叫 LLM，不再依賴 Claude CLI。

```bash
# V1 指令格式（僅供參考）
claude -p --output-format stream-json --verbose --include-partial-messages \
  --dangerously-skip-permissions [--resume <sessionId>] "<prompt>"
```

## Cron 排程

定義檔：`~/.catclaw/workspace/data/cron-jobs.json`（hot-reload）

```json
{
  "version": 1,
  "jobs": {
    "daily-standup": {
      "name": "每日站會提醒",
      "enabled": true,
      "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Taipei" },
      "action": { "type": "message", "channelId": "<頻道 ID>", "text": "站立會議時間！" }
    },
    "auto-task": {
      "name": "自動執行任務",
      "enabled": true,
      "schedule": { "kind": "every", "everyMs": 3600000 },
      "action": { "type": "subagent", "task": "摘要最近工作進度", "notify": "<頻道 ID>" }
    }
  }
}
```

| 排程 kind | 說明 |
| --------- | ---- |
| `cron` | 標準 5-field cron + 時區 |
| `every` | 固定間隔（ms） |
| `at` | 一次性（ISO 8601） |

| Action type | 說明 |
| ----------- | ---- |
| `message` | 發送純文字訊息 |
| `claude-acp` | 透過 ACP（V1 CLI spawn）執行 turn（legacy，建議改用 subagent） |
| `exec` | 執行 shell 指令 |
| `subagent` | 透過 V2 Agent Loop 執行任務 |

## License

MIT
