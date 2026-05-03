/**
 * @file core/session-snapshot.ts
 * @description Session Snapshot — turn 開始前快照，/stop 回退用
 *
 * 快照時機：agentLoop 開始前（CE build 後）
 *
 * 生命週期：
 * - 正常完成 + 無 CE 壓縮 → 刪除快照
 * - 正常完成 + CE 壓縮    → 保留 48h（供 /rollback 手動還原）
 * - /stop 中斷           → 還原快照 → 刪除快照
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { Message } from "../providers/base.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface SessionSnapshotRecord {
  sessionKey: string;
  turnIndex: number;
  messages: Message[];
  snapshotAt: string;   // ISO 8601
  ceApplied: boolean;   // 是否有 CE 壓縮
  expiresAt?: string;   // 48h TTL（CE 壓縮時設定）
}

// ── SessionSnapshotStore ──────────────────────────────────────────────────────

export class SessionSnapshotStore {
  private snapshotDir: string;
  private static readonly KEEP_CE_HOURS = 48;

  constructor(dataDir: string) {
    this.snapshotDir = resolve(
      dataDir.startsWith("~") ? dataDir.replace("~", homedir()) : dataDir,
      "session-snapshots",
    );
    mkdirSync(this.snapshotDir, { recursive: true });
  }

  // ── 建立快照 ──────────────────────────────────────────────────────────────

  save(sessionKey: string, turnIndex: number, messages: Message[], ceApplied = false): void {
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.snapshotDir, `${safeKey}_snap_${turnIndex}.json`);
    const expiresAt = ceApplied
      ? new Date(Date.now() + SessionSnapshotStore.KEEP_CE_HOURS * 3600_000).toISOString()
      : undefined;

    const record: SessionSnapshotRecord = {
      sessionKey,
      turnIndex,
      messages,
      snapshotAt: new Date().toISOString(),
      ceApplied,
      expiresAt,
    };

    try {
      writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
      log.debug(`[session-snapshot] 儲存 ${safeKey} turn=${turnIndex}`);
    } catch (err) {
      log.warn(`[session-snapshot] 儲存失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 讀取快照 ──────────────────────────────────────────────────────────────

  get(sessionKey: string, turnIndex: number): SessionSnapshotRecord | null {
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.snapshotDir, `${safeKey}_snap_${turnIndex}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as SessionSnapshotRecord;
    } catch { return null; }
  }

  /** 取得某 session 所有可用快照（按 turnIndex 降序） */
  list(sessionKey: string): SessionSnapshotRecord[] {
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const records: SessionSnapshotRecord[] = [];
    try {
      const files = readdirSync(this.snapshotDir)
        .filter(f => f.startsWith(`${safeKey}_snap_`) && f.endsWith(".json"));
      for (const f of files) {
        try {
          const rec = JSON.parse(readFileSync(join(this.snapshotDir, f), "utf-8")) as SessionSnapshotRecord;
          if (!rec.expiresAt || new Date(rec.expiresAt) > new Date()) {
            records.push(rec);
          }
        } catch { /* 損壞 */ }
      }
    } catch { /* 靜默 */ }
    return records.sort((a, b) => b.turnIndex - a.turnIndex);
  }

  // ── 刪除快照 ──────────────────────────────────────────────────────────────

  delete(sessionKey: string, turnIndex: number): void {
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(this.snapshotDir, `${safeKey}_snap_${turnIndex}.json`);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* 靜默 */ }
  }

  // ── TTL 清理 ─────────────────────────────────────────────────────────────

  cleanup(): void {
    const now = new Date();
    try {
      const files = readdirSync(this.snapshotDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const filePath = join(this.snapshotDir, f);
        try {
          const rec = JSON.parse(readFileSync(filePath, "utf-8")) as SessionSnapshotRecord;
          // 無 expiresAt（非 CE）且超過 1h → 應已被刪除，清理孤立檔
          if (!rec.expiresAt) {
            const age = now.getTime() - new Date(rec.snapshotAt).getTime();
            if (age > 3600_000) unlinkSync(filePath);
          } else if (new Date(rec.expiresAt) < now) {
            unlinkSync(filePath);
            log.debug(`[session-snapshot] 清除過期 ${f}`);
          }
        } catch { /* 損壞，刪除 */
          try { unlinkSync(filePath); } catch { /* 靜默 */ }
        }
      }
    } catch { /* 靜默 */ }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _snapshotStore: SessionSnapshotStore | null = null;

export function initSessionSnapshotStore(dataDir: string): SessionSnapshotStore {
  _snapshotStore = new SessionSnapshotStore(dataDir);
  return _snapshotStore;
}

export function getSessionSnapshotStore(): SessionSnapshotStore | null {
  return _snapshotStore;
}

// ── Frozen Prompt Materials (session-level) ──────────────────────────────────
//
// session 開場時凍結 prompt-assembler 各 module 的「session 內穩定」內容，
// 讓 system prompt 跨 turn byte-wise 相同 → Anthropic prompt cache 命中。
//
// 與上方 SessionSnapshotStore（turn-level CE rollback）職責分離：
// - SessionSnapshotStore：每 turn 前快照 messages（持久化、CE 觸發時 48h TTL）
// - FrozenPromptMaterials：session 開場凍結 prompt 材料（in-memory、session 結束丟棄）

export interface FrozenPromptMaterials {
  // 從 prompt-assembler.ts module 凍結
  dateTimeText: string;
  catclawMdText: string;
  codingRulesText: string;
  toolSummaryText: string;
  skillSummaryText: string;
  failureRecallText: string;
  // 從 memory engine 凍結
  memoryContextBlock: string;
  // metadata
  preparedAt: string;
  sessionKey: string;
  accountId: string;
  channelId: string;
  agentId?: string;
}

const _frozenMaterialsMap = new Map<string, FrozenPromptMaterials>();

export function getFrozenMaterials(sessionKey: string): FrozenPromptMaterials | null {
  return _frozenMaterialsMap.get(sessionKey) ?? null;
}

export function setFrozenMaterials(sessionKey: string, materials: FrozenPromptMaterials): void {
  _frozenMaterialsMap.set(sessionKey, materials);
}

export function clearFrozenMaterials(sessionKey: string): void {
  _frozenMaterialsMap.delete(sessionKey);
}

/**
 * 在 session 開場（agent-loop SessionStart hook 內 turnCount === 0 時）呼叫。
 * 凍結 prompt-assembler 6 個 module 的輸出 + 執行一次 memory recall，組成 FrozenPromptMaterials。
 */
export async function prepareSessionSnapshot(opts: {
  sessionKey: string;
  accountId: string;
  channelId: string;
  agentId?: string;
  modeName?: string;
  workspaceDir?: string;
  initialPrompt?: string;
}): Promise<FrozenPromptMaterials> {
  // 1. 凍結 prompt-assembler module 輸出（先 refresh failure recall 全域 cache）
  const { prepareFrozenMaterials, refreshFailureRecallCache } = await import("./prompt-assembler.js");
  await refreshFailureRecallCache();

  const moduleFrozen = prepareFrozenMaterials({
    modeName: opts.modeName ?? "normal",
    workspaceDir: opts.workspaceDir,
  });

  // 2. session 開場 memory recall（以首則 user message 為 query）
  let memoryContextBlock = "";
  if (opts.initialPrompt) {
    try {
      const { getPlatformMemoryEngine } = await import("./platform.js");
      const memEngine = getPlatformMemoryEngine();
      if (memEngine) {
        const recall = await memEngine.recall(opts.initialPrompt, {
          accountId: opts.accountId,
          channelId: opts.channelId,
        });
        if (recall.fragments.length > 0) {
          const ctx = memEngine.buildContext(recall.fragments, opts.initialPrompt, recall.blindSpot);
          memoryContextBlock = ctx.text;
        }
      }
    } catch (err) {
      log.debug(`[session-snapshot] memory recall 失敗（snapshot memoryContextBlock 留空）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ...moduleFrozen,
    memoryContextBlock,
    preparedAt: new Date().toISOString(),
    sessionKey: opts.sessionKey,
    accountId: opts.accountId,
    channelId: opts.channelId,
    agentId: opts.agentId,
  };
}
