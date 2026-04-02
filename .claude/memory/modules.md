# modules

- Scope: project
- Confidence: [固]
- Trigger: 模組, config.ts, discord.ts, session.ts, acp.ts, reply.ts, logger, cron.ts, pm2, index.ts, 函式, 介面, BridgeConfig, getChannelAccess, enqueue, AcpEvent, providers, claude-api, auth-profile, skills, configure, message-trace, trace, 追蹤
- Last-used: 2026-04-02
- Confirmations: 9

# catclaw 模組詳細說明

## index.ts — 進入點

啟動順序：
1. `import config` → 載入 catclaw.json
2. `setLogLevel()` → log 層級
3. `loadSessions()` → 磁碟恢復 session
4. `createDiscordClient()` → 建立 Client（不傳 config）
5. `watchConfig()` → hot-reload
6. `client.login()` → Discord Gateway
7. `ready` → startCron() + 重啟通知 + crash recovery（scanAndCleanActiveTurns）

關閉：SIGINT/SIGTERM → stopCron() → client.destroy() → exit(0)

## config.ts — 設定載入 + Hot-Reload

位置：`$CATCLAW_CONFIG_DIR/catclaw.json`（JSONC，strip `//` 後 JSON.parse）

### BridgeConfig 頂層欄位

```typescript
interface BridgeConfig {
  discord: { token, dm, guilds: Record<string, GuildConfig> };
  turnTimeoutMs: number;          // 基礎超時（頂層）
  turnTimeoutToolCallMs: number;  // tool_call 延長超時（頂層）
  sessionTtlHours: number;        // session TTL（頂層）
  showToolCalls: "all" | "summary" | "none";
  showThinking: boolean;
  debounceMs: number;
  fileUploadThreshold: number;
  logLevel: LogLevel;
  cron: { enabled, maxConcurrentRuns };
}
```

### 對外 API

- `config` — `let` 全域可替換設定
- `getChannelAccess(guildId, channelId, parentId?)` → `{ allowed, requireMention, allowBot, allowFrom }`
- `resolveWorkspaceDir()` → CATCLAW_WORKSPACE
- `resolveClaudeBin()` → CATCLAW_CLAUDE_BIN（預設 "claude"）
- `watchConfig()` → fs.watch 500ms debounce

## discord.ts — 訊息處理

Client：`intents: [Guilds, GuildMessages, MessageContent, DirectMessages]`, `partials: [Partials.Channel]`

### 8 步過濾

1. Self-filter（client.user.id）
2. Dedup（processedMessages Set, max 1000）
3. getChannelAccess() → allowed
4. allowBot filter
5. allowFrom whitelist
6. requireMention strip（`/<@!?\d+>/g`）
7. 附件下載 → `/tmp/claude-discord-uploads/{msgId}/`
8. 空文字檢查

Debounce：key `channelId:authorId`，合併 debounceMs 內多則訊息。
Thread：`getParentId()` 偵測 parentId 用於繼承鏈。
Prompt：`<displayName>: <text>`

## session.ts — Session 快取 + 串行佇列

### 職責
1. channelId → sessionId 快取 + 磁碟持久化（atomic write .tmp → rename）
2. TTL 清理（sessionTtlHours）
3. 錯誤保留 session（下次繼續 --resume）
4. Per-channel Promise chain 串行
5. Turn timeout + AbortController（SIGTERM → 250ms → SIGKILL）

### Timeout 分層
- 基礎：turnTimeoutMs（5 分鐘）
- Tool call 偵測：延長至 turnTimeoutToolCallMs（~8 分鐘）
- 80% 警告：送 ⏳ 通知

### Crash Recovery
- active-turns/{channelId}.json 追蹤中的 turn
- 啟動時 scanAndCleanActiveTurns() 清理

### API
```typescript
enqueue(channelId, text, onEvent, opts: EnqueueOptions): void
loadSessions(): void
```

## acp.ts — Claude CLI 串流

### Spawn 指令
```bash
claude -p --output-format stream-json --verbose --include-partial-messages \
  --dangerously-skip-permissions [--resume <id>] "<prompt>"
```
stdio: `["ignore", "pipe", "pipe"]`

### AcpEvent 型別
- `text_delta` / `thinking_delta` / `tool_call`
- `done` / `error` / `status` / `session_init` / `timeout_warning`

### Diff 機制（4 計數器，每次新 message ID 重置）
| 變數 | 用途 |
|------|------|
| lastMessageId | 偵測新 turn |
| lastThinkingLength | diff thinking |
| lastTextLength | diff text |
| lastToolCount | diff tool_use 數量 |

Event Queue Pattern：callback stdout → AsyncGenerator via eventQueue + resolveNext

### 錯誤分類
overloaded / rate limit / 502 / 503 / timeout / auth 等 → 統一 error event

## reply.ts — 回覆分段 + Thinking + MEDIA

### 對外 API
```typescript
createReplyHandler(originalMessage, bridgeConfig): (event: AcpEvent) => Promise<void>
```

### 定時 Flush
收到 delta → 排程 3s timer。buffer ≥ 2000 → 立即 flush。

### Thinking 顯示
showThinking=true → `> 💭 **Thinking**\n> ...`（引用格式）。送出時不停 typing。

### showToolCalls 三級
| 模式 | 行為 |
|------|------|
| all | 每個 tool_call → `🔧 使用工具：xxx` |
| summary | 第一次 → `⏳ 處理中...` |
| none | 不顯示 |

向下相容：`true` → all，`false` → none

### Code Fence 跨段平衡
追蹤 `prevChunkHadOpenFence`，開頭補開、結尾補關。
safeLimit: 1992（2000 - 8 fence reserve）

### File Upload Mode
totalText > fileUploadThreshold → 累積 → done 時上傳 response.md（150 字 preview）。
MEDIA token → rebuild buffer → flush → upload attachments。

## logger.ts — Log Level

debug(0) / info(1) / warn(2) / error(3) / silent(4)

每行 log 自動加 `[HH:mm:ss.SSS]` 毫秒精度前綴。
環境變數 `ACP_TRACE=1` 啟用 acp.ts 原始 stdout/stderr 輸出（獨立於 logLevel）。

## cron.ts — 排程服務

- 定義 + 狀態：`data/cron-jobs.json`（hot-reload, selfWriting flag 防迴圈）
- 排程類型：cron / every / at
- Action：message（送訊息）/ claude（獨立 Claude turn）/ exec（shell 指令，`sh -c`，可選 channelId/silent/timeoutSec）
- Worker pool：maxConcurrentRuns 限制
- Retry backoff：30s → 1min → 5min
- Timer 範圍：MIN_TIMER_MS 2s / MAX_TIMER_MS 60s

## pm2 — 程序管理

ecosystem.config.cjs：
- `watch: ["signal"]`（只監聽 signal/ 目錄）、`autorestart: true`、`merge_logs: true`
- 開頭手動解析 `.env`（無 dotenv 依賴），支援 `~` 展開
- `CATCLAW_CONFIG_DIR` / `CATCLAW_WORKSPACE` 從 `.env` 取得，fallback `~/.catclaw`

catclaw.js CLI：start(-f) / restart / stop / logs(-c) / status / reset-session
- `logs -c`：先 `pm2 flush catclaw` 清除 log 再顯示
- `start -f`：強制 delete + re-register（重構後或跨環境用）
reset-session：讀 CATCLAW_WORKSPACE 定位 sessions.json，不需重啟

---

## 新平台子系統模組（S1-S14，platform-rebuild branch）

### core/platform.ts — 子系統整合初始化
- `initPlatform(config, catclawDir, distDir)` — 10 步初始化新子系統
- `isPlatformReady()` — 是否啟用新路徑（config.providers 非空）
- `getAccountRegistry()` / `getPlatformPermissionGate()` / `getPlatformToolRegistry()`
- `getPlatformSafetyGuard()` / `getPlatformSessionManager()` / `getPlatformProjectManager()`
- `getPlatformMemoryEngine()` → null if not init | `getPlatformRateLimiter()` → null if not init
- `resolveDiscordIdentity(discordUserId, adminIds)` → `{ accountId, isGuest }`
- `ensureGuestAccount(accountId)` — lazy 建立 guest 帳號

### core/agent-loop.ts — HTTP API Agent Loop
- `agentLoop(prompt, opts, services)` — AsyncGenerator，HTTP API 多輪對話
- opts: `{ channelId, accountId, provider, systemPrompt, speakerRole, turnTimeoutMs }`
- services: `{ sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus }`

### core/rate-limiter.ts — 滑動視窗速率限制
- `RateLimiter(limits: RateLimitConfig)` — per-account 60s 滑動視窗
- `check(accountId, role)` → `{ allowed, remaining, retryAfterMs }`
- `record(accountId)` — 計入一次請求
- `initRateLimiter / getRateLimiter / resetRateLimiter`

### core/agent-registry.ts — Multi-Bot Agent 設定
- `AgentRegistry(agents)` — list / has / resolve(agentId, base) 深合併
- `deepMerge(base, override)` — Array 替換、Object 遞迴、undefined 不覆寫
- `initAgentRegistry / getAgentRegistry / resetAgentRegistry`

### core/agent-loader.ts — --agent CLI 支援
- `parseAgentArg(argv?)` → agentId | undefined
- `loadAgentConfig(base, agentId)` → per-agent data 路徑隔離版設定
- `resolveAgentDataDir(agentId)` → ~/.catclaw/agents/{id}/

### accounts/registry.ts — 帳號 CRUD
- `AccountRegistry(catclawDir)` — JSON 持久化（accounts/）
- Roles: guest / member / developer / admin / platform-owner
- `create / get / update / exists / list / resolveIdentity(platform, platformId)`

### accounts/registration.ts — 帳號註冊
- `RegistrationManager` — createInvite / claimInvite / createPairingCode / approvePairing
- Rate limit: 3 次/10min per platformId；鎖定 3 次失敗 15min
- `initRegistrationManager / getRegistrationManager / resetRegistrationManager`

### accounts/identity-linker.ts — 跨平台身份綁定
- `linkDirect / requestLink / confirmLink`（6-char hex token, 10min TTL）

### projects/manager.ts — 專案 CRUD
- `ProjectManager(dataDir)` — CRUD + members + resolveMemoryDir
- `projectId` 規則：`/^[a-zA-Z0-9_-]{2,40}$/`
- `listForAccount(accountId)` — 篩選 member 或 public（members=[]）
- `initProjectManager / getProjectManager / resetProjectManager`

### migration/import-claude.ts — 遷移工具
- `importFromClaude({ sourcePath, destPath, force?, dryRun? })` → `{ copied, skipped, errors, mergedIndexEntries }`
- 跳過 _vectordb / episodic / _staging；合併 MEMORY.md 去重

### migration/rebuild-index.ts — 重建索引
- `rebuildIndex({ memoryDir, dryRun? })` → `{ indexPath, atomCount, content }`
- 掃描所有 .md，跳過 _ 前綴目錄，讀取 Trigger/Confidence

### skills/builtin/ — 新增 skill
| Skill | Tier | 說明 |
|-------|------|------|
| help | public | /help 按角色顯示可見 skill |
| account | admin | /account create/invite/approve/pairings/link |
| register | public | /register <code> <name> 邀請碼兌換 |
| project | standard | /project create/list/info/switch/add-member |
| migrate | admin | /migrate import/rebuild/status |
| stop | standard | /stop 中止進行中的 turn |
| turn-audit | admin | /turn-audit 檢視 turn 日誌 |
| subagents | standard | /subagents 子 agent 狀態 |
| restart | admin | /restart bot 重啟 |

### tools/builtin/ — 內建 Tool
| Tool | 說明 |
|------|------|
| read-file | 讀取檔案內容 |
| write-file | 寫入/修改檔案 |
| edit-file | 精確行號編輯 |
| glob | 檔案 pattern 搜尋 |
| grep | 正規表達式內容搜尋 |
| run-command | 執行 shell 指令 |
| llm-task | 內部輕量 LLM 任務 |
| memory-recall | 向量記憶搜尋 |
| spawn-subagent | 生成子 agent |
| subagents | 子 agent 管理 |

### core/agent-loop.ts — Tool Result 截斷
- 預設上限 8000 tokens（≈32000 chars）
- 超出：前 50 行 + 截斷通知 + 末 20 行
- `MAX_LOOPS = 20` 防無限迴圈

## providers/ — LLM Provider 系統

### ClaudeApiProvider（claude-api.ts）
- 使用 `@mariozechner/pi-ai` v0.58.0 `streamSimpleAnthropic`
- OAuth/API-key 自動偵測（pi-ai 內部處理 headers）
- 訊息格式轉換：catclaw Anthropic-native → pi-ai（UserMessage/AssistantMessage/ToolResultMessage）
- `buildToolNameMap()` 建立 tool_use_id → toolName 反查表供 ToolResultMessage 使用
- `getModel("anthropic", modelId as any)` + `Type.Unsafe(input_schema)` 建 pi-ai Tool

### AuthProfileStore（auth-profile-store.ts）— V2 重寫（2026-04-02）
- 檔案：`{CATCLAW_WORKSPACE}/agents/default/auth-profile.json`（單檔，credential + state 合一）
- ProfileId 格式：`"provider:name"`（如 `"anthropic:default"`）
- 三種 credential type：`api_key`（apiKey 欄位）、`token`（token 欄位）、`oauth`（access/refresh/expires）
- `pickForProvider(provider)` — round-robin rotation，跳過 cooldown 中的 profile
- Cooldown 策略：rate_limit=5h, overloaded=5min, billing=24h, auth=permanent
- V1→V2 自動遷移（舊 `[{id, credential}]` 陣列 → 新格式）
- 全域單例：`initAuthProfileStore(filePath)` / `getAuthProfileStore()`

### model-ref.ts（V2 新增，2026-04-02）
- `parseModelRef(raw, aliases)` — 解析 alias / "provider/model" → `ModelRef { provider, model }`
- `formatModelRef(ref)` — `ModelRef` → `"provider/model"` 字串
- Provider alias 內建對應：claude→anthropic, bedrock→amazon-bedrock 等

### models-config.ts（V2 新增，2026-04-02）
- `ensureModelsJson(wsDir, modelsConfig?)` — 產生/更新 models.json（atomic write）
- 內建 provider：anthropic（4 models）、openai（2 models）、openai-codex（1 model）
- `modelsConfig.mode = "merge"` 與內建合併，`"replace"` 只用自訂
- `findModelDefinition()` / `listAllModels()` 查詢介面

## skills/ — Skill 系統

### registry.ts
- `loadBuiltinSkills()` 掃描 `dist/skills/builtin/*.js`，auto-import `export const skill`
- `matchSkill(text)` 前綴匹配 trigger

### /configure skill（configure.ts，tier=admin）— V2 支援（2026-04-02）
- `/configure` — V2 顯示 agentDefaults primary/fallbacks + registry 列表；V1 顯示 providers 表
- `/configure model <id>` — V2 改 `agentDefaults.model.primary`；V1 改 `providers.{id}.model`
- `/configure provider <id>` — 切換預設 provider（V1 only）
- `/configure models` — V2 從 models.json 列出全部 provider/model；V1 從 pi-ai 列出 Anthropic
