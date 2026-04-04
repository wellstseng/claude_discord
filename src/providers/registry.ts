/**
 * @file providers/registry.ts
 * @description Provider 註冊表 — 初始化、解析路由、取得 Provider 實例
 *
 * 支援兩種建立方式：
 *   V1（舊）：buildProviderRegistry(defaultId, entries, routing)
 *   V2（新）：buildProviderRegistryV2(agentDefaults, modelsJson, authStore, routing)
 *
 * 路由優先序：
 *   1. 頻道綁定（channels.{channelId}）
 *   2. 專案綁定（projects.{projectId}）
 *   3. 角色綁定（roles.{role}）
 *   4. 全域預設（defaultProvider）
 */

import { log } from "../logger.js";
import type { LLMProvider } from "./base.js";
import type {
  ProviderEntry, ProviderRoutingConfig,
  AgentDefaultsConfig, ModelsJsonConfig, ModelApi,
} from "../core/config.js";
import { buildFailoverProvider } from "./failover-provider.js";
import { parseModelRef, formatModelRef, type ModelRef } from "./model-ref.js";
import type { AuthProfileStore } from "./auth-profile-store.js";
import type { ModelAliasEntry } from "../core/config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ResolveOpts {
  channelId?: string;
  projectId?: string;
  role?: string;
}

// ── ProviderRegistry ──────────────────────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private defaultId: string;
  private routing: ProviderRoutingConfig;
  private aliases?: Record<string, ModelAliasEntry>;

  constructor(defaultId: string, routing: ProviderRoutingConfig, aliases?: Record<string, ModelAliasEntry>) {
    this.defaultId = defaultId;
    this.routing = routing;
    this.aliases = aliases;
  }

  // ── 註冊 ─────────────────────────────────────────────────────────────────────

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    log.debug(`[provider-registry] 已註冊 ${provider.id}`);
  }

  // ── alias 解析 ──────────────────────────────────────────────────────────────

  /** 將 id（可能是 alias、provider/model、或直接 key）解析為 registry key */
  private resolveId(id: string): string {
    // 直接命中
    if (this.providers.has(id)) return id;
    // alias 解析
    if (this.aliases) {
      const ref = parseModelRef(id, this.aliases);
      if (ref) {
        const full = formatModelRef(ref);
        if (this.providers.has(full)) return full;
      }
    }
    return id;
  }

  // ── 路由解析 ─────────────────────────────────────────────────────────────────

  resolve(opts: ResolveOpts = {}): LLMProvider {
    const { channelId, projectId, role } = opts;

    const candidateIds = [
      channelId && this.routing.channels?.[channelId],
      projectId && this.routing.projects?.[projectId],
      role && this.routing.roles?.[role],
      this.defaultId,
    ].filter(Boolean) as string[];

    for (const raw of candidateIds) {
      const id = this.resolveId(raw);
      const p = this.providers.get(id);
      if (p) return p;
    }

    throw new Error(`[provider-registry] 無可用 provider（defaultId=${this.defaultId}）`);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(this.resolveId(id));
  }

  list(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  // ── 生命週期 ─────────────────────────────────────────────────────────────────

  async initAll(): Promise<void> {
    for (const p of this.providers.values()) {
      if (p.init) {
        try { await p.init(); }
        catch (err) {
          log.warn(`[provider-registry] ${p.id} init 失敗：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const p of this.providers.values()) {
      if (p.shutdown) {
        try { await p.shutdown(); }
        catch { /* 靜默 */ }
      }
    }
  }
}

// ── ModelApi → Provider type 對應 ────────────────────────────────────────────

function apiToProviderType(api: ModelApi | undefined, provider: string): "claude" | "openai-compat" | "codex-oauth" | "ollama" | null {
  switch (api) {
    case "anthropic-messages": return "claude";
    case "openai-completions": return "openai-compat";
    case "openai-codex-responses": return "codex-oauth";
    case "ollama": return "ollama";
    default:
      // 從 provider 名稱推斷
      if (provider === "anthropic") return "claude";
      if (provider === "openai") return "openai-compat";
      if (provider === "openai-codex") return "codex-oauth";
      if (provider === "ollama" || provider.startsWith("ollama-")) return "ollama";
      return null;
  }
}

// ── V2 工廠：從 agentDefaults + models.json + authStore 建立 ────────────────

/**
 * V2 工廠：從三層分離的設定建立 ProviderRegistry。
 *
 * 流程：
 * 1. 解析 agentDefaults.models 取得要啟用的 model ref
 * 2. 從 models.json 取得 provider 連線資訊
 * 3. 從 authStore 取得 credential
 * 4. 建立對應的 Provider 實例
 */
export async function buildProviderRegistryV2(
  agentDefaults: AgentDefaultsConfig,
  modelsJson: ModelsJsonConfig,
  authStore: AuthProfileStore | null,
  routing: ProviderRoutingConfig,
): Promise<ProviderRegistry> {
  const aliases = agentDefaults.models;

  // 解析 primary model
  const primaryRaw = agentDefaults.model?.primary;
  if (!primaryRaw) {
    throw new Error("[provider-registry-v2] agentDefaults.model.primary 未設定");
  }
  const primaryRef = parseModelRef(primaryRaw, aliases);
  if (!primaryRef) {
    const available = aliases ? Object.values(aliases).map(e => e.alias).filter(Boolean).join(", ") : "(none)";
    throw new Error(`[provider-registry-v2] 無法解析 primary model: ${primaryRaw}（可用別名：${available}）`);
  }

  // 收集所有要建立的 model ref（primary + fallbacks + models 表中所有 key）
  const modelRefs: ModelRef[] = [primaryRef];
  for (const fb of agentDefaults.model?.fallbacks ?? []) {
    const ref = parseModelRef(fb, aliases);
    if (ref) modelRefs.push(ref);
    else log.warn(`[provider-registry-v2] 無法解析 fallback model: ${fb}`);
  }
  // 額外從 models 表中補充（可能有 routing 用到的）
  if (aliases) {
    for (const key of Object.keys(aliases)) {
      const ref = parseModelRef(key, aliases);
      if (ref && !modelRefs.some(r => r.provider === ref.provider && r.model === ref.model)) {
        modelRefs.push(ref);
      }
    }
  }

  // 按 provider 分組，每個 provider 建一個 LLMProvider
  const byProvider = new Map<string, ModelRef[]>();
  for (const ref of modelRefs) {
    const existing = byProvider.get(ref.provider) ?? [];
    existing.push(ref);
    byProvider.set(ref.provider, existing);
  }

  // defaultId = primary 的 "provider/model" 格式
  const defaultId = formatModelRef(primaryRef);
  const registry = new ProviderRegistry(defaultId, routing, aliases ?? undefined);

  for (const [providerName, refs] of byProvider) {
    const providerDef = modelsJson.providers[providerName];
    if (!providerDef) {
      log.warn(`[provider-registry-v2] models.json 中找不到 provider: ${providerName}`);
      continue;
    }

    const pType = apiToProviderType(providerDef.api, providerName);

    // 為這個 provider 的每個 model 建立 LLMProvider
    for (const ref of refs) {
      const modelDef = providerDef.models.find(m => m.id === ref.model);
      if (!modelDef) {
        log.warn(`[provider-registry-v2] models.json 中找不到 model: ${ref.provider}/${ref.model}`);
        continue;
      }

      const providerId = formatModelRef(ref);
      let provider: LLMProvider | null = null;

      // 建立相容的 ProviderEntry（橋接用，讓現有 Provider 建構子能用）
      const bridgeEntry: ProviderEntry = {
        model: ref.model,
        baseUrl: providerDef.baseUrl,
      };

      if (pType === "claude") {
        // credential 從 authStore 取
        const pick = authStore?.pickForProvider("anthropic");
        if (pick) {
          bridgeEntry.token = pick.apiKey;
          bridgeEntry.mode = "api";
        } else if (providerDef.apiKey) {
          bridgeEntry.token = providerDef.apiKey;
          bridgeEntry.mode = "api";
        }
        const { ClaudeApiProvider } = await import("./claude-api.js");
        provider = new ClaudeApiProvider(providerId, bridgeEntry);
      } else if (pType === "ollama") {
        bridgeEntry.type = "ollama";
        bridgeEntry.host = providerDef.baseUrl;
        const { OllamaProvider } = await import("./ollama.js");
        provider = new OllamaProvider(providerId, bridgeEntry);
        if (provider.init) await provider.init();
      } else if (pType === "openai-compat") {
        bridgeEntry.type = "openai-compat";
        const pick = authStore?.pickForProvider(providerName);
        if (pick) bridgeEntry.token = pick.apiKey;
        else if (providerDef.apiKey) bridgeEntry.token = providerDef.apiKey;
        const { OpenAICompatProvider } = await import("./openai-compat.js");
        provider = new OpenAICompatProvider(providerId, bridgeEntry);
        if (provider.init) await provider.init();
      } else if (pType === "codex-oauth") {
        bridgeEntry.type = "codex-oauth";
        const { CodexOAuthProvider } = await import("./codex-oauth.js");
        provider = new CodexOAuthProvider(providerId, bridgeEntry);
      } else {
        log.warn(`[provider-registry-v2] 未知 provider type: ${providerName}（api=${providerDef.api}）`);
        continue;
      }

      if (provider) registry.register(provider);
    }
  }

  // Failover 鏈
  const failoverChain = routing.failoverChain;
  if (failoverChain && failoverChain.length > 0) {
    const chainProviders: LLMProvider[] = [];
    for (const raw of failoverChain) {
      // failoverChain 值可以是 model-ref 格式
      const ref = parseModelRef(raw, aliases);
      const id = ref ? formatModelRef(ref) : raw;
      const p = registry.get(id);
      if (p) chainProviders.push(p);
      else log.warn(`[provider-registry-v2] failoverChain 中找不到 provider: ${id}`);
    }
    if (chainProviders.length > 0) {
      const failover = buildFailoverProvider("failover", chainProviders, routing.circuitBreaker);
      registry.register(failover);
      log.info(`[provider-registry-v2] 已建立 failover 鏈：${chainProviders.map(p => p.id).join("→")}`);
    }
  }

  return registry;
}

// ── V1 工廠：從 config 建立 ProviderRegistry（舊格式相容）────────────────────

export async function buildProviderRegistry(
  defaultId: string,
  entries: Record<string, ProviderEntry>,
  routing: ProviderRoutingConfig
): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry(defaultId, routing);

  for (const [id, entry] of Object.entries(entries)) {
    let provider: LLMProvider | null = null;

    // 型別解析優先序：entry.type > wsUrl > id heuristic > field heuristic
    let providerType: "claude-oauth" | "openai-compat" | "codex-oauth" | "openclaw" | "ollama" | null = null;
    if (entry.type === "claude")        providerType = "claude-oauth";
    else if (entry.type === "openai")   providerType = "openai-compat";
    else if (entry.type)                providerType = entry.type;
    else if (entry.wsUrl)               providerType = "openclaw";
    else if (id === "claude" || id === "claude-api" || id === "claude-oauth") providerType = "claude-oauth";
    else if (id === "ollama" || id.startsWith("ollama-")) providerType = "ollama";
    else if (id === "openai" || id.startsWith("gpt") || id.startsWith("openai-")) providerType = "openai-compat";
    else if (entry.host || entry.baseUrl) providerType = "openai-compat";
    else if (entry.token)               providerType = "claude-oauth";

    if (providerType === "codex-oauth") {
      const { CodexOAuthProvider } = await import("./codex-oauth.js");
      provider = new CodexOAuthProvider(id, entry);
    } else if (providerType === "claude-oauth") {
      const { ClaudeApiProvider } = await import("./claude-api.js");
      provider = new ClaudeApiProvider(id, entry);
    } else if (providerType === "ollama") {
      const { OllamaProvider } = await import("./ollama.js");
      provider = new OllamaProvider(id, entry);
      if (provider.init) await provider.init();
    } else if (providerType === "openai-compat") {
      const { OpenAICompatProvider } = await import("./openai-compat.js");
      provider = new OpenAICompatProvider(id, entry);
      if (provider.init) await provider.init();
    } else if (providerType === "openclaw") {
      log.debug(`[provider-registry] openclaw provider ${id} 暫不初始化（S8 實作）`);
    }

    if (provider) registry.register(provider);
  }

  // Failover 鏈
  const failoverChain = routing.failoverChain;
  if (failoverChain && failoverChain.length > 0) {
    const chainProviders: LLMProvider[] = [];
    for (const id of failoverChain) {
      const p = registry.get(id);
      if (p) chainProviders.push(p);
      else log.warn(`[provider-registry] failoverChain 中找不到 provider: ${id}，已略過`);
    }
    if (chainProviders.length > 0) {
      const failover = buildFailoverProvider("failover", chainProviders, routing.circuitBreaker);
      registry.register(failover);
      log.info(`[provider-registry] 已建立 failover 鏈：${chainProviders.map(p => p.id).join("→")}`);
    }
  }

  return registry;
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _registry: ProviderRegistry | null = null;

export function initProviderRegistry(registry: ProviderRegistry): ProviderRegistry {
  _registry = registry;
  return _registry;
}

export function getProviderRegistry(): ProviderRegistry {
  if (!_registry) throw new Error("[provider-registry] 尚未初始化，請先呼叫 initProviderRegistry()");
  return _registry;
}

export function resetProviderRegistry(): void {
  _registry = null;
}
