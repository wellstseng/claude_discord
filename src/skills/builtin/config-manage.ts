/**
 * @file skills/builtin/config-manage.ts
 * @description /config — catclaw.json 讀取與局部修改
 *
 * 子命令：
 *   /config get [path]         — 讀取 config（過濾敏感欄位）
 *   /config schema [path]      — 查欄位說明
 *   /config patch <path> <val> — 局部更新（ownerOnly + 白名單）
 *   /config reload             — 強制重新讀取 catclaw.json（ownerOnly）
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCatclawDir } from "../../core/config.js";

// ── 敏感欄位（任一路徑段命中即拒絕顯示/修改） ────────────────────────────────

const SECRET_SEGMENTS = new Set(["token", "apikey", "secret", "password", "apiKey"]);

function containsSecret(path: string): boolean {
  return path.toLowerCase().split(".").some(seg => SECRET_SEGMENTS.has(seg));
}

// ── 可修改的 path 白名單（前綴匹配，* 表示任意一段） ─────────────────────────

const PATCH_WHITELIST: string[] = [
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
  "showThinking",
  "fileUploadThreshold",
  "memory.recall.vectorSearch",
  "memory.recall.vectorMinScore",
  "memory.recall.vectorTopK",
  "memory.recall.triggerMatch",
  "rateLimit.*.*",
  "ollama.thinkMode",
  "ollama.numPredict",
  "ollama.timeout",
  "agents.*.systemPrompt",
  "providers.*.model",
  "providers.*.think",
  "providers.*.numPredict",
  // V2 三層分離
  "agentDefaults.model.primary",
  "agentDefaults.model.fallbacks",
  "providerRouting.roles.*",
  "providerRouting.channels.*",
  "cron.enabled",
  "cron.maxConcurrentRuns",
  "inboundHistory.inject.enabled",
  "session.ttlHours",
  "session.maxHistoryTurns",
  "session.compactAfterTurns",
  "contextEngineering.enabled",
];

function matchesWhitelist(path: string): boolean {
  const parts = path.split(".");
  return PATCH_WHITELIST.some(pattern => {
    const pats = pattern.split(".");
    if (pats.length !== parts.length) return false;
    return pats.every((p, i) => p === "*" || p === parts[i]);
  });
}

// ── Schema 說明（常用欄位） ───────────────────────────────────────────────────

const SCHEMA_MAP: Record<string, string> = {
  "debounceMs":                         "訊息合併延遲（ms），預設 500",
  "logLevel":                           "日誌等級：debug | info | warn | error",
  "showToolCalls":                      "顯示 tool 呼叫：none | summary | full",
  "showThinking":                       "顯示思考過程：true | false",
  "fileUploadThreshold":                "超過此字數轉 .md 上傳（字元數），預設 4000",
  "discord.guilds.*.allow":            "允許此 guild 使用 bot：true | false",
  "discord.guilds.*.requireMention":   "需要 @mention 才觸發：true | false",
  "discord.guilds.*.allowBot":         "允許 bot 帳號訊息：true | false",
  "discord.guilds.*.allowFrom":        "白名單（空 = 允許所有人）：[\"userId\", ...]",
  "discord.guilds.*.channels.*.allow": "允許此頻道：true | false",
  "discord.guilds.*.channels.*.requireMention": "此頻道需 @mention：true | false",
  "discord.guilds.*.channels.*.allowBot": "此頻道允許 bot：true | false",
  "discord.guilds.*.channels.*.allowFrom": "此頻道白名單：[\"userId\", ...]",
  "memory.recall.vectorSearch":        "啟用向量搜尋：true | false",
  "memory.recall.vectorMinScore":      "向量最低相似度門檻（0-1），預設 0.35",
  "memory.recall.vectorTopK":          "向量搜尋回傳數量，預設 10",
  "memory.recall.triggerMatch":        "啟用 trigger 關鍵詞匹配：true | false",
  "ollama.timeout":                    "Ollama 請求逾時（ms），預設 600000（10分鐘）",
  "ollama.numPredict":                 "Ollama 最大生成 token 數",
  "cron.enabled":                      "啟用 cron 排程：true | false",
  "session.ttlHours":                  "Session 閒置 TTL（小時），預設 168（7天）",
  "session.maxHistoryTurns":           "Session 最大保留輪數",
  "agents.*.systemPrompt":             "Agent 系統提示詞",
  "providers.*.model":                 "Provider 使用的模型名稱",
  // V2 三層分離
  "agentDefaults.model.primary":       "V2 主要模型（alias 或 provider/model 格式）",
  "agentDefaults.model.fallbacks":     "V2 備援模型清單（JSON 陣列）",
  "providerRouting.roles.*":           "角色綁定模型（alias 或 provider/model 格式）",
  "providerRouting.channels.*":        "頻道綁定模型（alias 或 provider/model 格式）",
};

// ── 工具函式 ─────────────────────────────────────────────────────────────────

function configPath(): string {
  return join(resolveCatclawDir(), "catclaw.json");
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
}

/** dot-path 取值 */
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur == null || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

/** dot-path 設值（immutable，回傳新物件） */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
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

/** 遞迴過濾敏感欄位 */
function filterSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 8 || obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_SEGMENTS.has(k.toLowerCase())) {
      result[k] = "***";
    } else {
      result[k] = filterSecrets(v, depth + 1);
    }
  }
  return result;
}

/** 判斷是否為 owner */
function isOwner(authorId: string, raw: Record<string, unknown>): boolean {
  const admin = raw.admin as { allowedUserIds?: string[] } | undefined;
  return admin?.allowedUserIds?.includes(authorId) ?? false;
}

/** JSON pretty，截斷超長輸出 */
function pretty(val: unknown, maxLen = 1800): string {
  const s = JSON.stringify(val, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n…（已截斷）";
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

function handleGet(path: string): SkillResult {
  if (containsSecret(path)) {
    return { text: "❌ 該路徑包含敏感欄位，拒絕顯示。", isError: true };
  }
  const raw = readRaw();
  const val = path ? getPath(raw, path) : raw;
  const filtered = filterSecrets(val);
  const display = pretty(filtered);
  const label = path ? `\`${path}\`` : "catclaw.json";
  return { text: `**Config ${label}**\n\`\`\`json\n${display}\n\`\`\`` };
}

function handleSchema(path: string): SkillResult {
  if (path) {
    // 精確或前綴查找
    const hits = Object.entries(SCHEMA_MAP)
      .filter(([k]) => k === path || k.startsWith(path + "."))
      .map(([k, v]) => `• \`${k}\` — ${v}`);
    if (!hits.length) {
      return { text: `查無 \`${path}\` 的 schema 說明。\n\n可查 \`/config schema\` 看全部。` };
    }
    return { text: `**Schema：\`${path}\`**\n${hits.join("\n")}` };
  }
  // 全部
  const all = Object.entries(SCHEMA_MAP).map(([k, v]) => `• \`${k}\` — ${v}`).join("\n");
  return { text: `**可設定欄位（\`/config patch\` 白名單）**\n${all}` };
}

function handlePatch(args: string, authorId: string): SkillResult {
  const raw = readRaw();

  if (!isOwner(authorId, raw)) {
    return { text: "❌ 需要 owner 權限。", isError: true };
  }

  // 解析 path 和 value（value 可包含空格）
  const firstSpace = args.indexOf(" ");
  if (firstSpace === -1) {
    return { text: "用法：`/config patch <path> <value>`\n例：`/config patch debounceMs 300`", isError: true };
  }
  const path = args.slice(0, firstSpace).trim();
  const rawValue = args.slice(firstSpace + 1).trim();

  if (!path || !rawValue) {
    return { text: "用法：`/config patch <path> <value>`", isError: true };
  }

  if (containsSecret(path)) {
    return { text: "❌ 禁止修改敏感欄位（token/apiKey/secret/password）。", isError: true };
  }

  if (!matchesWhitelist(path)) {
    return { text: `❌ \`${path}\` 不在可修改白名單內。\n\n查閱可改欄位：\`/config schema\``, isError: true };
  }

  // 解析值
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue; // 當字串處理
  }

  const updated = setPath(raw, path, value);
  writeFileSync(configPath(), JSON.stringify(updated, null, 2), "utf-8");

  return { text: `✅ 已更新 \`${path}\` = \`${JSON.stringify(value)}\`\n（hot-reload 已生效，無需重啟）` };
}

function handleReload(authorId: string): SkillResult {
  const raw = readRaw();
  if (!isOwner(authorId, raw)) {
    return { text: "❌ 需要 owner 權限。", isError: true };
  }
  // config.ts 的 watcher 會在 writeFileSync 後自動 reload。
  // 這裡用 touch（讀+寫回）強制觸發 watcher。
  writeFileSync(configPath(), JSON.stringify(raw, null, 2), "utf-8");
  return { text: "🔄 catclaw.json 已重寫，hot-reload 觸發中。" };
}

// ── Skill 定義 ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "config",
  description: "讀取與修改 catclaw.json 設定（get / schema / patch / reload）",
  tier: "admin",
  trigger: ["/config"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const args = ctx.args.trim();
    const [sub, ...rest] = args.split(/\s+/);
    const restStr = rest.join(" ");

    switch (sub) {
      case "get":    return handleGet(restStr);
      case "schema": return handleSchema(restStr);
      case "patch":  return handlePatch(restStr, ctx.authorId);
      case "reload": return handleReload(ctx.authorId);
      default:
        return {
          text: [
            "**`/config` 用法**",
            "• `/config get [path]` — 讀取 config（敏感欄位遮蔽）",
            "• `/config schema [path]` — 查欄位說明與白名單",
            "• `/config patch <path> <value>` — 局部更新（ownerOnly）",
            "• `/config reload` — 強制 hot-reload（ownerOnly）",
            "",
            "例：`/config get memory`",
            "　　`/config patch debounceMs 300`",
            "　　`/config patch discord.guilds.12345.channels.67890.allowBot true`",
          ].join("\n"),
        };
    }
  },
};
