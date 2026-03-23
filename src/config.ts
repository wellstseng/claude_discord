/**
 * @file config.ts
 * @description 從 catclaw.json 載入設定，提供 per-channel 存取 helper
 *
 * 設定結構：
 * - discord：Discord 連線、DM、guild/channel 權限（含繼承鏈）
 * - 全域：turnTimeoutMs、sessionTtlHours、showToolCalls、debounceMs 等
 *
 * 繼承鏈（getChannelAccess）：
 *   Thread → channels[threadId] → channels[parentId] → Guild 預設
 *
 * 環境變數：
 * - CATCLAW_CONFIG_DIR：catclaw.json 所在目錄（必填）
 * - CATCLAW_WORKSPACE：Claude CLI agent 工作目錄（必填）
 * - CATCLAW_CLAUDE_BIN：Claude CLI binary 路徑（可選，預設 "claude"）
 */

import { readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./logger.js";
import { setLogLevel, log } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** 單一頻道/討論串設定（可部分覆寫 Guild 預設） */
export interface ChannelConfig {
  /** 是否允許回應此頻道 */
  allow?: boolean;
  /** 是否需要 @mention bot 才觸發 */
  requireMention?: boolean;
  /** 是否允許處理 bot 訊息 */
  allowBot?: boolean;
  /** 白名單：只處理這些 user/bot ID 的訊息（空陣列 = 不限制） */
  allowFrom?: string[];
}

/** 單一 Guild（伺服器）設定，含預設值 + per-channel 覆寫 */
export interface GuildConfig {
  /** Guild 預設：是否允許（未設定 channels 的頻道依此判斷），預設 false */
  allow?: boolean;
  /** Guild 預設：是否需要 @mention，預設 true */
  requireMention?: boolean;
  /** Guild 預設：是否處理 bot 訊息，預設 false */
  allowBot?: boolean;
  /** Guild 預設：白名單（空陣列 = 不限制） */
  allowFrom?: string[];
  /** per-channel 覆寫 */
  channels?: Record<string, ChannelConfig>;
}

/** DM 設定 */
export interface DmConfig {
  /** 是否啟用 DM 回應，預設 true */
  enabled: boolean;
}

/** 管理員設定 */
export interface AdminConfig {
  /** 允許執行管理指令的 Discord user ID 白名單 */
  allowedUserIds: string[];
}

/** Discord 相關設定 */
export interface DiscordConfig {
  /** Discord Bot Token */
  token: string;
  /** DM 設定 */
  dm: DmConfig;
  /** per-guild、per-channel 設定 */
  guilds: Record<string, GuildConfig>;
}

// ── Cron 排程型別 ─────────────────────────────────────────────────────────

/** 排程時間定義 */
export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }     // cron 表達式（如 "0 9 * * *"）
  | { kind: "every"; everyMs: number }                // 固定間隔（毫秒）
  | { kind: "at"; at: string };                       // 一次性 ISO 時間

/** 排程 Job 的執行動作 */
export type CronAction =
  | { type: "message"; channelId: string; text: string }     // 直接發訊息
  | { type: "claude"; channelId: string; prompt: string }    // 跑 Claude turn，結果送到頻道
  | { type: "exec"; command: string; channelId?: string; silent?: boolean; timeoutSec?: number };  // 執行 shell 指令，可選回報頻道，預設 120 秒

/** Cron 全域設定（job 定義在 data/cron-jobs.json） */
export interface CronConfig {
  enabled: boolean;
  /** 同時執行的 job 上限，預設 1 */
  maxConcurrentRuns: number;
}

/** 全域設定物件型別 */
export interface BridgeConfig {
  /** Discord 相關設定 */
  discord: DiscordConfig;
  /** 管理員設定（slash command 權限）*/
  admin: AdminConfig;
  /** Claude 回應超時毫秒數，預設 300000（5 分鐘） */
  turnTimeoutMs: number;
  /** 涉及工具呼叫時的延長超時毫秒數，預設 turnTimeoutMs * 1.6（8 分鐘） */
  turnTimeoutToolCallMs: number;
  /** Session 閒置超時（小時），超過此時間不 resume，預設 168（7 天） */
  sessionTtlHours: number;
  /** 工具呼叫顯示模式："all" 全顯示 / "summary" 只顯示「處理中」/ "none" 全隱藏 */
  showToolCalls: "all" | "summary" | "none";
  /** 是否顯示 Claude 的推理過程（thinking），預設 false */
  showThinking: boolean;
  /** Debounce 毫秒數，預設 500 */
  debounceMs: number;
  /** 回覆超過此字數時上傳為 .md 檔案，0 = 停用，預設 4000 */
  fileUploadThreshold: number;
  /** Log 層級，預設 "info" */
  logLevel: LogLevel;
  /** Cron 排程設定 */
  cron: CronConfig;
}

// ── JSON 載入 ────────────────────────────────────────────────────────────────

/** catclaw.json 的原始 JSON 型別（所有欄位皆可選） */
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
  admin?: {
    allowedUserIds?: string[];
  };
  // claude.cwd / claude.command 已移除，改由環境變數控制
  turnTimeoutMs?: number;
  turnTimeoutToolCallMs?: number;
  sessionTtlHours?: number;
  showToolCalls?: string | boolean;
  showThinking?: boolean;
  debounceMs?: number;
  fileUploadThreshold?: number;
  logLevel?: string;
  cron?: {
    enabled?: boolean;
    maxConcurrentRuns?: number;
  };
}

// ── Config 路徑解析 ──────────────────────────────────────────────────────────

/**
 * 讀取 CATCLAW_CONFIG_DIR 環境變數決定 catclaw.json 位置
 * 找不到直接 throw（不 fallback，錯了就要明確報錯）
 */
function resolveConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  // 環境變數未設定時明確報錯，不猜路徑
  if (!dir) {
    throw new Error("環境變數 CATCLAW_CONFIG_DIR 未設定，無法定位 catclaw.json");
  }
  return resolve(dir, "catclaw.json");
}

// ── Workspace 路徑解析 ────────────────────────────────────────────────────────

/**
 * 讀取 CATCLAW_WORKSPACE 環境變數，找不到 throw
 * Workspace 是 Claude CLI agent 的工作目錄，也是 data/ 存放位置
 */
export function resolveWorkspaceDir(): string {
  const dir = process.env.CATCLAW_WORKSPACE;
  // 環境變數未設定時明確報錯，不猜預設值
  if (!dir) {
    throw new Error("環境變數 CATCLAW_WORKSPACE 未設定");
  }
  return resolve(dir);
}

// ── Claude Binary 路徑解析 ────────────────────────────────────────────────────

/**
 * 讀取 CATCLAW_CLAUDE_BIN 環境變數，未設定用 "claude" 預設
 * 允許不設定，因為大多數環境 PATH 中已有 claude
 */
export function resolveClaudeBin(): string {
  // 未設定則依賴 PATH，讓 spawn 自動找 binary
  return process.env.CATCLAW_CLAUDE_BIN ?? "claude";
}

/**
 * 解析 showToolCalls 設定值
 * 相容舊格式（boolean）：true → "all"，false → "none"
 */
function parseShowToolCalls(value: string | boolean | undefined): "all" | "summary" | "none" {
  if (value === undefined) return "all";
  if (value === true) return "all";
  if (value === false) return "none";
  const valid = ["all", "summary", "none"];
  return valid.includes(value) ? (value as "all" | "summary" | "none") : "all";
}

/**
 * 從 catclaw.json 載入設定
 * @returns 完整的 BridgeConfig 物件
 * @throws 若 catclaw.json 不存在或 token 未設定
 */
function loadConfig(): BridgeConfig {
  // 路徑由環境變數決定，找不到直接 throw
  const configPath = resolveConfigPath();

  let raw: RawConfig;
  try {
    const text = readFileSync(configPath, "utf-8");
    // 支援 JSONC：strip 掉 // 註解（整行註解 + 行尾註解）後再 parse
    const stripped = text.replace(/\/\/.*$/gm, "");
    raw = JSON.parse(stripped) as RawConfig;
  } catch (err) {
    throw new Error(
      `無法讀取 catclaw.json（${configPath}）：${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!raw.discord?.token) {
    throw new Error("catclaw.json 中 discord.token 欄位必填");
  }

  // 正規化 guilds：保留 Guild 級預設 + channels
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

  // 驗證 logLevel
  const validLevels = ["debug", "info", "warn", "error", "silent"];
  const logLevel = (
    validLevels.includes(raw.logLevel ?? "") ? raw.logLevel : "info"
  ) as LogLevel;

  return {
    discord: {
      token: raw.discord.token,
      dm: { enabled: raw.discord.dm?.enabled ?? true },
      guilds,
    },
    admin: {
      allowedUserIds: raw.admin?.allowedUserIds ?? [],
    },
    // 原本在 claude.* 的欄位提升到頂層，從環境變數控制的路徑相關欄位已移除
    turnTimeoutMs: raw.turnTimeoutMs ?? 300_000,
    turnTimeoutToolCallMs: raw.turnTimeoutToolCallMs ?? Math.round((raw.turnTimeoutMs ?? 300_000) * 1.6),
    sessionTtlHours: raw.sessionTtlHours ?? 168,
    showToolCalls: parseShowToolCalls(raw.showToolCalls),
    showThinking: raw.showThinking ?? false,
    debounceMs: raw.debounceMs ?? 500,
    fileUploadThreshold: raw.fileUploadThreshold ?? 4000,
    logLevel,
    cron: {
      enabled: raw.cron?.enabled ?? false,
      maxConcurrentRuns: raw.cron?.maxConcurrentRuns ?? 1,
    },
  };
}

// ── Per-channel 存取 helper ─────────────────────────────────────────────────

/** getChannelAccess 的回傳值 */
export interface ChannelAccess {
  /** 是否允許回應 */
  allowed: boolean;
  /** 是否需要 @mention bot */
  requireMention: boolean;
  /** 是否允許處理 bot 訊息 */
  allowBot: boolean;
  /** 白名單（空陣列 = 不限制） */
  allowFrom: string[];
}

/**
 * 查詢指定頻道的存取設定
 *
 * 繼承鏈：
 * 1. DM（guildId = null）→ dm.enabled，不需 mention，禁止 bot
 * 2. guilds 為空物件 → 全部允許，requireMention 預設 true
 * 3. guilds 有設定 → channels[channelId] → channels[parentId] → Guild 預設
 *
 * @param guildId Guild ID（DM 時為 null）
 * @param channelId Channel 或 Thread ID
 * @param parentId Thread 的父頻道 ID（非 Thread 時為 null）
 */
export function getChannelAccess(
  guildId: string | null,
  channelId: string,
  parentId?: string | null
): ChannelAccess {
  // DM：不需 mention，禁止 bot（防止 bot 跟 bot 互敲）
  if (!guildId) {
    return {
      allowed: config.discord.dm.enabled,
      requireMention: false,
      allowBot: false,
      allowFrom: [],
    };
  }

  // 沒有任何 guild 設定 → 全開，預設需 mention
  if (Object.keys(config.discord.guilds).length === 0) {
    return { allowed: true, requireMention: true, allowBot: false, allowFrom: [] };
  }

  // 查 guild
  const guild = config.discord.guilds[guildId];
  if (!guild) {
    return { allowed: false, requireMention: true, allowBot: false, allowFrom: [] };
  }

  // Guild 預設值
  const guildDefaults: Required<ChannelConfig> = {
    allow: guild.allow ?? false,
    requireMention: guild.requireMention ?? true,
    allowBot: guild.allowBot ?? false,
    allowFrom: guild.allowFrom ?? [],
  };

  // 繼承鏈查找：channelId → parentId → guild 預設
  const channels = guild.channels ?? {};
  const channelCfg = channels[channelId];
  const parentCfg = parentId ? channels[parentId] : undefined;

  return {
    allowed: channelCfg?.allow ?? parentCfg?.allow ?? guildDefaults.allow,
    requireMention: channelCfg?.requireMention ?? parentCfg?.requireMention ?? guildDefaults.requireMention,
    allowBot: channelCfg?.allowBot ?? parentCfg?.allowBot ?? guildDefaults.allowBot,
    allowFrom: channelCfg?.allowFrom ?? parentCfg?.allowFrom ?? guildDefaults.allowFrom,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

/** 全域設定（可被 hot-reload 替換） */
export let config: BridgeConfig = loadConfig();

// ── Hot-Reload ──────────────────────────────────────────────────────────────

/**
 * 重新載入 config.json，替換全域 config 物件
 * token 變更時不套用（需要重啟 Discord Gateway）
 */
function reloadConfig(): void {
  try {
    const newConfig = loadConfig();

    // token 變更需要重啟，hot-reload 無法處理
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

/**
 * 監聽 catclaw.json 變動，自動 hot-reload
 * 使用 debounce 避免編輯過程中的多次觸發
 */
export function watchConfig(): void {
  const configPath = resolveConfigPath();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    watch(configPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        log.info("[config] 偵測到 config.json 變動，重新載入...");
        reloadConfig();
      }, 500);
    });
    log.info("[config] 已啟動 config.json 監聽（hot-reload）");
  } catch (err) {
    log.warn(`[config] 無法監聽 config.json：${err instanceof Error ? err.message : String(err)}`);
  }
}
