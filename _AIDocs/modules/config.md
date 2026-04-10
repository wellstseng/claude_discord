# modules/config — JSON 設定載入

> 檔案：`src/core/config.ts`（原 `src/config.ts` 已搬遷並大幅擴充）

## 職責

從 `catclaw.json` 載入設定，提供 per-channel 存取 helper + config hot-reload。
提供環境變數路徑解析（`resolveWorkspaceDir` / `resolveClaudeBin`）。
export 所有型別定義（包括 cron.ts 使用的 `CronSchedule` / `CronAction`）。
**V2 擴充**：新增 provider 三層分離（agentDefaults / modelsConfig / authConfig）、memory 記憶系統、workflow 工作流、accounts 帳號管理、contextEngineering、promptAssembler、inboundHistory、modes 模式切換、subagents、mcpServers、hooks 等平台區塊。
支援環境變數展開（`${ENV_VAR_NAME}` 格式）及 JSONC 字串感知註解剝除。
支援外部 `models-config.json` 載入與合成。

## 設定來源

- `catclaw.json`（位於 `$CATCLAW_CONFIG_DIR` 目錄，預設 `~/.catclaw/`）
- 範本：`config.example.json`（專案根目錄）
- 格式：JSONC（支援 `//` 整行 + 行尾註解，strip 後 JSON.parse）
- 路徑相關設定已從 config.json 移除，改由環境變數控制

## 型別定義

### `BridgeConfig`（完整欄位）

#### 既有欄位

| 欄位 | 型別 | 預設值 | 必填 | 說明 |
|------|------|--------|------|------|
| `discord.token` | `string` | — | ✓ | Discord Bot Token |
| `discord.dm.enabled` | `boolean` | `true` | — | 是否啟用 DM 回應 |
| `discord.guilds` | `Record<string, GuildConfig>` | `{}` | — | per-guild 設定，空物件=全部允許 |
| `admin.allowedUserIds` | `string[]` | `[]` | — | 管理員 User ID 白名單 |
| `turnTimeoutMs` | `number` | `300000` | — | 基礎回應超時毫秒（5 分鐘），頂層欄位 |
| `turnTimeoutToolCallMs` | `number` | `turnTimeoutMs×1.6` | — | tool_call 延長超時（預設 8 分鐘） |
| `showToolCalls` | `"all" \| "summary" \| "none"` | `"all"` | — | 工具呼叫顯示模式 |
| `showThinking` | `boolean` | `false` | — | 是否顯示 Claude 推理過程 |
| `debounceMs` | `number` | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | `number` | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `streamingReply` | `boolean` | `true` | — | 串流 live-edit 回覆模式（false=chunk） |
| `logLevel` | `LogLevel` | `"info"` | — | Log 層級 |
| `cron` | `CronConfig` | — | — | 排程設定（含 `defaultAccountId` / `defaultProvider`） |
| `history` | `HistoryConfig` | — | — | 歷史訊息功能開關 |

#### V2 三層分離（新結構）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `agentDefaults` | `AgentDefaultsConfig` | Agent 預設設定（model primary / fallbacks / aliases） |
| `modelsConfig` | `ModelsConfig` | 模型目錄（自訂 provider + merge/replace 模式） |
| `authConfig` | `AuthConfig` | 認證設定（profile + order + cooldowns） |

#### V1 相容欄位（過渡期保留）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `provider` | `string` | @deprecated 預設 provider ID |
| `providers` | `Record<string, ProviderEntry>` | @deprecated Provider 設定表 |
| `providerRouting` | `ProviderRoutingConfig` | Provider 路由規則（含 failoverChain / circuitBreaker） |
| `modelRouting` | `ModelRoutingConfig` | 統一模型路由（優先於 providerRouting） |

#### 平台擴充欄位

| 欄位 | 型別 | 說明 |
|------|------|------|
| `session` | `SessionConfig` | Session 持久化設定（ttlHours / maxHistoryTurns / compactAfterTurns / persistPath） |
| `memory` | `MemoryConfig` | 記憶系統（recall / extract / consolidate / episodic / sessionMemory 等子區塊） |
| `ollama` | `OllamaConfig` | Ollama 雙 Backend 設定 |
| `safety` | `SafetyConfig` | 安全設定（bash blacklist / filesystem / execApproval / toolPermissions / collabConflict / reversibility） |
| `workflow` | `WorkflowConfig` | 工作流設定（guardian / fixEscalation / wisdomEngine / aidocs） |
| `accounts` | `AccountsConfig` | 帳號管理（registrationMode / defaultRole / pairing） |
| `rateLimit` | `RateLimitConfig` | 速率限制（per-role requestsPerMinute） |
| `contextEngineering` | `ContextEngineeringConfig` | CE 策略（compaction / budgetGuard / slidingWindow） |
| `inboundHistory` | `InboundHistoryConfig` | Inbound History 注入（fullWindowHours / decayWindowHours / bucketBTokenCap） |
| `promptAssembler` | `PromptAssemblerConfig` | Prompt Assembler 設定（disabledModules） |
| `modes` | `ModeConfig` | 模式切換（normal / precision 預設，含 thinking / compaction / resultTokenCap / contextReserve） |
| `subagents` | `SubagentsConfig` | 子 Agent 設定（maxConcurrent / defaultTimeoutMs / defaultKeepSession） |
| `agents` | `AgentsConfig` | 多 Agent 單一 bot 入口設定 |
| `dashboard` | `{ enabled, port, token? }` | Token Usage Dashboard |
| `toolBudget` | `{ resultTokenCap?, perTurnTotalCap?, toolTimeoutMs?, maxWriteFileBytes? }` | Tool 呼叫 token Budget（含 File Size Guard） |
| `mcpServers` | `Record<string, McpServerEntry>` | 外部 MCP Server 設定 |
| `hooks` | `HookDefinition[]` | Hook 系統（agent-loop 關鍵時機點執行 shell command） |
| `botCircuitBreaker` | `BotCircuitBreakerConfig` | Bot-to-Bot 對話防呆（enabled / maxRounds / maxDurationMs） |

> **重構變更**：`claude.cwd` / `claude.command` 已移除，改由環境變數控制。`turnTimeoutMs` / `sessionTtlHours` 從 `claude.*` 提升至頂層。`sessionTtlHours` 已移至 `session.ttlHours`。

> `showToolCalls` 舊版支援 boolean：`true` → `"all"`，`false` → `"none"`。

> NOTE: 排程 job 定義不在 catclaw.json，在 `data/cron-jobs.json`（參考 `cron-jobs.example.json`）。

### `GuildConfig` / `ChannelConfig`

```typescript
interface ChannelConfig {
  allow?: boolean;           // 是否允許回應此頻道
  requireMention?: boolean;  // 是否需要 @mention bot 才觸發
  allowBot?: boolean;        // 是否允許處理 bot 訊息
  allowFrom?: string[];      // 白名單 user/bot ID（空陣列 = 不限制）
  boundProject?: string;     // 綁定專案（該頻道只用此專案）
  provider?: string;         // 頻道層級 provider 覆寫
  blockGroupMentions?: boolean; // 封鎖 @here / @everyone 群組廣播觸發
  interruptOnNewMessage?: boolean; // 新訊息自動中斷正在執行的 turn（插隊模式，預設 true）
  autoThread?: boolean;      // 自動為每條使用者訊息建立 Discord Thread（預設 false）
}

interface GuildConfig {
  allow?: boolean;           // Guild 預設：是否允許，預設 false
  requireMention?: boolean;  // Guild 預設：是否需要 @mention，預設 true
  allowBot?: boolean;        // Guild 預設：是否處理 bot，預設 false
  allowFrom?: string[];      // Guild 預設：白名單，預設 []
  channels?: Record<string, ChannelConfig>;  // per-channel 覆寫
  blockGroupMentions?: boolean; // 封鎖 @here / @everyone（預設 true）
}
```

### Cron 共用型別（供 `cron.ts` 使用）

```typescript
export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }   // cron 表達式（如 "0 9 * * *"）
  | { kind: "every"; everyMs: number }              // 固定間隔（毫秒）
  | { kind: "at"; at: string };                     // 一次性 ISO 8601 時間

export type CronAction =
  | { type: "message"; channelId: string; text: string }                     // 直接發訊息
  | { type: "claude-acp"; channelId: string; prompt: string; timeoutSec?: number }  // 透過 ACP 執行 turn
  | { type: "exec"; command: string; channelId?: string; silent?: boolean; timeoutSec?: number; shell?: string; background?: boolean }  // 執行 shell 指令
  | { type: "subagent"; task: string; provider?: string; timeoutMs?: number; notify?: string };  // 子 agent 任務

export interface CronConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  defaultAccountId?: string;   // Cron 預設執行帳號
  defaultProvider?: string;    // Cron 預設 provider
}
```

### `RawConfig`（內部型別，不對外 export）

config.json 原始 JSON 結構，所有欄位皆為 optional。`loadConfig()` 解析後填入預設值，轉為完整 `BridgeConfig`。

### `ChannelAccess`（`getChannelAccess` 回傳值）

```typescript
export interface ChannelAccess {
  allowed: boolean;              // 是否允許回應
  requireMention: boolean;       // 是否需要 @mention bot
  allowBot: boolean;             // 是否允許處理 bot 訊息
  allowFrom: string[];           // 白名單（空陣列 = 不限制）
  blockGroupMentions: boolean;   // 封鎖 @here / @everyone 群組廣播觸發
  provider?: string;             // 頻道層級 provider 覆寫
  boundProject?: string;         // 綁定專案
  interruptOnNewMessage: boolean;// 新訊息自動中斷正在執行的 turn
  autoThread: boolean;           // 自動為每條使用者訊息建立 Discord Thread
}
```

## Per-Channel 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

各欄位用 `??` 逐層 fallback，只有 `undefined` 才往下找（顯式設 `false` 不 fallback）。

### 存取規則四種情境

| 情境 | allowed | requireMention |
|------|---------|----------------|
| DM（guildId=null） | `dm.enabled` | 永遠 `false` |
| `guilds` 為空物件 `{}` | `true` | `true` |
| `guildId` 找不到 | `false` | `true` |
| 找到 guild → 繼承鏈查找 | 逐層 fallback | 逐層 fallback |

DM：永遠 `allowBot = false`（硬擋 bot 互敲）。

## 主要函式

### `resolveConfigPath(): string`（public export）

讀取 `CATCLAW_CONFIG_DIR` 環境變數，回傳 `catclaw.json` 完整路徑。未設定時 throw 錯誤（不猜預設值）。

### `resolveCatclawDir(): string`（public export）

解析 catclaw 根目錄（`CATCLAW_CONFIG_DIR`），無設定則報錯。

### `resolveWorkspaceDir(): string`（public export）

讀取 `CATCLAW_WORKSPACE` 環境變數，回傳 Claude CLI agent 工作目錄。未設定時 throw 錯誤。
用途：acp.ts spawn cwd、session.ts 磁碟持久化路徑。

### `resolveClaudeBin(): string`（public export）

讀取 `CATCLAW_CLAUDE_BIN` 環境變數，回傳 claude binary 路徑。未設定時回傳 `"claude"`（依賴 PATH）。

### `loadConfig(): BridgeConfig`（私有）

1. `resolveConfigPath()` 取得 catclaw.json 路徑
2. String-aware JSONC comment stripper（`stripJsoncComments()`，正確跳過字串中的 `//`，如 URL）
3. `JSON.parse` → `expandEnvVars()`（遞迴展開 `${ENV_VAR}` 格式字串）
4. 驗證 `discord.token` 必填（缺少時拋出錯誤）
5. 正規化 guilds：填入預設值
6. 驗證 logLevel（不合法 → 回退 `"info"`）
7. 載入外部 `models-config.json`（`loadModelsConfigFile()`），合成 agentDefaults / modelsConfig / modelRouting
8. 填入所有擴充區塊預設值（memory / session / accounts / safety / workflow 等）
9. 回傳完整 `BridgeConfig`

### `parseShowToolCalls(value): "all" | "summary" | "none"`（私有）

相容舊格式：`true → "all"`，`false → "none"`，字串直接 pass-through（不合法回退 `"all"`）。

### `reloadConfig(): void`（私有）

- 呼叫 `loadConfig()` 建立新設定
- token 變更時只 `log.warn`，不阻止替換（但 Gateway 連線需重啟才更新）
- 替換全域 `config`（`let` 宣告）
- 同步更新 `setLogLevel(config.logLevel)`
- 同步 hot-reload hooks：`getHookRegistry()?.reload(config.hooks ?? [])`
- parse 失敗 → 維持舊設定，`log.warn`

## Hot-Reload

```
watchConfig()
  → fs.watch(catclaw.json)
  → 500ms debounce
  → reloadConfig()
      ├─ token 變更 → log.warn（需重啟，不套用）
      └─ 其他設定 → config = newConfig + setLogLevel
```

parse 失敗 → `log.warn` 維持舊設定，不 crash。

## 對外 API

### `getChannelAccess(guildId, channelId, parentId?): ChannelAccess`

查詢指定頻道的存取設定（含繼承鏈）。

```typescript
export function getChannelAccess(
  guildId: string | null,   // DM 時為 null
  channelId: string,        // Channel 或 Thread ID
  parentId?: string | null  // Thread 的父頻道 ID（非 Thread 時 null）
): ChannelAccess
```

### `export let config: BridgeConfig`

全域可替換物件（`let` 而非 `const`），hot-reload 時整個替換。

### `watchConfig(): void`

啟動 config.json 監聯，變動時自動重載（500ms debounce）。

## 完整 Export 列表

```typescript
// ── 全域物件 + 控制函式 ──
export let config: BridgeConfig;
export function watchConfig(): void;
export function getChannelAccess(...): ChannelAccess;
export function resolveConfigPath(): string;       // 環境變數 CATCLAW_CONFIG_DIR
export function resolveCatclawDir(): string;       // 環境變數 CATCLAW_CONFIG_DIR（目錄）
export function resolveWorkspaceDir(): string;     // 環境變數 CATCLAW_WORKSPACE
export function resolveWorkspaceDirSafe(): string; // 同上（別名）
export function resolveClaudeBin(): string;        // 環境變數 CATCLAW_CLAUDE_BIN
export function loadBaseSystemPrompt(): string;    // 讀取 workspace/CATCLAW.md
export function resolveProvider(opts: { channelAccess?, channelId?, role?, projectId? }): string;

// ── 既有型別 ──
export interface ChannelConfig;
export interface GuildConfig;
export interface DmConfig;
export interface AdminConfig;
export interface DiscordConfig;
export interface BridgeConfig;
export interface ChannelAccess;
export type CronSchedule;
export type CronAction;
export interface CronConfig;
export interface HistoryConfig;

// ── V2 三層分離型別 ──
export interface ModelDefinition;
export interface ModelProviderDefinition;
export interface ModelsJsonConfig;
export type ModelApi;
export type AuthProfileCredential;
export interface ProfileUsageStats;
export interface AuthProfilesJson;
export interface ModelAliasEntry;
export interface AgentDefaultsConfig;
export interface ModelsConfig;
export interface AuthConfig;

// ── V1 相容型別 ──
export interface ProviderEntry;
export interface ProviderRoutingConfig;
export interface ModelRoutingConfig;

// ── 平台擴充型別 ──
export interface SessionConfig;
export interface MemoryConfig;
export interface OllamaConfig;
export interface ToolPermissionRule;
export interface SafetyConfig;
export interface PromptAssemblerConfig;
export interface WorkflowConfig;
export interface AccountsConfig;
export type RateLimitConfig;
export interface ContextEngineeringConfig;
export interface InboundHistoryConfig;
export interface HomeClaudeCodeConfig;
export interface AgentConfig;         // Per-Agent 設定（agents/{id}/config.json，agent 和 subagent 共用，含 admin flag）
export type AgentsConfig;
export type ThinkingLevel;
export interface ModePreset;
export interface ModeConfig;
export const BUILTIN_MODE_PRESETS;
export interface SubagentsConfig;
export interface BotCircuitBreakerConfig;
```

## 注意事項

- `config` 是 `let`（非 `const`），hot-reload 會整體替換物件引用
- discord.ts 不在 closure 中捕獲 config，每次 messageCreate 讀全域 `config`，確保 hot-reload 生效
- token 變更警告但無法阻止，重啟才能套用新 token
- `claude.cwd` / `claude.command` 已移除，路徑相關設定由環境變數控制
- 環境變數未設定時 `resolveConfigPath()` / `resolveWorkspaceDir()` 直接 throw，不猜預設值
- JSONC 註解剝除改用字串感知 parser（`stripJsoncComments()`），不再誤刪 URL 中的 `//`
- 環境變數展開（`${ENV_VAR}`）在 JSON parse 後遞迴執行，找不到變數啟動報錯
- 外部 `models-config.json`（位於 CATCLAW_CONFIG_DIR）會自動合成 agentDefaults / modelsConfig / modelRouting，catclaw.json 內的設定優先覆蓋
