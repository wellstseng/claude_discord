/**
 * @file core/config.ts
 * @description 擴充版設定載入器 — 解析完整 catclaw.json（含 memory/workflow/providers 等平台區塊）
 *
 * 繼承 src/config.ts 全部功能（型別、helper、hot-reload），
 * 新增：providers、memory、ollama、safety、workflow、accounts、rateLimit、session。
 *
 * 環境變數展開：字串值符合 "${ENV_VAR_NAME}" 格式時自動替換，找不到則啟動報錯。
 *
 * 環境變數：
 * - CATCLAW_CONFIG_DIR：catclaw.json 所在目錄（必填）
 * - CATCLAW_WORKSPACE：Claude CLI agent 工作目錄（必填）
 * - CATCLAW_CLAUDE_BIN：Claude CLI binary 路徑（可選，預設 "claude"）
 */

import { existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { LogLevel } from "../logger.js";
import { setLogLevel, log } from "../logger.js";

// ── 既有型別（保留相容性）────────────────────────────────────────────────────

export interface ChannelConfig {
  allow?: boolean;
  requireMention?: boolean;
  allowBot?: boolean;
  allowFrom?: string[];
  /** 綁定專案（該頻道只用此專案） */
  boundProject?: string;
  /** 頻道層級 provider 覆寫 */
  provider?: string;
  /** 封鎖 @here / @everyone 群組廣播觸發（預設由 guild 層級繼承） */
  blockGroupMentions?: boolean;
  /**
   * 新訊息自動中斷正在執行的 turn（插隊模式）。
   * true：新訊息到來時，若有正在執行的 turn，立即 abort 並讓新訊息接續執行。
   * 預設 false（FIFO 佇列行為）。
   */
  interruptOnNewMessage?: boolean;
  /**
   * 自動為每條使用者訊息建立 Discord Thread（公開 Thread）。
   * 每條新訊息 → startThread → 回覆在 thread 中，session key 以 thread ID 計。
   * 適合想把每次對話隔離在獨立 thread 的頻道。
   * 預設 false。
   */
  autoThread?: boolean;
}

export interface GuildConfig {
  allow?: boolean;
  requireMention?: boolean;
  allowBot?: boolean;
  allowFrom?: string[];
  channels?: Record<string, ChannelConfig>;
  /** 封鎖 @here / @everyone 群組廣播觸發（預設 true） */
  blockGroupMentions?: boolean;
}

export interface DmConfig {
  enabled: boolean;
}

export interface AdminConfig {
  allowedUserIds: string[];
}

export interface DiscordConfig {
  token: string;
  dm: DmConfig;
  guilds: Record<string, GuildConfig>;
}

export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; at: string };

export type CronAction =
  | { type: "message"; channelId: string; text: string }
  | { type: "claude-acp"; channelId: string; prompt: string; timeoutSec?: number }  // 透過 ACP（Claude CLI spawn）執行 turn
  | { type: "exec"; command: string; channelId?: string; silent?: boolean; timeoutSec?: number; shell?: string; background?: boolean }
  | {
      type: "subagent";
      /** 子 agent 執行的任務描述 */
      task: string;
      /** 指定 provider ID（省略則依序: action.provider → cron.defaultProvider → 全域預設） */
      provider?: string;
      /** 逾時毫秒，預設 300000（5 分鐘） */
      timeoutMs?: number;
      /** 完成後通知頻道，格式："discord:ch:{channelId}" */
      notify?: string;
    };

export interface CronConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  /** Cron 預設執行帳號 */
  defaultAccountId?: string;
  /** Cron 預設 provider */
  defaultProvider?: string;
}

export interface HistoryConfig {
  enabled: boolean;
}

// ── 新三層分離型別（V2：provider/model 重構）────────────────────────────────

/** models.json 中單一模型定義 */
export interface ModelDefinition {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** models.json 中單一 Provider 定義 */
export interface ModelProviderDefinition {
  baseUrl: string;
  api?: ModelApi;
  apiKey?: string;
  models: ModelDefinition[];
}

/** models.json 完整結構 */
export interface ModelsJsonConfig {
  providers: Record<string, ModelProviderDefinition>;
}

/** API 類型識別 */
export type ModelApi = "anthropic-messages" | "openai-completions" | "openai-codex-responses" | "ollama";

/** auth-profile.json 中單一 credential */
export type AuthProfileCredential =
  | { type: "api_key"; provider?: string; key: string; email?: string }
  | { type: "token"; provider?: string; key?: string; token?: string; expires?: number; email?: string }
  | { type: "oauth"; provider?: string; key?: string; access?: string; refresh?: string; expires?: number; clientId?: string; email?: string };

/** auth-profile.json 中單一 profile 的使用統計 */
export interface ProfileUsageStats {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: "rate_limit" | "overloaded" | "billing" | "auth";
  errorCount?: number;
}

/** auth-profile.json 完整結構 */
export interface AuthProfilesJson {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
}

/** catclaw.json agents.defaults 中的 model alias entry */
export interface ModelAliasEntry {
  alias?: string;
}

/** catclaw.json agents.defaults 設定 */
export interface AgentDefaultsConfig {
  /** 主要模型（alias 或 "provider/model" 格式） */
  model?: {
    primary: string;
    fallbacks?: string[];
  };
  /** 模型對照表（"provider/model" → alias） */
  models?: Record<string, ModelAliasEntry>;
}

/** catclaw.json models 區塊（自訂 provider + 合併模式） */
export interface ModelsConfig {
  /** "merge" = 內建 + 自訂合併（預設）；"replace" = 只用自訂 */
  mode?: "merge" | "replace";
  /** 自訂 Provider 定義（baseUrl + models） */
  providers?: Record<string, ModelProviderDefinition>;
}

/** catclaw.json auth 區塊 */
export interface AuthConfig {
  /** 明確的 profile 設定（provider + mode，不含 credential） */
  profiles?: Record<string, { provider: string; mode: "api_key" | "oauth" | "token" }>;
  /** 輪替順序覆寫 */
  order?: Record<string, string[]>;
  /** cooldown 設定覆寫 */
  cooldowns?: {
    billingBackoffHours?: number;
    billingMaxHours?: number;
    failureWindowHours?: number;
  };
}

// ── 舊平台型別（保留過渡期，Phase 3 移除）────────────────────────────────────

/** @deprecated V1 格式 — 將被三層分離取代 */
export interface ProviderEntry {
  /**
   * Provider 型別（明確指定時優先於自動偵測）
   * - "claude" / "claude-oauth" → ClaudeApiProvider（Anthropic Messages API，token 或 OAuth）
   * - "openai" / "openai-compat" → OpenAICompatProvider（/v1/chat/completions）
   * - "codex-oauth"              → CodexOAuthProvider（OpenAI Codex + OAuth 自動刷新）
   * - "ollama"                   → OllamaProvider（/api/chat NDJSON，支援 think 參數）
   */
  type?: "claude" | "claude-oauth" | "openai" | "openai-compat" | "codex-oauth" | "ollama";
  /**
   * 認證模式（通用欄位）
   * - "token"    → Claude OAuth token（auth-profile.json，sk-ant-oat...）
   * - "api"      → Anthropic API key（token 欄位，sk-ant-api...）
   * - "password" → HTTP Basic Auth（username + password，適用 Ollama / OpenAI-compat）
   * 未設定時自動偵測（Claude：有 auth-profile.json → token，否則 api）
   */
  mode?: "token" | "api" | "password";
  /** HTTP Basic Auth 帳號（mode=password 時使用） */
  username?: string;
  /** HTTP Basic Auth 密碼（mode=password 時使用，支援環境變數展開） */
  password?: string;
  /**
   * Ollama thinking 模式（僅 type=ollama 有效，qwen3 等 thinking 模型使用）
   * true = 送出 think:true 參數，回應包含推理過程
   */
  think?: boolean;
  /**
   * Ollama num_predict（最大輸出 token，僅 type=ollama 有效，預設 4096）
   */
  numPredict?: number;
  /** OAuth token 檔案路徑（codex-oauth 用，預設 ~/.codex/auth.json） */
  oauthTokenPath?: string;
  /** OAuth refresh endpoint（codex-oauth 用，預設 https://auth.openai.com/oauth/token） */
  oauthRefreshUrl?: string;
  /** OAuth client_id（codex-oauth 用，部分 provider 需要） */
  oauthClientId?: string;
  /** HTTP 認證 Token（支援環境變數展開，如 ${ANTHROPIC_TOKEN}） */
  token?: string;
  /** 模型 ID */
  model?: string;
  /** OpenAI 相容 baseUrl */
  baseUrl?: string;
  /** Ollama host */
  host?: string;
  /** OpenClaw WebSocket URL */
  wsUrl?: string;
  /** OpenClaw agent ID */
  agentId?: string;
  /** 啟用 extended thinking（僅 claude-api 支援，不支援的 provider 自動忽略） */
  thinking?: boolean;
}

/** Provider 路由設定 */
export interface ProviderRoutingConfig {
  /** channelId → providerId */
  channels?: Record<string, string>;
  /** role → providerId */
  roles?: Record<string, string>;
  /** projectId → providerId */
  projects?: Record<string, string>;
  /** Failover 鏈（provider ID 清單，依序嘗試）→ 自動產生 id="failover" 的 FailoverProvider */
  failoverChain?: string[];
  /** Circuit Breaker 設定（failoverChain 存在時生效） */
  circuitBreaker?: {
    errorThreshold?: number;
    windowMs?: number;
    cooldownMs?: number;
  };
}

/** 統一模型路由設定（優先於 ProviderRoutingConfig） */
export interface ModelRoutingConfig {
  /** 全域預設模型（alias 或 provider/model） */
  default: string;
  /** 角色覆蓋：role → model alias */
  roles?: Record<string, string>;
  /** 專案覆蓋：projectId → model alias */
  projects?: Record<string, string>;
  /** 頻道覆蓋（最高優先）：channelId → model alias */
  channels?: Record<string, string>;
  /** 降級鏈 */
  fallbacks?: string[];
}

/** Session 持久化設定 */
export interface SessionConfig {
  ttlHours: number;
  maxHistoryTurns: number;
  compactAfterTurns: number;
  persistPath: string;
}

/** 記憶系統設定 */
export interface MemoryConfig {
  enabled: boolean;
  /** 記憶根目錄（global atoms 放在 root/global/）*/
  root: string;
  /** @deprecated 舊欄位，解析時自動轉換為 root */
  globalPath?: string;
  vectorDbPath: string;
  /** context window 記憶預算（tokens） */
  contextBudget: number;
  contextBudgetRatio: { global: number; project: number; account: number };
  writeGate: { enabled: boolean; dedupThreshold: number };
  recall: {
    triggerMatch: boolean;
    vectorSearch: boolean;
    relatedEdgeSpreading: boolean;
    vectorMinScore: number;
    vectorTopK: number;
    llmSelect: boolean;
    llmSelectMax: number;
  };
  extract: {
    enabled: boolean;
    perTurn: boolean;
    onSessionEnd: boolean;
    maxItemsPerTurn: number;
    maxItemsSessionEnd: number;
    minNewChars: number;
  };
  consolidate: {
    autoPromoteThreshold: number;
    suggestPromoteThreshold: number;
    decay: { enabled: boolean; halfLifeDays: number; archiveThreshold: number };
  };
  episodic: { enabled: boolean; ttlDays: number };
  rutDetection: { enabled: boolean; windowSize: number; minOccurrences: number };
  oscillation: { enabled: boolean };
  sessionMemory: {
    enabled: boolean;
    intervalTurns: number;
    maxHistoryTurns: number;
  };
}

/** Ollama 雙 Backend 設定 */
export interface OllamaConfig {
  enabled: boolean;
  primary: { host: string; model: string; embeddingModel?: string };
  fallback?: { host: string; model: string };
  /** primary 失敗時自動切換 fallback */
  failover: boolean;
  thinkMode: boolean;
  numPredict: number;
  timeout: number;
}

/** 單條工具權限規則 */
export interface ToolPermissionRule {
  /** 套用對象值（role 名稱或 accountId） */
  subject: string;
  /** 對象類型 */
  subjectType: "role" | "account";
  /** 工具名稱（支援 * 萬用符，例如 "write_*" 或 "*"） */
  tool: string;
  /** allow = 明確允許，deny = 明確拒絕 */
  effect: "allow" | "deny";
  /** 可選：參數條件（params[key] 必須符合 value 正則） */
  paramMatch?: Record<string, string>;
  /** deny 時的說明訊息（顯示給使用者） */
  reason?: string;
}

/** 安全設定 */
export interface SafetyConfig {
  enabled: boolean;
  selfProtect: boolean;
  bash: { blacklist: string[] };
  filesystem: {
    protectedPaths: string[];
    credentialPatterns: string[];
  };
  /** 執行指令前 DM 確認 */
  execApproval?: {
    /** 是否啟用（預設 false） */
    enabled: boolean;
    /** 接收確認請求的 Discord User ID */
    dmUserId: string;
    /** 等待回覆超時毫秒（預設 60000） */
    timeoutMs?: number;
    /** 白名單 patterns（substring match）— 符合者自動允許，不送 DM */
    allowedPatterns?: string[];
  };
  /** 細粒度工具權限規則（per-role / per-account） */
  toolPermissions?: {
    /** 規則清單（先匹配先套用） */
    rules?: ToolPermissionRule[];
    /** 無規則匹配時的預設行為（預設 true = 允許） */
    defaultAllow?: boolean;
  };
}

/** 工作流設定 */
export interface WorkflowConfig {
  guardian: { enabled: boolean; syncReminder: boolean; fileTracking: boolean };
  fixEscalation: { enabled: boolean; retryThreshold: number };
  wisdomEngine: { enabled: boolean };
  aidocs: { enabled: boolean; contentGate: boolean };
}

/** 帳號管理設定 */
export interface AccountsConfig {
  registrationMode: "open" | "invite" | "closed";
  defaultRole: string;
  pairingEnabled: boolean;
  pairingExpireMinutes: number;
}

/** 速率限制（per-role） */
export type RateLimitConfig = Record<string, { requestsPerMinute: number }>;

/** Context Engineering 設定 */
export interface ContextEngineeringConfig {
  enabled: boolean;
  strategies?: {
    /** Compaction：LLM 壓縮策略，model 只在此處需要 */
    compaction?: { enabled?: boolean; model?: string; triggerTurns?: number; preserveRecentTurns?: number };
    /** BudgetGuard：純 token 計算，無需 LLM */
    budgetGuard?: { enabled?: boolean; maxUtilization?: number; contextWindowTokens?: number };
    /** SlidingWindow：純視窗裁切，無需 LLM */
    slidingWindow?: { enabled?: boolean; maxTurns?: number };
  };
}

/** Inbound History 設定 */
export interface InboundHistoryConfig {
  enabled: boolean;
  fullWindowHours: number;
  decayWindowHours: number;
  bucketBTokenCap: number;
  decayIITokenCap: number;
  inject: { enabled: boolean };
}

/** HomeClaudeCode 共用記憶策略 */
export interface HomeClaudeCodeConfig {
  /**
   * 是否啟用 HomeClaudeCode 模式。
   * 啟用後，CatClaw 記憶引擎的 globalPath 指向
   * ~/.claude/memory/global（與 Claude Code 共用同一份全域記憶）。
   */
  enabled: boolean;
  /** 自訂 Claude Code 記憶路徑（預設 ~/.claude/memory/global） */
  path?: string;
}

/** 多 Agent 單一 bot 入口設定 */
export type AgentsConfig = Record<string, Partial<Omit<BridgeConfig, "agents">>>;

// ── Mode（精密/一般模式）────────────────────────────────────────────────────

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** 單一模式定義 */
export interface ModePreset {
  /** Extended Thinking 等級（null = 關閉） */
  thinking?: ThinkingLevel | null;
  /** 壓縮策略偏好 */
  compaction?: "sliding-window" | "llm-summary";
  /** 額外 system prompt 區段（.md 檔名，相對於 workspace/prompts/） */
  systemPromptExtras?: string[];
  /** 工具結果 token 上限覆寫 */
  resultTokenCap?: number;
  /** Output 預留空間比例（0-1，佔 context window） */
  contextReserve?: number;
  /** 每 turn 工具結果合計上限覆寫 */
  perTurnTotalCap?: number;
}

/** 模式設定 */
export interface ModeConfig {
  /** 預設模式名稱 */
  defaultMode: string;
  /** 模式定義表 */
  presets: Record<string, ModePreset>;
}

/** 內建模式預設值 */
export const BUILTIN_MODE_PRESETS: Record<string, ModePreset> = {
  normal: {
    thinking: null,
    compaction: "sliding-window",
    systemPromptExtras: [],
    resultTokenCap: 8000,
    contextReserve: 0.2,
  },
  precision: {
    thinking: "medium",
    compaction: "llm-summary",
    systemPromptExtras: ["coding-discipline"],
    resultTokenCap: 16000,
    contextReserve: 0.3,
  },
};

/** Subagent 設定 */
export interface SubagentsConfig {
  /** 同一 parent session 最多同時執行幾個子 agent（預設 3） */
  maxConcurrent: number;
  /** 預設逾時毫秒（預設 120000） */
  defaultTimeoutMs: number;
  /** 完成後是否預設保留 session（預設 false） */
  defaultKeepSession: boolean;
}


// ── 完整設定型別 ──────────────────────────────────────────────────────────────

/** 全域設定物件型別（含平台擴充區塊） */
export interface BridgeConfig {
  // ── 既有欄位 ──
  discord: DiscordConfig;
  admin: AdminConfig;
  turnTimeoutMs: number;
  turnTimeoutToolCallMs: number;
  showToolCalls: "all" | "summary" | "none";
  showThinking: boolean;
  debounceMs: number;
  fileUploadThreshold: number;
  streamingReply: boolean;
  logLevel: LogLevel;
  cron: CronConfig;
  history: HistoryConfig;

  // ── 平台擴充欄位 ──

  // ── V2 三層分離（新結構）──
  /** Agent 預設設定（model primary/fallbacks/aliases） */
  agentDefaults?: AgentDefaultsConfig;
  /** 模型目錄設定（自訂 provider + 合併模式） */
  modelsConfig?: ModelsConfig;
  /** 認證設定 */
  authConfig?: AuthConfig;

  // ── V1 相容欄位（過渡期保留）──
  /** @deprecated V1 — 預設 provider ID */
  provider: string;
  /** @deprecated V1 — Provider 設定表 */
  providers: Record<string, ProviderEntry>;
  /** Provider 路由規則（舊版，modelRouting 優先） */
  providerRouting: ProviderRoutingConfig;
  /** 統一模型路由（優先於 providerRouting） */
  modelRouting?: ModelRoutingConfig;
  /** Session 持久化設定 */
  session: SessionConfig;
  /** 記憶系統設定 */
  memory: MemoryConfig;
  /** Ollama 設定 */
  ollama?: OllamaConfig;
  /** 安全設定 */
  safety?: SafetyConfig;
  /** 工作流設定 */
  workflow?: WorkflowConfig;
  /** 帳號管理設定 */
  accounts: AccountsConfig;
  /** 速率限制 */
  rateLimit: RateLimitConfig;
  /** Context Engineering 設定 */
  contextEngineering?: ContextEngineeringConfig;
  /** Inbound History 設定 */
  inboundHistory?: InboundHistoryConfig;
  /** 多 Agent 設定（用於 --agent <id> 啟動） */
  agents?: AgentsConfig;
  /** Subagent 設定 */
  subagents?: SubagentsConfig;
  /** 模式設定（一般/精密/自訂） */
  modes?: ModeConfig;
  /** Token Usage Dashboard 設定 */
  dashboard?: { enabled: boolean; port: number; token?: string };
  /** Tool 呼叫 token Budget */
  toolBudget?: {
    /** 單一工具結果 token 上限（預設 8000，0 = 無限制） */
    resultTokenCap?: number;
    /** 每個 turn 所有工具結果合計 token 上限（預設 0 = 無限制） */
    perTurnTotalCap?: number;
    /** 單一 tool 執行超時毫秒（預設 30000，0 = 無限制） */
    toolTimeoutMs?: number;
  };
  /**
   * 外部 MCP Server 設定表。
   * 每個 server 以 key 作為 serverName，tools 命名為 mcp_{serverName}_{toolName}。
   */
  mcpServers?: Record<string, {
    /** 執行指令（如 "node"、"python"） */
    command: string;
    /** 指令參數 */
    args?: string[];
    /** 額外環境變數（支援 ${ENV_VAR} 展開） */
    env?: Record<string, string>;
    /** 此 server 所有 tools 的 tier（預設 elevated） */
    tier?: "public" | "standard" | "elevated" | "admin" | "owner";
  }>;
}

// ── 環境變數展開 ──────────────────────────────────────────────────────────────

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z_0-9]*)\}$/;

/**
 * 遞迴展開物件中所有 "${ENV_VAR}" 字串值
 * @throws 若環境變數不存在
 */
function expandEnvVars<T>(value: T, path = ""): T {
  if (typeof value === "string") {
    const m = value.match(ENV_VAR_PATTERN);
    if (m) {
      const envName = m[1];
      const envVal = process.env[envName];
      if (envVal === undefined) {
        throw new Error(`環境變數 ${envName} 未設定（設定路徑：${path}）`);
      }
      return envVal as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => expandEnvVars(item, `${path}[${i}]`)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = expandEnvVars(v, path ? `${path}.${k}` : k);
    }
    return result as T;
  }
  return value;
}

// ── RawConfig（JSON 解析用，所有欄位可選）────────────────────────────────────

interface RawConfig {
  discord?: {
    token?: string;
    dm?: { enabled?: boolean };
    guilds?: Record<string, {
      allow?: boolean;
      requireMention?: boolean;
      allowBot?: boolean;
      allowFrom?: string[];
      channels?: Record<string, ChannelConfig>;
    }>;
  };
  admin?: { allowedUserIds?: string[] };
  turnTimeoutMs?: number;
  turnTimeoutToolCallMs?: number;
  showToolCalls?: string | boolean;
  showThinking?: boolean;
  debounceMs?: number;
  fileUploadThreshold?: number;
  streamingReply?: boolean;
  logLevel?: string;
  cron?: { enabled?: boolean; maxConcurrentRuns?: number; defaultAccountId?: string; defaultProvider?: string };
  history?: { enabled?: boolean };
  // 平台擴充 — V2 三層分離
  agentDefaults?: AgentDefaultsConfig;
  modelsConfig?: ModelsConfig;
  authConfig?: AuthConfig;
  // 平台擴充 — V1 相容
  provider?: string;
  providers?: Record<string, ProviderEntry>;
  providerRouting?: {
    channels?: Record<string, string>;
    roles?: Record<string, string>;
    projects?: Record<string, string>;
    failoverChain?: string[];
    circuitBreaker?: { errorThreshold?: number; windowMs?: number; cooldownMs?: number };
  };
  modelRouting?: {
    default?: string;
    roles?: Record<string, string>;
    projects?: Record<string, string>;
    channels?: Record<string, string>;
    fallbacks?: string[];
  };
  session?: {
    ttlHours?: number;
    maxHistoryTurns?: number;
    compactAfterTurns?: number;
    persistPath?: string;
  };
  memory?: Partial<MemoryConfig>;
  ollama?: Partial<OllamaConfig> & { primary?: Partial<OllamaConfig["primary"]> };
  safety?: Partial<SafetyConfig>;
  workflow?: Partial<WorkflowConfig>;
  accounts?: Partial<AccountsConfig>;
  rateLimit?: RateLimitConfig;
  /** @deprecated 已移除，保留供 JSON 相容 */
  homeClaudeCode?: Partial<HomeClaudeCodeConfig>;
  agents?: AgentsConfig;
  dashboard?: { enabled?: boolean; port?: number; token?: string };
  toolBudget?: { resultTokenCap?: number; perTurnTotalCap?: number; toolTimeoutMs?: number };
  contextEngineering?: ContextEngineeringConfig;
  inboundHistory?: InboundHistoryConfig;
  subagents?: Partial<SubagentsConfig>;
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    tier?: "public" | "standard" | "elevated" | "admin" | "owner";
  }>;
}

// ── 路徑解析 ──────────────────────────────────────────────────────────────────

/**
 * String-aware JSONC comment stripper
 * 跳過字串內容（包括 URL 的 //），只刪除真正的行注解
 */
function stripJsoncComments(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && inString) {
      result += ch + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }
    if (!inString && ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

export function resolveConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("環境變數 CATCLAW_CONFIG_DIR 未設定，無法定位 catclaw.json");
  return resolve(dir, "catclaw.json");
}

/** 解析 catclaw 根目錄（CATCLAW_CONFIG_DIR，無設定則報錯） */
export function resolveCatclawDir(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("環境變數 CATCLAW_CONFIG_DIR 未設定");
  return resolve(dir);
}

export function resolveWorkspaceDir(): string {
  const dir = process.env.CATCLAW_WORKSPACE;
  if (!dir) throw new Error("環境變數 CATCLAW_WORKSPACE 未設定");
  return resolve(dir);
}

/** 解析 workspace 目錄（CATCLAW_WORKSPACE��無設定則報錯） */
export function resolveWorkspaceDirSafe(): string {
  const dir = process.env.CATCLAW_WORKSPACE;
  if (!dir) throw new Error("環境變數 CATCLAW_WORKSPACE 未設定");
  return resolve(dir);
}

export function resolveClaudeBin(): string {
  return process.env.CATCLAW_CLAUDE_BIN ?? "claude";
}

// ── models-config.json 外部載入 ──────────────────────────────────────────────

interface ModelsConfigFile {
  mode?: "merge" | "replace";
  primary?: string;
  fallbacks?: string[];
  aliases?: Record<string, string>;
  providers?: Record<string, ModelProviderDefinition & {
    embeddingModel?: string;
    defaultModel?: string;
    thinkMode?: boolean;
    numPredict?: number;
    timeout?: number;
  }>;
  /** 模型路由：channel/project/role 覆蓋 */
  routing?: {
    default?: string;
    roles?: Record<string, string>;
    projects?: Record<string, string>;
    channels?: Record<string, string>;
  };
}

/**
 * 從 CATCLAW_CONFIG_DIR/models-config.json 載入模型設定檔。
 * 若不存在回傳 null。
 */
function loadModelsConfigFile(): ModelsConfigFile | null {
  try {
    const dir = resolveCatclawDir();
    const p = join(dir, "models-config.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as ModelsConfigFile;
  } catch (err) {
    log.warn(`[config] models-config.json 讀取失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 從 models-config.json 合成 agentDefaults（供 provider registry V2）。
 */
function synthesizeFromModelsConfig(mcfg: ModelsConfigFile): {
  agentDefaults: AgentDefaultsConfig;
  modelsConfig: ModelsConfig;
  ollamaRaw: Record<string, unknown> | undefined;
  modelRouting: ModelRoutingConfig | undefined;
} {
  // aliases: { sonnet: "anthropic/claude-sonnet-4-6" } → models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } }
  const models: Record<string, ModelAliasEntry> = {};
  if (mcfg.aliases) {
    for (const [alias, fullRef] of Object.entries(mcfg.aliases)) {
      models[fullRef] = { alias };
    }
  }

  const agentDefaults: AgentDefaultsConfig = {
    model: {
      primary: mcfg.primary ?? "sonnet",
      ...(mcfg.fallbacks?.length && { fallbacks: mcfg.fallbacks }),
    },
    models,
  };

  // modelsConfig: 只取 provider 的 model catalog 部分
  const modelsConfigProviders: Record<string, ModelProviderDefinition> = {};
  if (mcfg.providers) {
    for (const [id, prov] of Object.entries(mcfg.providers)) {
      modelsConfigProviders[id] = {
        baseUrl: prov.baseUrl,
        api: prov.api,
        apiKey: prov.apiKey,
        models: prov.models ?? [],
      };
    }
  }
  const modelsConfig: ModelsConfig = { mode: mcfg.mode ?? "merge", providers: modelsConfigProviders };

  // ollama: 從 providers.ollama 合成 OllamaConfig raw
  let ollamaRaw: Record<string, unknown> | undefined;
  const ollamaProv = mcfg.providers?.["ollama"];
  if (ollamaProv) {
    ollamaRaw = {
      enabled: true,
      primary: {
        host: ollamaProv.baseUrl ?? "http://localhost:11434",
        model: ollamaProv.defaultModel ?? ollamaProv.models?.[0]?.id ?? "qwen3:14b",
        embeddingModel: ollamaProv.embeddingModel,
      },
      failover: false,
      thinkMode: ollamaProv.thinkMode ?? false,
      numPredict: ollamaProv.numPredict ?? 8192,
      timeout: ollamaProv.timeout ?? 120_000,
    };
  }

  // modelRouting: routing 區塊 + primary/fallbacks 作為 default/fallbacks
  let modelRouting: ModelRoutingConfig | undefined;
  const routingDefault = mcfg.routing?.default ?? mcfg.primary;
  if (routingDefault) {
    modelRouting = {
      default: routingDefault,
      ...(mcfg.fallbacks?.length && { fallbacks: mcfg.fallbacks }),
      ...(mcfg.routing?.roles && { roles: mcfg.routing.roles }),
      ...(mcfg.routing?.projects && { projects: mcfg.routing.projects }),
      ...(mcfg.routing?.channels && { channels: mcfg.routing.channels }),
    };
  }

  return { agentDefaults, modelsConfig, ollamaRaw, modelRouting };
}

/**
 * 讀取 workspace 根目錄的 CATCLAW.md 作為 base system prompt。
 * 若不存在，自動產生預設 CATCLAW.md 並回傳其內容。
 * 供所有 channel handler 共用，新增頻道直接呼叫即可。
 */
export function loadBaseSystemPrompt(): string {
  let workspaceDir: string;
  try { workspaceDir = resolveWorkspaceDir(); } catch { return ""; }
  const p = join(workspaceDir, "CATCLAW.md");
  if (existsSync(p)) {
    try { return readFileSync(p, "utf-8"); } catch { /* fall through */ }
  }
  // 自動產生預設 CATCLAW.md
  const defaultContent = `# CATCLAW.md — CatClaw Bot 行為規則

你是 CatClaw，一個專案知識代理人。

## 重啟機制

當使用者要求重啟 bot 時，依序執行：

1. 編譯程式碼（若有修改）：
   \`\`\`bash
   npx tsc
   \`\`\`

2. 寫入重啟信號（帶入頻道 ID，讓重啟後可回報）：
   \`\`\`bash
   node catclaw.js restart
   \`\`\`
   或直接寫 signal file：
   \`\`\`bash
   echo '{"channelId":"'$CATCLAW_CHANNEL_ID'","time":"'$(date -Iseconds)'"}' > signal/RESTART
   \`\`\`

重啟完成後，bot 會自動在觸發頻道發送 \`[CatClaw] 已重啟（時間）\`。

## 工作目錄

你的工作目錄是 \`${workspaceDir}\`。
`;
  try {
    writeFileSync(p, defaultContent, "utf-8");
    log.info(`[config] 已產生預設 CATCLAW.md：${p}`);
  } catch { /* ignore write error, still return content */ }
  return defaultContent;
}

// ── 解析工具 ──────────────────────────────────────────────────────────────────

function parseShowToolCalls(value: string | boolean | undefined): "all" | "summary" | "none" {
  if (value === undefined) return "all";
  if (value === true) return "all";
  if (value === false) return "none";
  const valid = ["all", "summary", "none"];
  return valid.includes(value) ? (value as "all" | "summary" | "none") : "all";
}

function defaultMemoryConfig(raw: Partial<MemoryConfig> | undefined, workspaceDir: string): MemoryConfig {
  const r = raw ?? {};
  // backward compat：舊 globalPath 直接當 root 使用
  const root = r.root ?? r.globalPath ?? "~/.catclaw/memory";
  return {
    enabled:        r.enabled ?? true,
    root,
    vectorDbPath:   r.vectorDbPath ?? "~/.catclaw/memory/_vectordb",
    contextBudget:  r.contextBudget ?? 3000,
    contextBudgetRatio: r.contextBudgetRatio ?? { global: 0.3, project: 0.4, account: 0.3 },
    writeGate:      r.writeGate ?? { enabled: true, dedupThreshold: 0.80 },
    recall: {
      triggerMatch: r.recall?.triggerMatch ?? true,
      vectorSearch: r.recall?.vectorSearch ?? true,
      relatedEdgeSpreading: r.recall?.relatedEdgeSpreading ?? true,
      vectorMinScore: r.recall?.vectorMinScore ?? 0.65,
      vectorTopK: r.recall?.vectorTopK ?? 10,
      llmSelect: r.recall?.llmSelect ?? false,
      llmSelectMax: r.recall?.llmSelectMax ?? 5,
    },
    extract: r.extract ?? {
      enabled: true, perTurn: true, onSessionEnd: true,
      maxItemsPerTurn: 3, maxItemsSessionEnd: 5, minNewChars: 500,
    },
    consolidate: r.consolidate ?? {
      autoPromoteThreshold: 20, suggestPromoteThreshold: 4,
      decay: { enabled: true, halfLifeDays: 30, archiveThreshold: 0.3 },
    },
    episodic:     r.episodic ?? { enabled: true, ttlDays: 24 },
    rutDetection: r.rutDetection ?? { enabled: true, windowSize: 3, minOccurrences: 2 },
    oscillation:  r.oscillation ?? { enabled: true },
    sessionMemory: r.sessionMemory ?? { enabled: true, intervalTurns: 10, maxHistoryTurns: 15 },
  };
}

// ── 載入 ──────────────────────────────────────────────────────────────────────

function loadConfig(): BridgeConfig {
  const configPath = resolveConfigPath();
  const workspaceDir = resolveWorkspaceDir();

  let raw: RawConfig;
  try {
    const text = readFileSync(configPath, "utf-8");
    // 支援 JSONC：string-aware comment stripping（避免誤刪 URL 裡的 //）
    const stripped = stripJsoncComments(text);
    raw = JSON.parse(stripped) as RawConfig;
  } catch (err) {
    throw new Error(`無法讀取 catclaw.json（${configPath}）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 環境變數展開（遞迴，找不到則 throw）
  raw = expandEnvVars(raw, "");

  if (!raw.discord?.token) {
    throw new Error("catclaw.json 中 discord.token 欄位必填");
  }

  // S17：safety.enabled/selfProtect 被明確關閉 → 拒絕啟動
  if (raw.safety?.enabled === false) {
    throw new Error("catclaw.json safety.enabled=false 被禁止，拒絕啟動（移除此欄位可恢復預設 true）");
  }
  if (raw.safety?.selfProtect === false) {
    throw new Error("catclaw.json safety.selfProtect=false 被禁止，拒絕啟動（移除此欄位可恢復預設 true）");
  }

  // 正規化 guilds
  const guilds: Record<string, GuildConfig> = {};
  if (raw.discord.guilds) {
    for (const [guildId, guild] of Object.entries(raw.discord.guilds)) {
      guilds[guildId] = {
        allow: guild.allow,
        requireMention: guild.requireMention,
        allowBot: guild.allowBot,
        allowFrom: guild.allowFrom,
        channels: guild.channels ?? {},
      };
    }
  }

  const validLevels = ["debug", "info", "warn", "error", "silent"];
  const logLevel = (validLevels.includes(raw.logLevel ?? "") ? raw.logLevel : "info") as LogLevel;

  const turnTimeoutMs = raw.turnTimeoutMs ?? 300_000;

  // models-config.json 為模型設定唯一真相源
  let resolvedAgentDefaults: AgentDefaultsConfig | undefined;
  let resolvedModelsConfig: ModelsConfig | undefined;
  let ollamaRaw = raw.ollama;

  let resolvedModelRouting: ModelRoutingConfig | undefined;

  const mcfg = loadModelsConfigFile();
  if (mcfg) {
    const syn = synthesizeFromModelsConfig(mcfg);
    resolvedAgentDefaults = syn.agentDefaults;
    resolvedModelsConfig = syn.modelsConfig;
    resolvedModelRouting = syn.modelRouting;
    if (!raw.ollama) ollamaRaw = syn.ollamaRaw as typeof raw.ollama;
    log.info(`[config] 從 models-config.json 載入模型設定（primary=${syn.agentDefaults.model?.primary}）`);
  }

  return {
    // ── 既有欄位 ──
    discord: {
      token: raw.discord.token,
      dm: { enabled: raw.discord.dm?.enabled ?? true },
      guilds,
    },
    admin: { allowedUserIds: raw.admin?.allowedUserIds ?? [] },
    turnTimeoutMs,
    turnTimeoutToolCallMs: raw.turnTimeoutToolCallMs ?? Math.round(turnTimeoutMs * 1.6),
    showToolCalls: parseShowToolCalls(raw.showToolCalls),
    showThinking: raw.showThinking ?? false,
    debounceMs: raw.debounceMs ?? 500,
    fileUploadThreshold: raw.fileUploadThreshold ?? 4000,
    streamingReply: raw.streamingReply ?? true,
    logLevel,
    cron: {
      enabled: raw.cron?.enabled ?? false,
      maxConcurrentRuns: raw.cron?.maxConcurrentRuns ?? 1,
      defaultAccountId: raw.cron?.defaultAccountId,
      defaultProvider: raw.cron?.defaultProvider,
    },
    history: { enabled: raw.history?.enabled ?? true },

    // ── 平台擴充欄位 ──

    agentDefaults: resolvedAgentDefaults,
    modelsConfig: resolvedModelsConfig,
    authConfig: raw.authConfig,

    // V1 相容（provider/providers 已廢棄，保留 fallback 以免啟動失敗）
    provider: raw.provider ?? (process.env["ANTHROPIC_TOKEN"] ? "claude-oauth" : "ollama-local"),
    providers: raw.providers ?? (process.env["ANTHROPIC_TOKEN"]
      ? {
          "claude-oauth": {
            type: "claude-oauth" as const,
            token: process.env["ANTHROPIC_TOKEN"],
            model: "claude-sonnet-4-6",
          },
        }
      : {
          "ollama-local": {
            type: "ollama" as const,
            host: "http://localhost:11434",
            model: "qwen3:1.7b",
          },
        }),
    providerRouting: {
      channels: raw.providerRouting?.channels ?? {},
      roles: raw.providerRouting?.roles ?? {
        default: process.env["ANTHROPIC_TOKEN"] ? "claude-oauth" : "ollama-local",
      },
      projects: raw.providerRouting?.projects ?? {},
      failoverChain: raw.providerRouting?.failoverChain,
      circuitBreaker: raw.providerRouting?.circuitBreaker,
    },
    modelRouting: resolvedModelRouting ?? (raw.modelRouting?.default ? {
      default: raw.modelRouting.default,
      roles: raw.modelRouting.roles,
      projects: raw.modelRouting.projects,
      channels: raw.modelRouting.channels,
      fallbacks: raw.modelRouting.fallbacks,
    } : undefined),
    session: {
      ttlHours:          raw.session?.ttlHours ?? 168,
      maxHistoryTurns:   raw.session?.maxHistoryTurns ?? 50,
      compactAfterTurns: raw.session?.compactAfterTurns ?? 30,
      persistPath:       raw.session?.persistPath ?? `${workspaceDir}/data/sessions/`,
    },
    memory: defaultMemoryConfig(raw.memory, workspaceDir),
    ollama: ollamaRaw ? {
      enabled:    ollamaRaw.enabled ?? true,
      primary: {
        host:           ollamaRaw.primary?.host ?? "http://localhost:11434",
        model:          ollamaRaw.primary?.model ?? "qwen3:8b",
        embeddingModel: ollamaRaw.primary?.embeddingModel,
      },
      fallback:   ollamaRaw.fallback,
      failover:   ollamaRaw.failover ?? true,
      thinkMode:  ollamaRaw.thinkMode ?? false,
      numPredict: ollamaRaw.numPredict ?? 8192,
      timeout:    ollamaRaw.timeout ?? 120_000,
    } : undefined,
    safety: raw.safety ? {
      enabled:     raw.safety.enabled ?? true,
      selfProtect: raw.safety.selfProtect ?? true,
      bash: raw.safety.bash ?? { blacklist: [] },
      filesystem: raw.safety.filesystem ?? { protectedPaths: [], credentialPatterns: [] },
      execApproval: raw.safety.execApproval,
    } : undefined,
    workflow: raw.workflow ? {
      guardian:       raw.workflow.guardian       ?? { enabled: true, syncReminder: true, fileTracking: true },
      fixEscalation:  raw.workflow.fixEscalation  ?? { enabled: true, retryThreshold: 2 },
      wisdomEngine:   raw.workflow.wisdomEngine   ?? { enabled: true },
      aidocs:         raw.workflow.aidocs         ?? { enabled: true, contentGate: true },
    } : undefined,
    accounts: {
      registrationMode:    (raw.accounts?.registrationMode ?? "invite") as AccountsConfig["registrationMode"],
      defaultRole:         raw.accounts?.defaultRole ?? "member",
      pairingEnabled:      raw.accounts?.pairingEnabled ?? true,
      pairingExpireMinutes: raw.accounts?.pairingExpireMinutes ?? 30,
    },
    rateLimit: raw.rateLimit ?? {
      guest:            { requestsPerMinute: 5 },
      member:           { requestsPerMinute: 30 },
      developer:        { requestsPerMinute: 60 },
      admin:            { requestsPerMinute: 120 },
      "platform-owner": { requestsPerMinute: 300 },
    },
    agents: raw.agents,
    dashboard: raw.dashboard?.enabled ? {
      enabled: true,
      port: raw.dashboard.port ?? 8088,
      token: raw.dashboard.token,
    } : undefined,
    toolBudget: raw.toolBudget,
    contextEngineering: raw.contextEngineering,
    inboundHistory: raw.inboundHistory,
    subagents: raw.subagents ? {
      maxConcurrent:     raw.subagents.maxConcurrent ?? 3,
      defaultTimeoutMs:  raw.subagents.defaultTimeoutMs ?? 120_000,
      defaultKeepSession: raw.subagents.defaultKeepSession ?? false,
    } : undefined,
    mcpServers: raw.mcpServers,
  };
}

// ── Per-channel 存取 helper ──────────────────────────────────────────────────

export interface ChannelAccess {
  allowed: boolean;
  requireMention: boolean;
  allowBot: boolean;
  allowFrom: string[];
  /** 封鎖 @here / @everyone 群組廣播觸發 */
  blockGroupMentions: boolean;
  /** 頻道綁定的 provider（undefined = 使用預設） */
  provider?: string;
  /** 頻道綁定的專案（undefined = 無限制） */
  boundProject?: string;
  /** 新訊息自動中斷正在執行的 turn（插隊模式，預設 false） */
  interruptOnNewMessage: boolean;
  /** 每條使用者訊息自動建立 Discord Thread（預設 false） */
  autoThread: boolean;
}

/**
 * 查詢指定頻道的存取設定
 *
 * 繼承鏈：
 * 1. DM（guildId = null）→ dm.enabled，不需 mention，禁止 bot
 * 2. guilds 為空物件 → 全部允許，requireMention 預設 true
 * 3. guilds 有設定 → channels[channelId] → channels[parentId] → Guild 預設
 */
export function getChannelAccess(
  guildId: string | null,
  channelId: string,
  parentId?: string | null
): ChannelAccess {
  if (!guildId) {
    return {
      allowed: config.discord.dm.enabled,
      requireMention: false,
      allowBot: false,
      allowFrom: [],
      blockGroupMentions: false,
      interruptOnNewMessage: false,
      autoThread: false,
    };
  }

  if (Object.keys(config.discord.guilds).length === 0) {
    return { allowed: true, requireMention: true, allowBot: false, allowFrom: [], blockGroupMentions: true, interruptOnNewMessage: false, autoThread: false };
  }

  const guild = config.discord.guilds[guildId];
  if (!guild) {
    return { allowed: false, requireMention: true, allowBot: false, allowFrom: [], blockGroupMentions: true, interruptOnNewMessage: false, autoThread: false };
  }

  const guildDefaults: Required<Omit<ChannelConfig, "boundProject" | "provider">> = {
    allow: guild.allow ?? false,
    requireMention: guild.requireMention ?? true,
    allowBot: guild.allowBot ?? false,
    allowFrom: guild.allowFrom ?? [],
    blockGroupMentions: guild.blockGroupMentions ?? true,
    interruptOnNewMessage: false,
    autoThread: false,
  };

  const channels = guild.channels ?? {};
  const channelCfg = channels[channelId];
  const parentCfg = parentId ? channels[parentId] : undefined;

  return {
    allowed:                channelCfg?.allow                    ?? parentCfg?.allow                    ?? guildDefaults.allow,
    requireMention:         channelCfg?.requireMention           ?? parentCfg?.requireMention           ?? guildDefaults.requireMention,
    allowBot:               channelCfg?.allowBot                 ?? parentCfg?.allowBot                 ?? guildDefaults.allowBot,
    allowFrom:              channelCfg?.allowFrom                ?? parentCfg?.allowFrom                ?? guildDefaults.allowFrom,
    blockGroupMentions:     channelCfg?.blockGroupMentions       ?? parentCfg?.blockGroupMentions       ?? guildDefaults.blockGroupMentions,
    interruptOnNewMessage:  channelCfg?.interruptOnNewMessage    ?? parentCfg?.interruptOnNewMessage    ?? guildDefaults.interruptOnNewMessage,
    autoThread:             channelCfg?.autoThread               ?? parentCfg?.autoThread               ?? guildDefaults.autoThread,
    provider:               channelCfg?.provider                 ?? parentCfg?.provider,
    boundProject:           channelCfg?.boundProject             ?? parentCfg?.boundProject,
  };
}

/**
 * 解析特定帳號/頻道應使用哪個 provider ID
 * 優先順序：channel config → role routing → project routing → 預設
 */
export function resolveProvider(opts: {
  channelAccess?: ChannelAccess;
  channelId?: string;
  role?: string;
  projectId?: string;
}): string {
  const { channelAccess, channelId, role, projectId } = opts;
  const mr = config.modelRouting;

  // 新版 modelRouting（優先）：channel > project > role > default
  if (mr) {
    if (channelId && mr.channels?.[channelId]) return mr.channels[channelId];
    if (channelAccess?.provider) return channelAccess.provider;
    if (projectId && mr.projects?.[projectId]) return mr.projects[projectId];
    if (role && mr.roles?.[role]) return mr.roles[role];
    return mr.roles?.["default"] ?? mr.default;
  }

  // 舊版 providerRouting（向後相容）
  const routing = config.providerRouting;
  if (channelAccess?.provider) return channelAccess.provider;
  if (role && routing.roles?.[role]) return routing.roles[role];
  if (projectId && routing.projects?.[projectId]) return routing.projects[projectId];
  return routing.roles?.["default"] ?? config.provider;
}

// ── Export ────────────────────────────────────────────────────────────────────

export let config: BridgeConfig = loadConfig();

// ── Hot-Reload ────────────────────────────────────────────────────────────────

function reloadConfig(): void {
  try {
    const newConfig = loadConfig();
    if (newConfig.discord.token !== config.discord.token) {
      log.warn("[config] discord.token 變更需要重啟才會生效");
    }
    config = newConfig;
    setLogLevel(config.logLevel);
    log.info("[config] hot-reload 完成");
  } catch (err) {
    log.warn(`[config] hot-reload 失敗，維持舊設定：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function watchConfig(): void {
  const configPath = resolveConfigPath();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    watch(configPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        log.info("[config] 偵測到 catclaw.json 變動，重新載入...");
        reloadConfig();
      }, 500);
    });
    log.info("[config] 已啟動 catclaw.json 監聽（hot-reload）");
  } catch (err) {
    log.warn(`[config] 無法監聽 catclaw.json：${err instanceof Error ? err.message : String(err)}`);
  }
}
