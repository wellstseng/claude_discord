/**
 * @file providers/models-config.ts
 * @description models.json 產生與載入 — 模型目錄管理
 *
 * models.json 包含所有 provider 的連線資訊和模型定義。
 * 來源：
 * 1. 內建目錄（主流 provider：Anthropic、OpenAI、Ollama）
 * 2. catclaw.json modelsConfig.providers 自訂覆寫
 *
 * 產生時機：啟動時（initPlatform）
 * 位置：{CATCLAW_WORKSPACE}/agents/default/models.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger.js";
import type { ModelsJsonConfig, ModelProviderDefinition, ModelsConfig } from "../core/config.js";

// ── 內建模型目錄 ─────────────────────────────────────────────────────────────

const BUILTIN_PROVIDERS: Record<string, ModelProviderDefinition> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        contextWindow: 200000,
        maxTokens: 16000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-sonnet-4-5-20250514",
        name: "Claude Sonnet 4.5",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  },
  "openai-codex": {
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4 (Codex)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  },
};

// ── 產生 models.json ─────────────────────────────────────────────────────────

/**
 * 產生或更新 models.json。
 *
 * @param workspaceDir - CATCLAW_WORKSPACE 目錄
 * @param modelsConfig - catclaw.json 的 modelsConfig 區塊
 * @returns models.json 的完整路徑
 */
export function ensureModelsJson(workspaceDir: string, modelsConfig?: ModelsConfig): string {
  const agentDir = join(workspaceDir, "agents", "default");
  const modelsJsonPath = join(agentDir, "models.json");

  mkdirSync(agentDir, { recursive: true });

  const mode = modelsConfig?.mode ?? "merge";
  let providers: Record<string, ModelProviderDefinition>;

  if (mode === "replace") {
    // replace：只用自訂
    providers = modelsConfig?.providers ?? {};
  } else {
    // merge：內建 + 自訂合併（自訂優先）
    providers = { ...BUILTIN_PROVIDERS };
    if (modelsConfig?.providers) {
      for (const [id, def] of Object.entries(modelsConfig.providers)) {
        if (providers[id]) {
          // 合併：自訂 models 追加到內建，baseUrl/api 覆寫
          providers[id] = {
            baseUrl: def.baseUrl ?? providers[id].baseUrl,
            api: def.api ?? providers[id].api,
            apiKey: def.apiKey ?? providers[id].apiKey,
            models: [...providers[id].models, ...def.models],
          };
        } else {
          providers[id] = def;
        }
      }
    }
  }

  const modelsJson: ModelsJsonConfig = { providers };
  const content = JSON.stringify(modelsJson, null, 2);

  // 比對現有檔案，相同就不寫
  if (existsSync(modelsJsonPath)) {
    try {
      const existing = readFileSync(modelsJsonPath, "utf-8");
      if (existing === content) {
        log.debug("[models-config] models.json 無變更，跳過");
        return modelsJsonPath;
      }
    } catch { /* 讀取失敗就重寫 */ }
  }

  // Atomic write
  const tmp = `${modelsJsonPath}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, modelsJsonPath);
  log.info(`[models-config] 已更新 models.json（${Object.keys(providers).length} 個 provider）`);

  return modelsJsonPath;
}

// ── 載入 models.json ─────────────────────────────────────────────────────────

let _modelsJson: ModelsJsonConfig | null = null;
let _modelsJsonPath: string | null = null;

export function loadModelsJson(workspaceDir: string): ModelsJsonConfig {
  const modelsJsonPath = join(workspaceDir, "agents", "default", "models.json");
  if (_modelsJson && _modelsJsonPath === modelsJsonPath) return _modelsJson;

  if (!existsSync(modelsJsonPath)) {
    throw new Error(`[models-config] models.json 不存在：${modelsJsonPath}（請先呼叫 ensureModelsJson）`);
  }

  const raw = readFileSync(modelsJsonPath, "utf-8");
  _modelsJson = JSON.parse(raw) as ModelsJsonConfig;
  _modelsJsonPath = modelsJsonPath;
  return _modelsJson;
}

/**
 * 從 models.json 查找 provider + model。
 */
export function findModelDefinition(
  modelsJson: ModelsJsonConfig,
  provider: string,
  modelId: string,
): { providerDef: ModelProviderDefinition; model: import("../core/config.js").ModelDefinition } | null {
  const providerDef = modelsJson.providers[provider];
  if (!providerDef) return null;
  const model = providerDef.models.find(m => m.id === modelId);
  if (!model) return null;
  return { providerDef, model };
}

/**
 * 列出所有可用的 provider/model 組合。
 */
export function listAllModels(modelsJson: ModelsJsonConfig): Array<{ provider: string; model: string; name: string }> {
  const result: Array<{ provider: string; model: string; name: string }> = [];
  for (const [provider, def] of Object.entries(modelsJson.providers)) {
    for (const model of def.models) {
      result.push({ provider, model: model.id, name: model.name });
    }
  }
  return result;
}

export function resetModelsJsonCache(): void {
  _modelsJson = null;
  _modelsJsonPath = null;
}
