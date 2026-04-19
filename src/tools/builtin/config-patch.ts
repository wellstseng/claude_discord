/**
 * @file tools/builtin/config-patch.ts
 * @description config_patch — 讓 Claude 局部修改 catclaw.json
 *
 * 安全邊界：
 * - 敏感欄位（token/apiKey/secret/password）一律拒絕
 * - 呼叫者 accountId 必須在 admin.allowedUserIds
 * - path 必須在 PATCH_WHITELIST 內
 * - hot-reload 由 config watcher 自動處理，無需重啟
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";
import { resolveCatclawDir } from "../../core/config.js";

const SECRET_SEGMENTS = new Set(["token", "apikey", "secret", "password"]);

function containsSecret(path: string): boolean {
  return path.toLowerCase().split(".").some(seg => SECRET_SEGMENTS.has(seg));
}

const PATCH_WHITELIST = [
  "discord.guilds.*.allow",
  "discord.guilds.*.requireMention",
  "discord.guilds.*.allowBot",
  "discord.guilds.*.allowFrom",
  "discord.guilds.*.channels.*.allow",
  "discord.guilds.*.channels.*.requireMention",
  "discord.guilds.*.channels.*.allowBot",
  "discord.guilds.*.channels.*.allowFrom",
  "discord.dm.enabled",
  "debounceMs",
  "logLevel",
  "showToolCalls",
  "memory.recall.vectorSearch",
  "memory.recall.vectorMinScore",
  "memory.recall.vectorTopK",
  "memory.recall.triggerMatch",
  "rateLimit.*.*",
  // 模型路由已遷移至 models-config.json，由 Dashboard 管理
  "cron.enabled",
  "cron.maxConcurrentRuns",
  "inboundHistory.inject.enabled",
  "session.ttlHours",
  "session.maxHistoryTurns",
  "session.compactAfterTurns",
  "contextEngineering.enabled",
  "contextEngineering.toolBudget.*",
  "contextEngineering.memoryBudget",
  "contextEngineering.strategies.decay.*",
  "contextEngineering.strategies.dedup.*",
  "contextEngineering.strategies.turnSummary.*",
  "contextEngineering.strategies.compaction.*",
  "contextEngineering.strategies.overflowHardStop.*",
  "restartNotify.enabled",
  "restartNotify.showPendingTasks",
];

function matchesWhitelist(path: string): boolean {
  const parts = path.split(".");
  return PATCH_WHITELIST.some(pattern => {
    const pats = pattern.split(".");
    if (pats.length !== parts.length) return false;
    return pats.every((p, i) => p === "*" || p === parts[i]);
  });
}

function cfgPath(): string {
  return join(resolveCatclawDir(), "catclaw.json");
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  const result = { ...obj };
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    cur[key] = { ...(cur[key] as Record<string, unknown> ?? {}) };
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return result;
}

function isOwner(accountId: string, raw: Record<string, unknown>): boolean {
  const admin = raw["admin"] as { allowedUserIds?: string[] } | undefined;
  const ids = admin?.allowedUserIds ?? [];
  // 直接比對 accountId
  if (ids.includes(accountId)) return true;
  // accountId 格式 "discord-owner-{discordUserId}" 或 "guest:{discordUserId}" → 提取 Discord ID 比對
  const match = accountId.match(/(?:discord-owner-|guest:)(\d+)$/);
  if (match && ids.includes(match[1]!)) return true;
  return false;
}

export const tool: Tool = {
  name: "config_patch",
  description: [
    "局部更新 catclaw.json 指定欄位，hot-reload 立即生效，無需重啟。",
    "需要 owner 權限（admin.allowedUserIds）。",
    "可修改的欄位（白名單）：discord guilds/channels 的 allow/requireMention/allowBot/allowFrom；",
    "debounceMs、logLevel、showToolCalls、memory.recall.*、",
    "cron.enabled、session.ttlHours 等。模型路由請用 Dashboard 管理。",
    "禁止修改：token、apiKey、secret、password。",
    "value 為 JSON 格式：字串用引號如 \"\\\"info\\\"\"，布林用 true/false，數字直接傳。",
    "若不確定欄位名稱，先用 config_get 查看當前 config 結構。",
  ].join(" "),
  tier: "admin",
  deferred: true,
  resultTokenCap: 200,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "dot-path，例如 \"debounceMs\" 或 \"discord.guilds.1045175456640544828.channels.1484061896217858178.allowBot\"",
      },
      value: {
        type: "string",
        description: "新的值（JSON 格式）：數字如 300，布林如 true，字串如 \"\\\"info\\\"\"，陣列如 [\"id1\",\"id2\"]",
      },
    },
    required: ["path", "value"],
  },
  async execute(params, ctx) {
    const path   = typeof params["path"]  === "string" ? params["path"].trim()  : "";
    const rawVal = typeof params["value"] === "string" ? params["value"].trim() : "";

    if (!path)  return { error: "path 不可為空" };
    if (!rawVal) return { error: "value 不可為空" };

    if (containsSecret(path)) return { error: "禁止修改敏感欄位（token/apiKey/secret/password）" };
    if (!matchesWhitelist(path)) {
      return { error: `"${path}" 不在可修改白名單。先用 config_get 確認欄位路徑，再查白名單。` };
    }

    let raw: Record<string, unknown>;
    try { raw = readRaw(); } catch (err) {
      return { error: `讀取 config 失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    if (!isOwner(ctx.accountId, raw)) {
      return { error: "需要 owner 權限（admin.allowedUserIds）" };
    }

    let value: unknown;
    try { value = JSON.parse(rawVal); } catch { value = rawVal; }

    try {
      const updated = setNestedPath(raw, path, value);
      writeFileSync(cfgPath(), JSON.stringify(updated, null, 2), "utf-8");
      return { result: { path, value, message: "已更新，hot-reload 生效中" } };
    } catch (err) {
      return { error: `寫入失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
