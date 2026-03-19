/**
 * @file config.ts
 * @description 從 config.json 載入設定，提供 per-channel 存取 helper
 *
 * 設定結構：
 * - discord：Discord 連線、DM、guild/channel 權限（含繼承鏈）
 * - claude：CLI 路徑、工作目錄、timeout、session TTL
 * - 全域：showToolCalls、debounceMs、fileUploadThreshold、logLevel
 *
 * 繼承鏈（getChannelAccess）：
 *   Thread → channels[threadId] → channels[parentId] → Guild 預設
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./logger.js";

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

/** Discord 相關設定 */
export interface DiscordConfig {
  /** Discord Bot Token */
  token: string;
  /** DM 設定 */
  dm: DmConfig;
  /** per-guild、per-channel 設定 */
  guilds: Record<string, GuildConfig>;
}

/** Claude CLI 相關設定 */
export interface ClaudeConfig {
  /** Claude session 工作目錄（spawn cwd），預設 $HOME */
  cwd: string;
  /** claude CLI binary 路徑，預設 "claude" */
  command: string;
  /** Claude 回應超時毫秒數，預設 300000（5 分鐘） */
  turnTimeoutMs: number;
  /** Session 閒置超時（小時），超過此時間不 resume，預設 168（7 天） */
  sessionTtlHours: number;
}

/** 全域設定物件型別 */
export interface BridgeConfig {
  /** Discord 相關設定 */
  discord: DiscordConfig;
  /** Claude CLI 相關設定 */
  claude: ClaudeConfig;
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
}

// ── JSON 載入 ────────────────────────────────────────────────────────────────

/** config.json 的原始 JSON 型別（所有欄位皆可選） */
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
  claude?: {
    cwd?: string;
    command?: string;
    turnTimeoutMs?: number;
    sessionTtlHours?: number;
  };
  showToolCalls?: string | boolean;
  showThinking?: boolean;
  debounceMs?: number;
  fileUploadThreshold?: number;
  logLevel?: string;
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
 * 從 config.json 載入設定
 * @returns 完整的 BridgeConfig 物件
 * @throws 若 config.json 不存在或 token 未設定
 */
function loadConfig(): BridgeConfig {
  const configPath = resolve(process.cwd(), "config.json");

  let raw: RawConfig;
  try {
    const text = readFileSync(configPath, "utf-8");
    // 支援 JSONC：strip 掉 // 註解（整行註解 + 行尾註解）後再 parse
    const stripped = text.replace(/\/\/.*$/gm, "");
    raw = JSON.parse(stripped) as RawConfig;
  } catch (err) {
    throw new Error(
      `無法讀取 config.json（${configPath}）：${err instanceof Error ? err.message : String(err)}\n` +
      "請複製 config.example.json 為 config.json 並填入設定"
    );
  }

  if (!raw.discord?.token) {
    throw new Error("config.json 中 discord.token 欄位必填");
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
    claude: {
      cwd: raw.claude?.cwd || process.env.HOME || "/",
      command: raw.claude?.command || "claude",
      turnTimeoutMs: raw.claude?.turnTimeoutMs ?? 300_000,
      sessionTtlHours: raw.claude?.sessionTtlHours ?? 168,
    },
    showToolCalls: parseShowToolCalls(raw.showToolCalls),
    showThinking: raw.showThinking ?? false,
    debounceMs: raw.debounceMs ?? 500,
    fileUploadThreshold: raw.fileUploadThreshold ?? 4000,
    logLevel,
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

/** 全域設定單例，啟動時載入一次 */
export const config: BridgeConfig = loadConfig();
