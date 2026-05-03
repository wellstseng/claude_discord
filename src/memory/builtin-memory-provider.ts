/**
 * @file memory/builtin-memory-provider.ts
 * @description BuiltinMemoryProvider — 委託給既有 MemoryEngine
 *
 * Phase 0：純包裝，不改 engine 行為。
 * 目的是讓未來 external provider 接入時，可在介面層做合併 / 路由。
 */

import type { MemoryEngine } from "./engine.js";
import type { MemoryProvider } from "./memory-provider.js";
import type { RecallContext, RecallResult } from "./recall.js";

export class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin";
  readonly priority = 0;

  constructor(private readonly engine: MemoryEngine) {}

  recall(
    prompt: string,
    ctx: RecallContext,
    overrides?: { vectorSearch?: boolean; vectorTopK?: number },
  ): Promise<RecallResult> {
    return this.engine.recall(prompt, ctx, overrides);
  }

  // write Phase 0 不實作；MemoryProvider 介面標 optional。
}
