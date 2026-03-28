/**
 * @file providers/registry.ts
 * @description Provider 註冊表 — 初始化、解析路由、取得 Provider 實例
 *
 * 路由優先序：
 *   1. 頻道綁定（channels.{channelId}）
 *   2. 專案綁定（projects.{projectId}）
 *   3. 角色綁定（roles.{role}）
 *   4. 全域預設（defaultProvider）
 */

import { log } from "../logger.js";
import type { LLMProvider } from "./base.js";
import type { ProviderEntry, ProviderRoutingConfig } from "../core/config.js";

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

  constructor(defaultId: string, routing: ProviderRoutingConfig) {
    this.defaultId = defaultId;
    this.routing = routing;
  }

  // ── 註冊 ─────────────────────────────────────────────────────────────────────

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    log.debug(`[provider-registry] 已註冊 ${provider.id}`);
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

    for (const id of candidateIds) {
      const p = this.providers.get(id);
      if (p) return p;
    }

    throw new Error(`[provider-registry] 無可用 provider（defaultId=${this.defaultId}）`);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
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

// ── 工廠：從 config 建立 ProviderRegistry ────────────────────────────────────

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
    if (entry.type)               providerType = entry.type;
    else if (entry.wsUrl)         providerType = "openclaw";
    else if (id === "claude-api" || id === "claude-oauth") providerType = "claude-oauth";
    else if (id === "ollama" || id.startsWith("ollama-")) providerType = "ollama";
    else if (entry.host || entry.baseUrl) providerType = "openai-compat";
    else if (entry.token)         providerType = "claude-oauth";  // 無 baseUrl → 預設 Anthropic

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
