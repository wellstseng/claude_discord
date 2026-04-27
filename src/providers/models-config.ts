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
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { log } from "../logger.js";
import type { ModelsJsonConfig, ModelProviderDefinition, ModelsConfig, ModelDefinition } from "../core/config.js";

// ── 內建模型目錄（動態從 pi-ai 抽）───────────────────────────────────────────
//
// 啟動時呼叫 buildBuiltinProviders()，把 pi-ai 全部 provider × 全部 model 攤平到 models.json。
// pi-ai 升版重啟就自動帶新 provider / 新 model。
// catclaw 沒對應 LLMProvider impl 的 api，registry build 時會 skip，但清單還是會出現。

function buildBuiltinProviders(): Record<string, ModelProviderDefinition> {
  const result: Record<string, ModelProviderDefinition> = {};

  for (const providerName of getProviders()) {
    const piModels = getModels(providerName);
    if (piModels.length === 0) continue;

    const first = piModels[0]!;
    result[providerName] = {
      baseUrl: first.baseUrl,
      api: first.api,
      models: piModels.map(m => ({
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        input: m.input as Array<"text" | "image">,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    };
  }

  log.debug(`[models-config] 從 pi-ai 抽取 ${Object.keys(result).length} 個 provider`);
  return result;
}

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
    // merge：內建（從 pi-ai 動態抽）+ 自訂合併（自訂優先）
    providers = buildBuiltinProviders();
    if (modelsConfig?.providers) {
      for (const [id, def] of Object.entries(modelsConfig.providers)) {
        if (providers[id]) {
          // 合併：自訂 models 覆寫內建（同 id 自訂優先），baseUrl/api 覆寫
          const byId = new Map<string, ModelDefinition>();
          for (const m of providers[id].models) byId.set(m.id, m);
          for (const m of def.models) byId.set(m.id, m);  // 自訂覆寫
          providers[id] = {
            baseUrl: def.baseUrl ?? providers[id].baseUrl,
            api: def.api ?? providers[id].api,
            apiKey: def.apiKey ?? providers[id].apiKey,
            models: Array.from(byId.values()),
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
