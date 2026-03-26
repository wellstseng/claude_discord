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

import { readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
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
}

export interface GuildConfig {
  allow?: boolean;
  requireMention?: boolean;
  allowBot?: boolean;
  allowFrom?: string[];
  channels?: Record<string, ChannelConfig>;
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
  | { type: "claude"; channelId: string; prompt: string }
  | { type: "exec"; command: string; channelId?: string; silent?: boolean; timeoutSec?: number; shell?: string; background?: boolean };

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

// ── 新增平台型別 ──────────────────────────────────────────────────────────────

/** 單一 Provider 設定 */
export interface ProviderEntry {
  /** API Key（支援環境變數展開） */
  apiKey?: string;
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
}

/** Provider 路由設定 */
export interface ProviderRoutingConfig {
  /** channelId → providerId */
  channels?: Record<string, string>;
  /** role → providerId */
  roles?: Record<string, string>;
  /** projectId → providerId */
  projects?: Record<string, string>;
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
  globalPath: string;
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

/** 安全設定 */
export interface SafetyConfig {
  enabled: boolean;
  selfProtect: boolean;
  bash: { blacklist: string[] };
  filesystem: {
    protectedPaths: string[];
    credentialPatterns: string[];
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

// ── 完整設定型別 ──────────────────────────────────────────────────────────────

/** 全域設定物件型別（含平台擴充區塊） */
export interface BridgeConfig {
  // ── 既有欄位 ──
  discord: DiscordConfig;
  admin: AdminConfig;
  turnTimeoutMs: number;
  turnTimeoutToolCallMs: number;
  sessionTtlHours: number;
  showToolCalls: "all" | "summary" | "none";
  showThinking: boolean;
  debounceMs: number;
  fileUploadThreshold: number;
  logLevel: LogLevel;
  cron: CronConfig;
  history: HistoryConfig;

  // ── 平台擴充欄位 ──
  /** 預設 provider ID */
  provider: string;
  /** Provider 設定表 */
  providers: Record<string, ProviderEntry>;
  /** Provider 路由規則 */
  providerRouting: ProviderRoutingConfig;
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
  sessionTtlHours?: number;
  showToolCalls?: string | boolean;
  showThinking?: boolean;
  debounceMs?: number;
  fileUploadThreshold?: number;
  logLevel?: string;
  cron?: { enabled?: boolean; maxConcurrentRuns?: number; defaultAccountId?: string; defaultProvider?: string };
  history?: { enabled?: boolean };
  // 平台擴充
  provider?: string;
  providers?: Record<string, ProviderEntry>;
  providerRouting?: {
    channels?: Record<string, string>;
    roles?: Record<string, string>;
    projects?: Record<string, string>;
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

function resolveConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("環境變數 CATCLAW_CONFIG_DIR 未設定，無法定位 catclaw.json");
  return resolve(dir, "catclaw.json");
}

export function resolveWorkspaceDir(): string {
  const dir = process.env.CATCLAW_WORKSPACE;
  if (!dir) throw new Error("環境變數 CATCLAW_WORKSPACE 未設定");
  return resolve(dir);
}

export function resolveClaudeBin(): string {
  return process.env.CATCLAW_CLAUDE_BIN ?? "claude";
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
  return {
    enabled:        r.enabled ?? true,
    globalPath:     r.globalPath ?? "~/.catclaw/memory/global",
    vectorDbPath:   r.vectorDbPath ?? "~/.catclaw/memory/_vectordb",
    contextBudget:  r.contextBudget ?? 3000,
    contextBudgetRatio: r.contextBudgetRatio ?? { global: 0.3, project: 0.4, account: 0.3 },
    writeGate:      r.writeGate ?? { enabled: true, dedupThreshold: 0.80 },
    recall: r.recall ?? {
      triggerMatch: true, vectorSearch: true, relatedEdgeSpreading: true,
      vectorMinScore: 0.65, vectorTopK: 10,
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
    sessionTtlHours: raw.sessionTtlHours ?? 168,
    showToolCalls: parseShowToolCalls(raw.showToolCalls),
    showThinking: raw.showThinking ?? false,
    debounceMs: raw.debounceMs ?? 500,
    fileUploadThreshold: raw.fileUploadThreshold ?? 4000,
    logLevel,
    cron: {
      enabled: raw.cron?.enabled ?? false,
      maxConcurrentRuns: raw.cron?.maxConcurrentRuns ?? 1,
      defaultAccountId: raw.cron?.defaultAccountId,
      defaultProvider: raw.cron?.defaultProvider,
    },
    history: { enabled: raw.history?.enabled ?? true },

    // ── 平台擴充欄位 ──
    provider: raw.provider ?? "claude-api",
    providers: raw.providers ?? {
      "claude-api": { model: "claude-sonnet-4-6" },
    },
    providerRouting: {
      channels: raw.providerRouting?.channels ?? {},
      roles: raw.providerRouting?.roles ?? { default: "claude-api" },
      projects: raw.providerRouting?.projects ?? {},
    },
    session: {
      ttlHours:          raw.session?.ttlHours ?? 168,
      maxHistoryTurns:   raw.session?.maxHistoryTurns ?? 50,
      compactAfterTurns: raw.session?.compactAfterTurns ?? 30,
      persistPath:       raw.session?.persistPath ?? `${workspaceDir}/data/sessions/`,
    },
    memory: defaultMemoryConfig(raw.memory, workspaceDir),
    ollama: raw.ollama ? {
      enabled:    raw.ollama.enabled ?? true,
      primary: {
        host:           raw.ollama.primary?.host ?? "http://localhost:11434",
        model:          raw.ollama.primary?.model ?? "qwen3:8b",
        embeddingModel: raw.ollama.primary?.embeddingModel,
      },
      fallback:   raw.ollama.fallback,
      failover:   raw.ollama.failover ?? true,
      thinkMode:  raw.ollama.thinkMode ?? false,
      numPredict: raw.ollama.numPredict ?? 8192,
      timeout:    raw.ollama.timeout ?? 120_000,
    } : undefined,
    safety: raw.safety ? {
      enabled:     raw.safety.enabled ?? true,
      selfProtect: raw.safety.selfProtect ?? true,
      bash: raw.safety.bash ?? { blacklist: [] },
      filesystem: raw.safety.filesystem ?? { protectedPaths: [], credentialPatterns: [] },
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
      guest:     { requestsPerMinute: 5 },
      member:    { requestsPerMinute: 30 },
      developer: { requestsPerMinute: 60 },
      admin:     { requestsPerMinute: 120 },
    },
  };
}

// ── Per-channel 存取 helper ──────────────────────────────────────────────────

export interface ChannelAccess {
  allowed: boolean;
  requireMention: boolean;
  allowBot: boolean;
  allowFrom: string[];
  /** 頻道綁定的 provider（undefined = 使用預設） */
  provider?: string;
  /** 頻道綁定的專案（undefined = 無限制） */
  boundProject?: string;
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
    };
  }

  if (Object.keys(config.discord.guilds).length === 0) {
    return { allowed: true, requireMention: true, allowBot: false, allowFrom: [] };
  }

  const guild = config.discord.guilds[guildId];
  if (!guild) {
    return { allowed: false, requireMention: true, allowBot: false, allowFrom: [] };
  }

  const guildDefaults: Required<Omit<ChannelConfig, "boundProject" | "provider">> = {
    allow: guild.allow ?? false,
    requireMention: guild.requireMention ?? true,
    allowBot: guild.allowBot ?? false,
    allowFrom: guild.allowFrom ?? [],
  };

  const channels = guild.channels ?? {};
  const channelCfg = channels[channelId];
  const parentCfg = parentId ? channels[parentId] : undefined;

  return {
    allowed:       channelCfg?.allow          ?? parentCfg?.allow          ?? guildDefaults.allow,
    requireMention: channelCfg?.requireMention ?? parentCfg?.requireMention ?? guildDefaults.requireMention,
    allowBot:      channelCfg?.allowBot        ?? parentCfg?.allowBot        ?? guildDefaults.allowBot,
    allowFrom:     channelCfg?.allowFrom       ?? parentCfg?.allowFrom       ?? guildDefaults.allowFrom,
    provider:      channelCfg?.provider        ?? parentCfg?.provider,
    boundProject:  channelCfg?.boundProject    ?? parentCfg?.boundProject,
  };
}

/**
 * 解析特定帳號/頻道應使用哪個 provider ID
 * 優先順序：channel config → role routing → project routing → 預設
 */
export function resolveProvider(opts: {
  channelAccess?: ChannelAccess;
  role?: string;
  projectId?: string;
}): string {
  const { channelAccess, role, projectId } = opts;
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
