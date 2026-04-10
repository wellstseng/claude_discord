/**
 * @file tools/builtin/session-context.ts
 * @description session_context — 查詢當前 session 的 context window 使用量、CE threshold 距離、rate limit 狀態
 */

import type { Tool } from "../types.js";
import { getSessionManager } from "../../core/session.js";
import { getContextEngine, estimateTokens } from "../../core/context-engine.js";
import { getRateLimiter } from "../../core/rate-limiter.js";
import { getAccountRegistry } from "../../core/platform.js";

export const tool: Tool = {
  name: "session_context",
  description: [
    "查詢當前頻道 session 的 context window 使用狀態。",
    "回傳：訊息數、估算 token 數、各 CE 壓縮策略的 threshold 與距離、rate limit 狀態。",
    "使用時機：使用者問 context 用了多少、離壓縮多遠、rate limit 剩多少、token 使用量等。",
  ].join(" "),
  tier: "standard",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_params, ctx) {
    const sm = getSessionManager();
    const session = sm.list().find(s => s.channelId === ctx.channelId);

    if (!session) {
      return { result: "此頻道尚無 session。" };
    }

    const messages = session.messages;
    const tokens = estimateTokens(messages);

    // CE thresholds
    const ce = getContextEngine();
    const contextWindow = ce?.getContextWindowTokens() ?? 100_000;

    const compaction = ce?.getStrategy("compaction") as { enabled: boolean; cfg?: { triggerTokens: number } } | undefined;
    const budgetGuard = ce?.getStrategy("budget-guard") as { enabled: boolean; cfg?: { maxUtilization: number; contextWindowTokens: number } } | undefined;
    const overflow = ce?.getStrategy("overflow-hard-stop") as { enabled: boolean; cfg?: { hardLimitUtilization: number; contextWindowTokens: number } } | undefined;

    // Extract thresholds from strategies
    const compactionTrigger = (compaction as any)?.cfg?.triggerTokens ?? 4000;
    const bgMaxUtil = (budgetGuard as any)?.cfg?.maxUtilization ?? 0.8;
    const bgWindow = (budgetGuard as any)?.cfg?.contextWindowTokens ?? contextWindow;
    const bgTrigger = Math.floor(bgWindow * bgMaxUtil);
    const ohUtil = (overflow as any)?.cfg?.hardLimitUtilization ?? 0.95;
    const ohWindow = (overflow as any)?.cfg?.contextWindowTokens ?? contextWindow;
    const ohTrigger = Math.floor(ohWindow * ohUtil);

    const utilization = tokens / contextWindow;

    // Rate limit
    let rateLimitInfo: Record<string, unknown> = {};
    try {
      const limiter = getRateLimiter();
      const accountReg = getAccountRegistry();
      const accountId = accountReg.resolveIdentity("discord", ctx.accountId);
      const account = accountId ? accountReg.get(accountId) : null;
      const role = account?.role ?? "member";
      const rl = limiter.check(ctx.accountId, role);
      rateLimitInfo = {
        role,
        allowed: rl.allowed,
        remaining: rl.remaining,
        retryAfterMs: rl.retryAfterMs,
      };
    } catch {
      rateLimitInfo = { error: "rate limiter not available" };
    }

    const result = {
      sessionKey: session.sessionKey,
      messages: messages.length,
      turns: session.turnCount,
      estimatedTokens: tokens,
      contextWindow,
      utilization: `${(utilization * 100).toFixed(1)}%`,
      thresholds: {
        compaction: {
          trigger: compactionTrigger,
          distance: compactionTrigger - tokens,
          status: tokens > compactionTrigger ? "EXCEEDED" : "OK",
        },
        budgetGuard: {
          trigger: bgTrigger,
          distance: bgTrigger - tokens,
          utilization: `${(tokens / bgWindow * 100).toFixed(1)}%`,
          status: tokens > bgTrigger ? "EXCEEDED" : "OK",
        },
        overflowHardStop: {
          trigger: ohTrigger,
          distance: ohTrigger - tokens,
          utilization: `${(tokens / ohWindow * 100).toFixed(1)}%`,
          status: tokens > ohTrigger ? "EXCEEDED" : "OK",
        },
      },
      rateLimit: rateLimitInfo,
    };

    return { result };
  },
};
