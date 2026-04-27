/**
 * @file providers/failover-provider.ts
 * @description FailoverProvider — 將多個 provider 組成 failover 鏈
 *
 * 設計：實作 LLMProvider 介面，內部按順序嘗試每個 provider。
 * 整合 CircuitBreaker，自動跳過短路中的 provider。
 *
 * 使用方式：
 *   const failover = new FailoverProvider("failover", [
 *     { provider: claudeProvider, breaker: new CircuitBreaker("claude-api") },
 *     { provider: ollamaProvider, breaker: new CircuitBreaker("ollama") },
 *   ]);
 *   // 對外表現與普通 LLMProvider 完全相同
 */

import type { LLMProvider, Message, ProviderOpts, StreamResult } from "./base.js";
import { CircuitBreaker, type CircuitBreakerConfig, type BreakerStatus } from "./circuit-breaker.js";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface FailoverEntry {
  provider: LLMProvider;
  breaker: CircuitBreaker;
}

export interface FailoverStatus {
  activeProvider: string;
  chain: Array<{ providerId: string; status: BreakerStatus }>;
}

// ── FailoverProvider ──────────────────────────────────────────────────────────

export class FailoverProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private chain: FailoverEntry[];

  constructor(id: string, chain: FailoverEntry[]) {
    if (chain.length === 0) throw new Error("[failover-provider] chain 不能為空");
    this.id   = id;
    this.name = `failover(${chain.map(e => e.provider.id).join("→")})`;
    this.chain = chain;
  }

  // LLMProvider interface

  get modelId(): string | undefined {
    return this.chain[0]?.provider.modelId;
  }

  get supportsToolUse(): boolean {
    // 只要 chain 中有任一 provider 支援 tool use，就回報支援
    return this.chain.some(e => e.provider.supportsToolUse);
  }

  get maxContextTokens(): number {
    // 取第一個可用 provider 的上限
    const active = this.firstAvailable();
    return active?.provider.maxContextTokens ?? 200_000;
  }

  async stream(messages: Message[], opts?: ProviderOpts): Promise<StreamResult> {
    const errors: string[] = [];

    for (const entry of this.chain) {
      const { provider, breaker } = entry;

      if (!breaker.isAvailable()) {
        log.debug(`[failover] 跳過 ${provider.id}（circuit breaker open）`);
        errors.push(`${provider.id}: circuit breaker open`);
        continue;
      }

      // 如果 opts 帶了 abortSignal 且已 abort，直接拋出
      if (opts?.abortSignal?.aborted) {
        throw new Error("aborted");
      }

      try {
        log.debug(`[failover] 嘗試 provider=${provider.id}`);
        const result = await provider.stream(messages, opts);
        breaker.recordSuccess();

        // 非首選 provider 被啟用時提醒
        if (entry !== this.chain[0]) {
          log.warn(`[failover] 使用備援 provider=${provider.id}（primary 不可用）`);
          // ProviderSwitch hook（observer）
          try {
            const { getHookRegistry } = await import("../hooks/hook-registry.js");
            const hookReg = getHookRegistry();
            if (hookReg && hookReg.count("ProviderSwitch") > 0) {
              void hookReg.runProviderSwitch({
                event: "ProviderSwitch",
                fromProvider: this.chain[0].provider.id,
                toProvider: provider.id,
                reason: "failover",
              });
            }
          } catch { /* ignore */ }
        }

        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // AbortError 不算 provider 失敗，直接傳出
        if (msg === "aborted" || opts?.abortSignal?.aborted) throw err;

        // 4xx（非 429）通常是「客戶端參數錯」不該切 fallback；
        // 但 quota / billing 類錯誤（402、out of extra usage 等）雖然 HTTP 400-403，
        // 實質是 provider 不可用，必須走 failover 切下個 provider
        const lowerMsg = msg.toLowerCase();
        const isQuotaExhausted = lowerMsg.includes("out of extra usage")
          || lowerMsg.includes("extra usage")
          || lowerMsg.includes("insufficient_quota")
          || lowerMsg.includes("payment_required")
          || lowerMsg.includes("billing")
          || lowerMsg.includes("credit");
        const statusMatch = msg.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;
        if (status >= 400 && status < 500 && status !== 429 && !isQuotaExhausted) {
          log.debug(`[failover] ${provider.id} 4xx 錯誤（${status}），非 quota/billing，不觸發 circuit breaker`);
          throw err; // 非 provider 故障，直接傳播
        }

        breaker.recordFailure();
        errors.push(`${provider.id}: ${msg}`);
        log.warn(`[failover] ${provider.id} 失敗${isQuotaExhausted ? "（quota/billing 用罄）" : ""}，嘗試下一個 provider。錯誤：${msg}`);
      }
    }

    throw new Error(`[failover] 所有 provider 均失敗：${errors.join(" | ")}`);
  }

  async init(): Promise<void> {
    for (const { provider } of this.chain) {
      if (provider.init) {
        try { await provider.init(); }
        catch (err) {
          log.warn(`[failover] ${provider.id} init 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const { provider } of this.chain) {
      if (provider.shutdown) {
        try { await provider.shutdown(); } catch { /* 靜默 */ }
      }
    }
  }

  // ── 監控 API ──────────────────────────────────────────────────────────────

  getStatus(): FailoverStatus {
    const active = this.firstAvailable();
    return {
      activeProvider: active?.provider.id ?? "none",
      chain: this.chain.map(e => ({
        providerId: e.provider.id,
        status:     e.breaker.getStatus(),
      })),
    };
  }

  /** 強制重置所有 circuit breaker */
  resetAll(): void {
    for (const { breaker } of this.chain) breaker.reset();
  }

  /** 重置特定 provider 的 circuit breaker */
  resetProvider(providerId: string): boolean {
    const entry = this.chain.find(e => e.provider.id === providerId);
    if (!entry) return false;
    entry.breaker.reset();
    return true;
  }

  private firstAvailable(): FailoverEntry | undefined {
    return this.chain.find(e => e.breaker.isAvailable());
  }
}

// ── Builder ────────────────────────────────────────────────────────────────────

/**
 * 從 provider 清單建立 FailoverProvider。
 * 每個 provider 自動獲得一個 CircuitBreaker。
 */
export function buildFailoverProvider(
  id: string,
  providers: LLMProvider[],
  breakerCfg?: Partial<CircuitBreakerConfig>
): FailoverProvider {
  const chain: FailoverEntry[] = providers.map(p => ({
    provider: p,
    breaker:  new CircuitBreaker(p.id, breakerCfg),
  }));
  return new FailoverProvider(id, chain);
}
