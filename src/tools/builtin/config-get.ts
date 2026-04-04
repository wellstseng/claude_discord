/**
 * @file tools/builtin/config-get.ts
 * @description config_get — 讓 Claude 讀取 catclaw 設定（已解析的完整 config）
 *
 * 讀取的是 runtime 合成後的 BridgeConfig（包含 models-config.json 合成的
 * modelRouting / agentDefaults 等），而非原始 catclaw.json。
 * 敏感欄位（token/apiKey/secret/password）自動遮蔽為 ***。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";
import { config, resolveCatclawDir } from "../../core/config.js";

const SECRET_SEGMENTS = new Set(["token", "apikey", "secret", "password"]);

function containsSecret(path: string): boolean {
  return path.toLowerCase().split(".").some(seg => SECRET_SEGMENTS.has(seg));
}

function getNestedPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur == null || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

function filterSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 8 || obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SECRET_SEGMENTS.has(k.toLowerCase()) ? "***" : filterSecrets(v, depth + 1);
  }
  return result;
}

export const tool: Tool = {
  name: "config_get",
  description: [
    "讀取 catclaw 設定（已解析的完整 config，包含 models-config.json 合成結果）。",
    "path 省略則回傳完整 config；指定 dot-path 則回傳該欄位值。",
    "敏感欄位（token/apiKey/secret）自動遮蔽。",
    "特殊路徑：path=\"models-config\" 回傳 models-config.json 原始 JSON（含 aliases/providers/primary/fallbacks）。",
    "常用路徑：path=\"agentDefaults\" 回傳模型設定（含 primary model）；",
    "path=\"agentDefaults.model\" 回傳當前使用的模型 ID；",
    "path=\"modelRouting\" 回傳模型路由規則；",
    "path=\"discord.guilds\" 回傳所有 guild 設定。",
  ].join(" "),
  tier: "admin",
  resultTokenCap: 1000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "dot-path，例如 \"modelRouting\" 或 \"discord.guilds.123.channels\"。省略則回傳完整 config。",
      },
    },
    required: [],
  },
  async execute(params) {
    const path = typeof params["path"] === "string" ? params["path"].trim() : "";
    if (path && containsSecret(path)) {
      return { error: "禁止讀取敏感欄位（token/apiKey/secret/password）" };
    }
    try {
      // 特殊路徑：直接讀取 models-config.json 原始 JSON
      if (path === "models-config") {
        const fp = join(resolveCatclawDir(), "models-config.json");
        if (!existsSync(fp)) return { error: "models-config.json 不存在" };
        const raw = JSON.parse(readFileSync(fp, "utf-8")) as unknown;
        return { result: filterSecrets(raw) };
      }
      const val = path ? getNestedPath(config, path) : config;
      if (val === undefined) return { error: `路徑不存在：${path}` };
      return { result: filterSecrets(val) };
    } catch (err) {
      return { error: `讀取失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
