/**
 * @file ollama/client.ts
 * @description Dual-backend Ollama client — TypeScript port of tools/ollama_client.py
 *
 * Primary (rdchat) → Fallback (local) 自動切換，三階段退避：
 *   normal → short_die (60s cooldown) → long_die (等到下個 6h 時間段)
 *
 * 方法：
 *   generate(prompt, opts) — /api/chat，支援 think mode
 *   chat(messages, opts)   — /api/chat，think=false（reranker/conflict 用）
 *   embed(texts, opts)     — /api/embed（原生）或 /api/v1/embeddings（OWU proxy）
 *   isAvailable(need)      — 確認至少一個 backend 可用
 */

import { log } from "../logger.js";
import type { OllamaConfig } from "../core/config.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const HEALTH_TTL_MS    = 60_000;   // health check 快取有效期
const SHORT_DIE_MS     = 60_000;   // short_die cooldown
const LONG_DIE_WINDOW  = 600_000;  // 10 分鐘內 2 次 short_die → long_die
const TIME_BOUNDARIES  = [0, 6, 12, 18]; // 6h 時間段邊界（小時）

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface OllamaBackend {
  name: string;
  host: string;          // e.g. "http://localhost:11434"
  model: string;
  embeddingModel?: string;
  priority: number;
  enabled: boolean;
  thinkMode: boolean;    // 此 backend 預設是否啟用 thinking
  numPredict: number;
}

interface BackendState {
  status: "normal" | "short_die" | "long_die";
  consecutiveFailures: number;
  lastFailureAt: number;
  shortDieCount: number;
  firstShortDieAt: number;
  longDieUntil: number;
}

export interface GenerateOpts {
  model?: string;
  timeout?: number;
  think?: boolean | "auto";
  numPredict?: number;
  format?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  model?: string;
  timeout?: number;
  system?: string;
}

export interface EmbedOpts {
  model?: string;
  timeout?: number;
}

// ── 工具函式 ──────────────────────────────────────────────────────────────────

/** 計算下一個 6h 時間段的 timestamp */
function nextTimeBoundary(): number {
  const now = new Date();
  const nowH = now.getHours();
  for (const h of TIME_BOUNDARIES) {
    if (h > nowH) {
      const t = new Date(now);
      t.setHours(h, 0, 0, 0);
      return t.getTime();
    }
  }
  // 已過最後邊界 → 明天 00:00
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

// ── OllamaClient ─────────────────────────────────────────────────────────────

export class OllamaClient {
  private readonly backends: OllamaBackend[];
  private readonly states = new Map<string, BackendState>();
  private readonly healthCache = new Map<string, { healthy: boolean; ts: number }>();
  readonly defaultEmbedTimeoutMs: number;

  constructor(backends: OllamaBackend[], opts: { embedTimeoutMs?: number } = {}) {
    this.backends = [...backends].sort((a, b) => a.priority - b.priority);
    this.defaultEmbedTimeoutMs = opts.embedTimeoutMs ?? 60_000;
  }

  // ── 公開 API ───────────────────────────────────────────────────────────────

  /**
   * LLM 文字生成（/api/chat）
   * think="auto"：依 backend 設定決定（rdchat=true, local=false）
   */
  async generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
    const { model, timeout = 120_000, think = false, numPredict, format } = opts;
    const backend = this.pickBackend("llm");
    if (!backend) return "";

    const effectiveThink = think === "auto" ? backend.thinkMode : think;
    const payload: Record<string, unknown> = {
      model: model ?? backend.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: effectiveThink,
    };
    if (format) payload["format"] = format;
    const options: Record<string, unknown> = {};
    if (numPredict !== undefined) options["num_predict"] = numPredict;
    else if (think === "auto") options["num_predict"] = backend.numPredict;
    if (Object.keys(options).length) payload["options"] = options;

    const result = await this.requestWithFailover("llm", "/api/chat", payload, timeout, { explicitModel: model, autoThink: think === "auto" });
    return (result?.message as { content?: string } | undefined)?.content ?? "";
  }

  /**
   * 多輪對話（/api/chat），think 固定 false
   * 適合 reranker、衝突偵測等短 prompt 場景
   */
  async chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
    const { model, timeout = 30_000, system } = opts;
    const backend = this.pickBackend("llm");
    if (!backend) return "";

    const msgs: ChatMessage[] = [];
    if (system) msgs.push({ role: "system", content: system });
    msgs.push(...messages);

    const payload = {
      model: model ?? backend.model,
      messages: msgs,
      stream: false,
      think: false,
    };
    const result = await this.requestWithFailover("llm", "/api/chat", payload, timeout, { explicitModel: model });
    return (result?.message as { content?: string } | undefined)?.content ?? "";
  }

  /**
   * Embedding（/api/embed 原生 Ollama）
   * 失敗回傳空陣列
   */
  async embed(texts: string[], opts: EmbedOpts = {}): Promise<number[][]> {
    const { model, timeout = this.defaultEmbedTimeoutMs } = opts;
    const backend = this.pickBackend("embedding");
    if (!backend) return [];

    const payload = {
      model: model ?? backend.embeddingModel ?? backend.model,
      input: texts,
    };
    const result = await this.requestWithFailover("embedding", "/api/embed", payload, timeout, { explicitModel: model });
    return (result?.embeddings as number[][] | undefined) ?? [];
  }

  /** 確認是否至少有一個可用 backend */
  isAvailable(need: "llm" | "embedding" = "llm"): boolean {
    return this.pickBackend(need) !== null;
  }

  // ── Backend 選擇（三階段退避）──────────────────────────────────────────────

  private pickBackend(need: "llm" | "embedding", exclude = new Set<string>()): OllamaBackend | null {
    const now = Date.now();

    for (const b of this.backends) {
      if (!b.enabled || exclude.has(b.name)) continue;
      if (need === "embedding" && !b.embeddingModel) continue;

      const state = this.getState(b);

      if (state.status === "long_die") {
        if (now < state.longDieUntil) continue;
        log.info(`[ollama] ${b.name} long_die 到期，恢復 normal`);
        this.resetState(b);
      }

      if (state.status === "short_die") {
        if ((now - state.lastFailureAt) < SHORT_DIE_MS) continue;
        // cooldown 過了，給機會再試
      }

      // Health check（快取 60s）
      const cached = this.healthCache.get(b.name);
      if (cached && (now - cached.ts) < HEALTH_TTL_MS) {
        if (cached.healthy) return b;
        continue;
      }

      // 實際 health check（同步用 fetch，async 包裝）
      // 在 pickBackend 同步方法中用快取優先，無快取時先樂觀嘗試
      return b; // 交給 requestWithFailover 在失敗後記錄
    }
    return null;
  }

  // ── HTTP 請求 ────────────────────────────────────────────────────────────

  private async requestWithFailover(
    need: "llm" | "embedding",
    endpoint: string,
    payload: Record<string, unknown>,
    timeout: number,
    opts: { explicitModel?: string; autoThink?: boolean } = {}
  ): Promise<Record<string, unknown> | null> {
    const tried = new Set<string>();

    while (true) {
      const backend = this.pickBackend(need, tried);
      if (!backend) return null;
      tried.add(backend.name);

      // 調整 model + think per backend（failover 時切換到正確 model）
      const actual = { ...payload };
      if (!opts.explicitModel) {
        const modelField = need === "embedding" ? (backend.embeddingModel ?? backend.model) : backend.model;
        actual["model"] = modelField;
      }
      if (opts.autoThink) {
        actual["think"] = backend.thinkMode;
        actual["options"] = { ...(actual["options"] as object ?? {}), num_predict: backend.numPredict };
      }

      const result = await this.doRequest(backend, endpoint, actual, timeout);
      if (result !== null) {
        this.recordSuccess(backend);
        return result;
      }
      this.recordFailure(backend);
    }
  }

  private async doRequest(
    backend: OllamaBackend,
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown> | null> {
    const url = backend.host.replace(/\/$/, "") + endpoint;

    const controller = new AbortController();
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; controller.abort(); }, timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        log.warn(`[ollama] ${backend.name} HTTP ${resp.status} ${endpoint}`);
        return null;
      }
      return await resp.json() as Record<string, unknown>;
    } catch (err) {
      const msg = timerFired
        ? `timeout(${timeoutMs}ms)`
        : (err instanceof Error ? err.message : String(err));
      log.warn(`[ollama] ${backend.name} ${endpoint} 失敗：${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Health check GET /api/tags */
  async checkHealth(backend: OllamaBackend): Promise<boolean> {
    const url = backend.host.replace(/\/$/, "") + "/api/tags";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      const healthy = resp.ok;
      this.healthCache.set(backend.name, { healthy, ts: Date.now() });
      return healthy;
    } catch {
      this.healthCache.set(backend.name, { healthy: false, ts: Date.now() });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 狀態管理 ──────────────────────────────────────────────────────────────

  private getState(b: OllamaBackend): BackendState {
    if (!this.states.has(b.name)) {
      this.states.set(b.name, {
        status: "normal",
        consecutiveFailures: 0,
        lastFailureAt: 0,
        shortDieCount: 0,
        firstShortDieAt: 0,
        longDieUntil: 0,
      });
    }
    return this.states.get(b.name)!;
  }

  private resetState(b: OllamaBackend): void {
    this.states.set(b.name, {
      status: "normal",
      consecutiveFailures: 0,
      lastFailureAt: 0,
      shortDieCount: 0,
      firstShortDieAt: 0,
      longDieUntil: 0,
    });
  }

  private recordSuccess(b: OllamaBackend): void {
    const state = this.getState(b);
    if (state.status !== "normal") log.info(`[ollama] ${b.name} 恢復 normal`);
    this.resetState(b);
    this.healthCache.set(b.name, { healthy: true, ts: Date.now() });
  }

  private recordFailure(b: OllamaBackend): void {
    const now = Date.now();
    const state = this.getState(b);
    state.consecutiveFailures++;
    state.lastFailureAt = now;
    this.healthCache.set(b.name, { healthy: false, ts: now });

    if (state.consecutiveFailures >= 2 && state.status === "normal") {
      state.status = "short_die";
      state.shortDieCount++;
      if (!state.firstShortDieAt) state.firstShortDieAt = now;
      log.info(`[ollama] ${b.name} → short_die (#${state.shortDieCount})`);
      this.maybeEscalateToLongDie(b, state, now);
    } else if (state.consecutiveFailures >= 2 && state.status === "short_die") {
      state.shortDieCount++;
      this.maybeEscalateToLongDie(b, state, now);
    }
  }

  private maybeEscalateToLongDie(b: OllamaBackend, state: BackendState, now: number): void {
    if (state.shortDieCount >= 2 && (now - state.firstShortDieAt) <= LONG_DIE_WINDOW) {
      state.status = "long_die";
      state.longDieUntil = nextTimeBoundary();
      const until = new Date(state.longDieUntil).toTimeString().slice(0, 5);
      log.warn(`[ollama] ${b.name} → long_die 直到 ${until}`);
    } else if (state.shortDieCount >= 2) {
      // 10 分鐘窗口過期，重置計數
      state.shortDieCount = 1;
      state.firstShortDieAt = now;
    }
  }
}

// ── 從 catclaw.json OllamaConfig 建立 backends ────────────────────────────────

export function buildBackendsFromConfig(cfg: OllamaConfig): OllamaBackend[] {
  const backends: OllamaBackend[] = [];

  backends.push({
    name: "primary",
    host: cfg.primary.host,
    model: cfg.primary.model,
    embeddingModel: cfg.primary.embeddingModel,
    priority: 1,
    enabled: cfg.enabled,
    thinkMode: cfg.thinkMode,
    numPredict: cfg.numPredict,
  });

  if (cfg.fallback && cfg.failover) {
    backends.push({
      name: "fallback",
      host: cfg.fallback.host,
      model: cfg.fallback.model,
      priority: 2,
      enabled: true,
      thinkMode: false,  // local fallback 不用 think mode
      numPredict: 2048,
    });
  }

  return backends;
}

// ── 單例（由 Platform 初始化後注入，此處提供 lazy init 備用）─────────────────

let _instance: OllamaClient | null = null;

export function getOllamaClient(): OllamaClient {
  if (!_instance) throw new Error("[ollama] OllamaClient 尚未初始化，請先呼叫 initOllamaClient()");
  return _instance;
}

export function initOllamaClient(cfg: OllamaConfig): OllamaClient {
  _instance = new OllamaClient(buildBackendsFromConfig(cfg), { embedTimeoutMs: cfg.timeout });
  log.info(`[ollama] 初始化完成，${_instance["backends"].length} 個 backend，embedTimeout=${_instance.defaultEmbedTimeoutMs}ms`);
  return _instance;
}

export function resetOllamaClient(): void {
  _instance = null;
}
