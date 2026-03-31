# architecture

- Scope: project
- Confidence: [固]
- Trigger: 架構, 資料流, 目錄結構, session 策略, config, 環境變數, restart, cron, 安全, PM2, hot-reload, catclaw.json, CATCLAW_WORKSPACE, pi-ai, OAuth, provider, credentials
- Last-used: 2026-03-31
- Confirmations: 15

# catclaw 架構

**雙模式**：`config.providers` 有設定 → 新平台路徑（AgentLoop + HTTP API）；否則 → 舊 Claude CLI 路徑（向下相容）。

> **⚠️ 注意（2026-03-31 確認）**：catclaw-test（`~/.catclaw-test/catclaw.json`）已是完整平台模式，包含 providers + CE + inboundHistory + memory。`~/.catclaw/catclaw.json`（舊生產設定）無 providers，為舊 CLI 模式。兩份設定不同，診斷問題時必須確認使用的是哪一份。

## catclaw-test 完整設定（2026-03-31 確認）

```jsonc
// ~/.catclaw-test/catclaw.json 關鍵欄位
providers: { "claude-oauth": {...}, "codex": {...}, "ollama-local": {...} }
providerRouting.roles.default: "ollama-local"
agents.default.provider: "claude-oauth"
session: { persistPath: "~/.catclaw-test/workspace/data/sessions-v2", maxHistoryTurns: 50 }
contextEngineering: { enabled: true, compaction(haiku), budgetGuard(0.8), slidingWindow(off) }
inboundHistory: { enabled: true, fullWindowHours: 24, decayWindowHours: 168 }
memory: { globalPath: "~/.catclaw-test/memory/global", vectorDbPath: "~/.catclaw-test/memory/_vectordb" }
ollama: { embeddingModel: "qwen3-embedding:8b" }
```

**已知坑（2026-03-31）**：
- `platform.ts` defaultMemoryCfg 裡 `recall.vectorSearch: false`，catclaw.json 若只設 globalPath/vectorDbPath 不會覆寫 recall；需明確加 `"recall": { "vectorSearch": true, ... }` 到 catclaw.json 的 memory 段
- vectorDB 首次使用前需跑 `/migrate seed` 將既有 atoms embed 進 LanceDB（init() 不自動 seed）

## 新平台子系統（S1-S14，2026-03-26 完成，branch: platform-rebuild）

### 啟動順序（initPlatform 10 步）
1. AccountRegistry（~/.catclaw/accounts/）
2. ToolRegistry（dist/tools/builtin/ 掃描載入）
3. PermissionGate（role → tier access map）
4. SafetyGuard（bash 黑名單 + 路徑限制）
5. ProviderRegistry（Claude API / OpenAI-compat）
6. SessionManager（新版持久化，~/.catclaw/workspace/data/sessions-v2/）
7. RegistrationManager + IdentityLinker（帳號註冊 + 跨平台綁定）
8. ProjectManager（~/.catclaw/workspace/data/projects/）
9. MemoryEngine（三層 recall：global + project + account）
9.5 RateLimiter（per-account sliding window per role）
10. WorkflowEngine

**isPlatformReady()** 回傳 true 才走新路徑，否則 fallback 舊 CLI。

### Provider Routing 優先序
`channel config > role routing > project routing > default`

### 三層記憶
- Global：`~/.catclaw/memory/global/`（或 HomeClaudeCode 模式 → ~/.claude/memory/global）
- Project：`~/.catclaw/memory/projects/{id}/`（或 projectManager.resolveMemoryDir）
- Account：`~/.catclaw/memory/accounts/{accountId}/`

### Multi-Agent（--agent <id>）
`node dist/index.js --agent <id>` → deepMerge(base, agents.<id>) → per-agent data 路徑隔離（~/.catclaw/agents/{id}/）

### catclaw.json 新增欄位（platform-rebuild）
```jsonc
{
  // Claude OAuth（pi-ai 自動偵測 sk-ant-oat01- / sk-ant-api 處理 headers）
  // 不設 token/apiKey/profiles — 憑證放 agents/default/auth-profile.json
  "providers": { "claude-oauth": { "type": "claude-api", "model": "claude-sonnet-4-6" } },
  "provider": "claude-api",
  "providerRouting": { "channels": {}, "roles": { "default": "claude-api" }, "projects": {} },
  "accounts": { "registrationMode": "invite", "pairingEnabled": true },
  "rateLimit": { "guest": { "requestsPerMinute": 5 }, "member": { "requestsPerMinute": 30 } },
  "memory": { "enabled": true, "globalPath": "~/.catclaw/memory/global", "vectorDbPath": "~/.catclaw/memory/_vectordb" },
  "homeClaudeCode": { "enabled": false },
  "agents": { "support-bot": { "discord": { "token": "${SUPPORT_TOKEN}" } } }
}
```

## 目錄結構（程式碼與資料分離）

```
catclaw/                 ← 純程式碼（Git repo）
  src/, dist/, signal/
  catclaw.js, ecosystem.config.cjs

~/.catclaw/              ← CATCLAW_CONFIG_DIR（使用者資料）
  catclaw.json           ← 主設定檔（JSONC）
  workspace/             ← CATCLAW_WORKSPACE
    AGENTS.md
    data/
      sessions.json
      cron-jobs.json
      active-turns/      ← crash recovery 用
```

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json 位置 |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Claude CLI cwd + data/ |
| `CATCLAW_CLAUDE_BIN` | `"claude"` | claude binary 路徑 |
| `ACP_TRACE` | — | `1` 啟用 debug stream 輸出 |
| `CATCLAW_CHANNEL_ID` | — | acp.ts 自動注入，Claude 內可讀 |

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14 | Discord Gateway |
| `typescript` ^5 | 編譯 |
| `pm2` ^6（dev） | 程序管理 |
| `croner` ^10 | cron 解析 |
| `claude` (PATH) | Claude Code CLI |

套件管理：**pnpm**

## 資料流

```
Discord messageCreate
  → self filter → dedup → getChannelAccess() 權限
  → allowBot / allowFrom / requireMention
  → strip mention → 附件下載
  → debounce(channelId:authorId, 500ms) 合併
  → [session.ts] enqueue() per-channel 串行佇列
  → [acp.ts] runClaudeTurn() spawn claude -p stream-json
  → diff 累積文字 yield AcpEvent
  → [reply.ts] buffer → 3s flush / 2000字分段 / MEDIA 上傳
```

## 重要常數

| 名稱 | 值 | 說明 |
|------|-----|------|
| TEXT_LIMIT | 2000 | Discord 字數上限 |
| FLUSH_DELAY_MS | 3000 | text buffer flush 延遲 |
| debounceMs | 500 | 訊息合併延遲（config 可調） |
| typingInterval | 8000 | typing indicator 間隔 |
| turnTimeoutMs | 300000 | 基礎回應超時 5 分鐘（頂層 config） |
| turnTimeoutToolCallMs | turnTimeoutMs×1.6 | tool_call 延長超時 ~8 分鐘 |
| sessionTtlHours | 168 | Session 閒置 7 天 |
| fileUploadThreshold | 4000 | 超過轉 .md 上傳 |
| MAX_LOOPS | 20 | agentLoop 最大迴圈次數 |
| DEFAULT_RESULT_TOKEN_CAP | 8000 tokens | tool result 截斷上限（≈32000 chars） |
| SIGTERM delay | 250ms | abort 後等待時間再 SIGKILL |

## catclaw.json 結構（JSONC, hot-reload）

```jsonc
{
  "discord": {
    "token": "...",
    "dm": { "enabled": true },
    "guilds": { "<guildId>": { "allow": true, "requireMention": true, "allowBot": false, "allowFrom": [], "channels": {} } }
  },
  "turnTimeoutMs": 300000,
  "turnTimeoutToolCallMs": 480000,
  "sessionTtlHours": 168,
  "showToolCalls": "summary",
  "showThinking": false,
  "debounceMs": 500,
  "fileUploadThreshold": 4000,
  "logLevel": "info",
  "cron": { "enabled": false, "maxConcurrentRuns": 1 }
}
```

> `claude.cwd` / `claude.command` 已移除，改用環境變數。

### 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

## Session 策略

| 場景 | Key | 行為 |
|------|-----|------|
| Guild 頻道 | `channelId` | 同頻道共享 session |
| DM | `channelId`（per-user） | 各自獨立 |

- 首次：無 `--resume`，從 `session_init` event 取 UUID
- 後續：`--resume <UUID>` 延續
- TTL 超時：自動開新 session
- 錯誤：保留 session，下次繼續 `--resume`
- 持久化：`data/sessions.json`（atomic write）

## PM2 重啟機制

### Admin CLI（直接重啟）
`node catclaw.js restart` → tsc 編譯 → `triggerRestart()` 寫 signal → PM2 重啟程序
⚠️ 2026-03-25 修正：CLI restart 原本沒呼叫 `triggerRestart()`，導致 startup 不知道是有意重啟，錯誤觸發 crash recovery 提示。

### Discord 觸發（signal 檔機制）
寫 `signal/RESTART` JSON `{channelId, time}` → PM2 偵測 → 重啟 → ready event 讀 signal → 通知頻道 → 刪除 signal

### 有意重啟識別
startup 時讀 signal → `intentionalChannelIds.add(channelId)` → crash recovery 掃描跳過此 channel → 不跳「意外中斷」提示
CLI 路徑取 `CATCLAW_CHANNEL_ID` 環境變數（ACP spawn 時設定），確保 channelId 正確帶入。

### Dual-save（2026-03-22）
rmSync 舊檔 + writeFileSync 新檔 + 300ms setTimeout，確保 PM2 偵測到變更。

## Crash Recovery

- `data/active-turns/{channelId}.json` 追蹤進行中的 turn
- 啟動時 `scanAndCleanActiveTurns()` 清理殘留
- Turn 完成或超時後刪除追蹤檔

## Cron 排程

定義檔：`data/cron-jobs.json`（hot-reload）

| 排程類型 | 設定 |
|---------|------|
| cron | `"0 9 * * *"` 標準 cron |
| every | `everyMs: 3600000` 固定間隔 |
| at | ISO 8601 一次性 |

Action：`message`（送訊息）或 `claude`（開 Claude turn，獨立 session）

## 安全防護

全域 PreToolUse hook（`~/.claude/hooks/safety-guard.py`）：
- Bash 黑名單：系統破壞、程序管理、敏感操作
- Write/Edit 路徑限制
- Read 憑證防外洩
- Hook 自保護

## CLI 指令

```bash
node catclaw.js start                     # tsc + PM2 啟動
node catclaw.js restart                   # tsc + PM2 重啟
node catclaw.js stop                      # PM2 停止
node catclaw.js logs                      # PM2 即時 log
node catclaw.js logs -c                   # 清除 log 後再顯示（pm2 flush）
node catclaw.js status                    # PM2 狀態
node catclaw.js reset-session             # 清除所有 session
node catclaw.js reset-session <channelId> # 清除指定 channel
```

## ecosystem.config.cjs — PM2 設定（2026-03-28 更新）

- **`merge_logs: true`** — stdout/stderr 合併到同一 log 檔，時間序正確
- **.env 手動載入** — 開頭解析 `.env`（無 dotenv 依賴），`~ ` 展開為 homedir
- **環境變數優先序**：`.env` 中的值 → ecosystem 內建 fallback（`~/.catclaw`）
- `process.env` 讀取時機在 `.env` 載入後，`CATCLAW_CONFIG_DIR` 等設定才生效

## Skill 系統（Phase 0，2026-03-25 完成驗證）

### Command-type Skill

攔截層在 `discord.ts` 的 `debounce` 後、`enqueue()` 前：
```
matchSkill(text) → 有匹配 → 直接執行 skill → 回傳，不送 Claude
                 → 無匹配 → 正常 enqueue
```
- `skills/registry.ts`：trigger 匹配（exact / prefix-space / prefix-newline）
- `skills/builtin/*.ts`：每個一個 `.ts`，export `skill: Skill`，目錄掃描自動載入
- Claude **看不到** Command-type skill（攔截在前）

### Prompt-type Skill（OpenClaw SKILL.md 格式）

**OpenClaw lazy-load 模式**（token 優化）：
- 啟動時掃描 `skills/builtin-prompt/`，只讀取 frontmatter `description`
- 注入 system prompt：XML `<available_skills>` 清單（name + description + filePath）
- Claude 需要時自行用 Read tool 讀 SKILL.md 完整內容
- `buildSkillsPrompt()` → 無 skill 時回傳空字串，不注入

**Phase 0 限制：**
- SKILL.md 有注入無執行路徑（只知道但做不到）
- 等 S4 HTTP API + S5 Tool 系統後才接實際 tool_use

**tsc 不複製非 `.ts` 檔** → build script 加 `cp -r src/skills/builtin-prompt dist/skills/builtin-prompt`

## 關鍵設計決策

- 不用 Claude API SDK，直接 spawn CLI + `--resume`
- 串流 diff：CLI 回傳累積文字，lastTextLength/lastThinkingLength slice delta
- MEDIA token：仿 OpenClaw，解析 `MEDIA: /path` 觸發上傳
- config 不捕獲 closure：`createDiscordClient()` 無參數，handler 讀全域 config
- Promise chain 串行：同 channel `.then()` 鏈，不同 channel 完全並行
- 錯誤不傳播：每 turn `.catch()` 攔截轉 error event
- DM 禁 bot：硬擋 bot 間 DM 防互敲
