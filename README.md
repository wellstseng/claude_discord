# CatClaw

[English](README.en.md) | **繁體中文**

以 Discord 為介面的 AI Agent 運行平台 — multi-turn agent loop、25 builtin tools、35 builtin skills、36-event hook 系統、多 provider failover、四層記憶引擎、Web Dashboard。

## 功能總覽

| 類別 | 能力 |
|------|------|
| **Agent Loop** | Multi-turn 推理迴圈、tool 執行、output token recovery、auto-compact |
| **Tools** | 25 builtin tools — 檔案讀寫編輯、glob、grep、bash 執行、web 抓取/搜尋、記憶、subagent、任務管理、skill 執行、hook 管理、filewatch |
| **Skills** | 35 builtin skills（32 command-type + 3 prompt-type）— config、session、account、status、restart、plan、remind、hook 等 |
| **Hook 系統** | 36 events（10 類，Lifecycle/Turn/Memory/Subagent/Context/CLIBridge/FileCmd/FileWatcher/Error/Platform）+ folder-convention 掛載 + fs.watch 熱重載 + TS/JS/sh/ps1 多 runtime + defineHook SDK |
| **Multi-Provider** | claude-api / ollama / openai-compat / codex-oauth / acp-cli / cli-* + circuit-breaker failover |
| **記憶引擎** | 四層記憶（Global / Project / Account / Agent）— 向量 recall + 關鍵字搜尋 + 自動萃取 + 晉升/衰減 + **embedding 模型漂移偵測 + 自動 dim mismatch 重建** |
| **Context Engine** | Decay（漸進衰減+外部化）/ Compaction（LLM 結構化摘要）/ Overflow Hard Stop 三策略 + anti-hallucination stub 誠實化 + turn cap warning + **Tool LRU eviction**（治本 tool_search 活化的 cache 累計成本） |
| **帳號權限** | 註冊、identity linking、5 級角色（guest/member/developer/admin/platform-owner）、per-channel 權限閘門 |
| **Subagent** | 子任務分派 + **Discord thread / 分段 reply bridge** + 追蹤（>1980 字自動分頁帶 `_(i/total)_` 標記） |
| **Health Monitor** | Component-level fail-loud + 啟動健康總覽（紅綠燈）+ degraded/critical 連續失敗偵測 + Discord 通報 |
| **排程** | cron / every / at — message、subagent、exec、claude-acp、cli-bridge 動作 + `/cron` skill 動態管理 + agent 隔離 |
| **Discord** | 串流回覆、debounce、thread 繼承、附件處理、crash recovery、bot circuit breaker |
| **Dashboard** | Web UI（port 8088）— REST API、訊息追蹤視覺化、token 用量、session 管理 |

## 架構

```
Discord 訊息
    |
    v
discord.ts ─── 訊息過濾 + Debounce
    |
    v
message-pipeline.ts ─── 身份解析 → 權限閘門 → Memory Recall → Intent Detection → Prompt 組裝
    |
    v
agent-loop.ts ─── Multi-turn 推理迴圈（LLM <-> Tool 執行）
    |                         |
    v                         v
providers/ ───────── tools/ + skills/
LLM 抽象層            25 Tools + 34 Skills + 36 Hook Events
+ Failover
    |
    v
reply-handler.ts ─── Streaming 分段回覆 → Discord
```

**核心子系統**（由 `platform.ts` 初始化）：

| 子系統 | 說明 |
|--------|------|
| SessionManager | Per-channel 串行佇列 + 磁碟持久化 + TTL |
| MemoryEngine | 四層記憶：recall + extract + consolidate |
| ContextEngine | Context 壓縮策略 |
| AccountRegistry | 帳號 + 角色 + 權限 |
| ProviderRegistry | LLM Provider 抽象 + failover + circuit breaker |
| ToolRegistry | 自動載入 dist/ 下的 builtin tools |
| SafetyGuard | 指令攔截 + 協作衝突偵測 |
| Dashboard | Web UI + REST API + trace 視覺化 |
| WorkflowEngine | Rut/oscillation/fix-escalation/sync 偵測 |
| SubagentRegistry | Subagent 生命週期管理 |

## 快速開始

### 一鍵安裝

**macOS / Linux：**
```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
bash setup.sh
```

**Windows (PowerShell)：**
```powershell
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
powershell -ExecutionPolicy Bypass -File setup.ps1
```

安裝腳本自動完成：
1. 前置檢查（Node.js >= 18、pnpm、PM2）
2. 安裝依賴
3. 建立 `.env`（預設路徑）
4. 初始化目錄結構（`~/.catclaw/`）
5. Admin 帳號設定（輸入 Discord User ID，建立 platform-owner 帳號）
6. 互動設定 Discord Bot Token（寫入 `catclaw.json`）
7. 互動設定預設 Discord 頻道
8. 互動設定 Anthropic API Key（建立 `auth-profile.json`）
9. 功能開關（Dashboard / 排程）
10. 編譯 TypeScript + PM2 啟動

### 手動安裝

```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
pnpm install
cp .env.example .env        # Windows: copy .env.example .env
pnpm build
./catclaw init
```

編輯 `~/.catclaw/catclaw.json` 填入 Discord Bot Token，然後：

```bash
./catclaw start
```

## 前置需求

- **Node.js** >= 18
- **pnpm**（setup.sh 會自動安裝）
- **PM2**（setup.sh 會自動安裝）
- **Discord Bot Token** — 從 [Discord Developer Portal](https://discord.com/developers/applications) 取得
- **LLM Provider**（至少一個）：
  - Anthropic API Key（`sk-ant-...`）— 推薦
  - Ollama（本地）
  - OpenAI 相容端點

### Discord Bot 設定

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 建立 Application -> Bot -> Reset Token -> 複製
3. 開啟 **Privileged Gateway Intents**：
   - MESSAGE CONTENT INTENT（必要）
   - SERVER MEMBERS INTENT（可選）
4. OAuth2 -> URL Generator -> `bot` scope -> 權限：
   - Send Messages、Read Message History、Add Reactions
   - Manage Messages（可選，用於編輯串流回覆）
5. 使用產生的 URL 邀請 Bot 到你的伺服器

## 設定

### 目錄配置

```
~/.catclaw/                         設定根目錄（CATCLAW_CONFIG_DIR）
  catclaw.json                      主設定檔（JSONC 格式）
  workspace/                        Agent 工作目錄（CATCLAW_WORKSPACE）
    CATCLAW.md                      Bot 行為規則（system prompt）
    agents/
      default/
        auth-profile.json           LLM API 憑證
        models.json                 Provider/Model 定義
        CATCLAW.md                  Agent 專屬行為規則（可選）
      {agentId}/
        BOOTSTRAP.md                首次啟動儀式（可選）
        BOOT.md                     每次啟動執行（可選）
        config.json                 Agent 設定（provider/model/admin）
        memory/                     Agent 專屬 atom 記憶
        sessions/                   Agent 獨立 session
        _vectordb/                  Agent 專屬 LanceDB
        skills/                     Agent 自建 skill
    data/
      sessions/                     Session 持久化
      cron-jobs.json                排程定義
```

### catclaw.json

主設定檔，JSONC 格式（支援 `//` 註解）。重要欄位：

```jsonc
{
  "discord": {
    "token": "你的 Discord Bot Token",
    "dm": { "enabled": true },
    "guilds": {
      "<伺服器 ID>": {
        "allow": true,
        "requireMention": true
      }
    }
  },
  "admin": {
    "allowedUserIds": ["<你的 Discord User ID>"]
  },
  "agentDefaults": {
    "model": {
      "primary": "sonnet",
      "fallbacks": ["anthropic/claude-opus-4-6"]
    }
  }
}
```

完整設定參考 `catclaw.example.json`。

### auth-profile.json

LLM Provider 憑證，位於 `~/.catclaw/workspace/agents/default/auth-profile.json`：

```json
{
  "version": 2,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    }
  },
  "order": {
    "anthropic": ["anthropic:default"]
  }
}
```

### 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json 所在目錄 |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Agent 工作目錄 |

## CLI 指令

```bash
./catclaw start                    # 編譯 + PM2 啟動
./catclaw stop                     # 停止
./catclaw restart                  # 重新編譯 + 重啟
./catclaw build                    # 僅編譯（不啟動）
./catclaw logs                     # 即時 log
./catclaw status                   # 狀態
./catclaw reset-session            # 清除所有 session
./catclaw reset-session <channel>  # 清除指定 channel
```

> Windows 使用 `catclaw` 取代 `./catclaw`（自動找到 `catclaw.cmd`）

## Discord 使用方式

- 在允許的頻道 **@mention** Bot 開始對話
- 直接 **私訊** Bot（需 `dm.enabled: true`）
- 使用 `/` 前綴觸發 skill 指令（如 `/help`、`/status`、`/configure`）

### 常用 Skills

| Skill | 權限 | 說明 |
|-------|------|------|
| `/help` | public | 顯示可用指令 |
| `/status` | standard | 系統狀態 |
| `/session list` | standard | 列出 session |
| `/session clear` | standard | 清除目前 session |
| `/configure show` | admin | 顯示 provider/model 設定 |
| `/configure model <id>` | admin | 更換模型 |
| `/cron` | standard | 排程管理（add/list/delete/enable/disable） |
| `/hook` | standard | Hook 系統管理（list/events/remove） |
| `/restart` | admin | 重啟 Bot |
| `/add-bridge` | admin | 新增 CLI Bridge |
| `/clear-session` | admin | CLI Bridge 清空 sessionId + stdout.jsonl，turns 合併保留統計（TTL 60 天） |

## Dashboard

Web 監控面板，預設位於 `http://localhost:8088`。

功能：
- Session 列表與訊息歷史
- 訊息追蹤視覺化（7 階段管線）+ **Trace 批次選取 / 批次匯出 .zip / 批次刪除** + 單筆 Markdown 匯出（含 CE 前後 messages，可審計 compaction 摘要品質）
- Token 用量統計
- 記憶管理（embedding 模型漂移時警示 banner 提示重建索引）
- 🩺 **Component Health** 面板（紅綠燈總覽 + 連續失敗計數 + startup details）
- 線上 Config 編輯（含 FileWatcher 目錄監聽設定）
- CLI Bridge 狀態
- Web Chat（跨平台 session 共用）

## 專案結構

```
src/
  core/           Agent Loop、Platform、Session、Dashboard、Context Engine、
                  Prompt Assembler、Reply Handler、Event Bus、Message Pipeline
  memory/         四層記憶引擎（engine、recall、extract、consolidate）
  providers/      LLM Provider 抽象（claude-api、ollama、openai-compat、cli-*）
  tools/          Tool Registry + 25 builtin tools
  skills/         Skill Registry + 35 builtin skills（32 command-type + 3 prompt）
  hooks/          Hook 系統 — 36 events + folder-convention + fs.watch + defineHook SDK + FileWatcher
  safety/         安全攔截（guard、collab-conflict）
  workflow/       工作流引擎（rut、oscillation、fix-escalation、sync）
  accounts/       帳號 + 角色 + 權限 + identity linking
  mcp/            MCP client + Discord MCP server
  vector/         Embedding providers + LanceDB 向量搜尋
  cli-bridge/     CLI Bridge 持久 process 模組
  discord/        Discord 附加模組
catclaw           CLI wrapper（Unix）
catclaw.cmd       CLI wrapper（Windows）
catclaw.js        CLI 核心邏輯
ecosystem.config.cjs  PM2 設定
setup.sh          一鍵安裝（macOS/Linux）
setup.ps1         一鍵安裝（Windows PowerShell）
templates/
  CATCLAW.md      全域行為規則 template（初始化時複製到 workspace）
```

## 文件

- **[_AIDocs/WIKI.md](_AIDocs/WIKI.md)** — 完整系統手冊
- **[_AIDocs/02-CONFIG-REFERENCE.md](_AIDocs/02-CONFIG-REFERENCE.md)** — 完整設定參考
- **[_AIDocs/01-ARCHITECTURE.md](_AIDocs/01-ARCHITECTURE.md)** — 架構深入說明
- **[_AIDocs/_INDEX.md](_AIDocs/_INDEX.md)** — 知識庫索引

## License

MIT
