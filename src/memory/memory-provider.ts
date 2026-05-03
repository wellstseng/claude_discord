/**
 * @file memory/memory-provider.ts
 * @description MemoryProvider 介面定義（Phase 0 — 純介面，不改呼叫點）
 *
 * 鋪路用：未來若要接 Honcho / Letta / Mem0 等外部記憶系統，
 * 不需大改 engine.ts，只要新增實作 MemoryProvider 的 class。
 *
 * 關鍵規則（參考 Hermes MemoryManager 設計）：
 * - BuiltinMemoryProvider 永遠優先（priority=0）
 * - external provider 至多 1 個（避免 tool schema bloat / 記憶分裂）
 * - 同一介面，可平行 recall 後合併
 *
 * 目前無 manager（Phase 1 才做）。本檔只定義型別。
 */

import type { Atom } from "./atom.js";
import type { RecallContext, RecallResult } from "./recall.js";

export interface MemoryProvider {
  /** 唯一識別名（"builtin" 保留給內建） */
  readonly name: string;

  /** 優先序（0 = 最先，越大越後。builtin 預設 0） */
  readonly priority: number;

  /**
   * 檢索記憶。
   *
   * 簽名與 MemoryEngine.recall 對齊，方便 builtin 直接委託。
   */
  recall(
    prompt: string,
    ctx: RecallContext,
    overrides?: { vectorSearch?: boolean; vectorTopK?: number },
  ): Promise<RecallResult>;

  /**
   * 寫入記憶（Phase 0 為 optional）。
   *
   * builtin 暫不實作。Phase 1 引入 MemoryManager 時再強制要求。
   */
  write?(atom: Atom): Promise<void>;

  /** Session 生命週期 hook（可選） */
  onSessionStart?(sessionId: string, ctx: { agentId?: string; accountId?: string }): Promise<void>;
  onSessionEnd?(sessionId: string): Promise<void>;
}
