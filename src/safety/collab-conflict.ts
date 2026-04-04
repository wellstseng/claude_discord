/**
 * @file safety/collab-conflict.ts
 * @description 協作衝突偵測 — 多人同頻道同時編輯同一檔案時發出警告
 *
 * 設計：
 * - 監聽 EventBus 的 file:modified 事件
 * - 追蹤每個檔案最近的編輯者和時間
 * - 如果不同帳號在短時間內（windowMs）編輯同一檔案 → 發出警告
 * - 警告透過 EventBus 發送，由 agent-loop 或 discord handler 消費
 */

import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface EditRecord {
  path: string;
  accountId: string;
  tool: string;
  timestamp: number;
}

export interface ConflictWarning {
  path: string;
  currentEditor: string;
  previousEditor: string;
  timeSinceLastEditMs: number;
}

// ── CollabConflictDetector ────────────────────────────────────────────────────

export class CollabConflictDetector {
  /** 最近編輯記錄：key = filePath */
  private recentEdits = new Map<string, EditRecord>();
  /** 偵測窗口毫秒（預設 5 分鐘） */
  private windowMs: number;
  /** 警告回呼 */
  private onConflict?: (warning: ConflictWarning) => void;

  constructor(opts?: { windowMs?: number; onConflict?: (w: ConflictWarning) => void }) {
    this.windowMs = opts?.windowMs ?? 5 * 60_000;
    this.onConflict = opts?.onConflict;
  }

  /**
   * 記錄一次檔案修改。
   * @returns 衝突警告（如果有），否則 null
   */
  recordEdit(path: string, tool: string, accountId: string): ConflictWarning | null {
    const now = Date.now();
    const existing = this.recentEdits.get(path);

    let warning: ConflictWarning | null = null;

    if (existing && existing.accountId !== accountId) {
      const elapsed = now - existing.timestamp;
      if (elapsed < this.windowMs) {
        warning = {
          path,
          currentEditor: accountId,
          previousEditor: existing.accountId,
          timeSinceLastEditMs: elapsed,
        };
        log.warn(`[collab-conflict] ⚠️ ${path} 被 ${accountId} 編輯，但 ${existing.accountId} 在 ${Math.round(elapsed / 1000)}s 前也編輯過此檔案`);
        this.onConflict?.(warning);
      }
    }

    // 更新記錄
    this.recentEdits.set(path, { path, accountId, tool, timestamp: now });

    // 清理過期記錄（避免記憶洩漏）
    if (this.recentEdits.size > 500) {
      const cutoff = now - this.windowMs;
      for (const [key, rec] of this.recentEdits) {
        if (rec.timestamp < cutoff) this.recentEdits.delete(key);
      }
    }

    return warning;
  }

  /** 取得指定檔案的最近編輯者 */
  getLastEditor(path: string): EditRecord | undefined {
    return this.recentEdits.get(path);
  }

  /** 清除所有記錄 */
  clear(): void {
    this.recentEdits.clear();
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _detector: CollabConflictDetector | null = null;

export function initCollabConflictDetector(opts?: { windowMs?: number; onConflict?: (w: ConflictWarning) => void }): CollabConflictDetector {
  _detector = new CollabConflictDetector(opts);
  return _detector;
}

export function getCollabConflictDetector(): CollabConflictDetector | null {
  return _detector;
}

/**
 * ��偵測器連接到 EventBus。
 * 監聽 file:modified 事件，自動記錄編輯並發出衝突警告。
 */
export function connectToEventBus(eventBus: { on: (event: string, listener: (...args: unknown[]) => void) => void }): void {
  if (!_detector) return;
  eventBus.on("file:modified", (path: unknown, tool: unknown, accountId: unknown) => {
    _detector?.recordEdit(String(path), String(tool), String(accountId));
  });
  log.info("[collab-conflict] 已連接 EventBus");
}
