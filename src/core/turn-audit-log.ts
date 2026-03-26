/**
 * @file core/turn-audit-log.ts
 * @description Turn Audit Log — 每個 turn 的完整執行快照
 *
 * JSONL append-only，rolling 保留 30 天。
 * 供 /turn-audit skill 查詢、CE 效果驗證使用。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface TurnAuditEntry {
  ts: string;                           // ISO 8601
  platform: string;
  sessionKey: string;
  channelId: string;
  accountId: string;
  turnIndex: number;
  phase: {
    inboundReceivedMs: number;          // epoch ms
    queueWaitMs?: number;
    agentLoopStartMs?: number;
    completedMs?: number;
  };
  inboundInjected?: {
    bucketA: number;
    bucketB: number;
    decayIIApplied: boolean;
    tokens: number;
  };
  contextBreakdown?: {
    systemPrompt: number;
    recall: number;
    history: number;
    inboundContext: number;
    current: number;
  };
  ceApplied: string[];                  // 觸發的 CE strategy 名稱清單
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  toolLogPath?: string;
  durationMs?: number;
  error?: string;
}

// ── 內部狀態 ──────────────────────────────────────────────────────────────────

const ROLLING_DAYS = 30;

// ── TurnAuditLog ─────────────────────────────────────────────────────────────

export class TurnAuditLog {
  private logDir: string;

  constructor(dataDir: string) {
    this.logDir = resolve(dataDir.startsWith("~") ? dataDir.replace("~", homedir()) : dataDir, "turn-audit");
    mkdirSync(this.logDir, { recursive: true });
  }

  // ── 寫入 ──────────────────────────────────────────────────────────────────

  append(entry: TurnAuditEntry): void {
    try {
      const dateStr = new Date(entry.ts).toISOString().slice(0, 10);  // YYYY-MM-DD
      const filePath = join(this.logDir, `${dateStr}.jsonl`);
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log.warn(`[turn-audit] append 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 查詢 ──────────────────────────────────────────────────────────────────

  /**
   * 讀取最近 N 個 turns（跨日期檔按 ts 排序）
   */
  recent(limit = 10, filter?: (e: TurnAuditEntry) => boolean): TurnAuditEntry[] {
    const allEntries: TurnAuditEntry[] = [];
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .reverse();  // 最新日期優先

      for (const f of files) {
        const lines = readFileSync(join(this.logDir, f), "utf-8")
          .split("\n")
          .filter(l => l.trim());
        for (const line of lines.reverse()) {
          try {
            const entry = JSON.parse(line) as TurnAuditEntry;
            if (!filter || filter(entry)) allEntries.push(entry);
            if (allEntries.length >= limit) return allEntries;
          } catch { /* 損壞行，跳過 */ }
        }
        if (allEntries.length >= limit) break;
      }
    } catch { /* 目錄空 */ }
    return allEntries;
  }

  // ── Rolling 清理 ─────────────────────────────────────────────────────────

  cleanup(): void {
    const cutoffDate = new Date(Date.now() - ROLLING_DAYS * 86400_000)
      .toISOString().slice(0, 10);
    try {
      const files = readdirSync(this.logDir).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        const dateStr = f.slice(0, 10);
        if (dateStr < cutoffDate) {
          unlinkSync(join(this.logDir, f));
          log.debug(`[turn-audit] 清除過期 ${f}`);
        }
      }
    } catch { /* 靜默 */ }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _auditLog: TurnAuditLog | null = null;

export function initTurnAuditLog(dataDir: string): TurnAuditLog {
  _auditLog = new TurnAuditLog(dataDir);
  return _auditLog;
}

export function getTurnAuditLog(): TurnAuditLog | null {
  return _auditLog;
}

// ── 格式化輔助 ────────────────────────────────────────────────────────────────

export function formatAuditSummary(entries: TurnAuditEntry[]): string {
  if (entries.length === 0) return "（無記錄）";

  const lines: string[] = [];
  for (const e of entries) {
    const ts = new Date(e.ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    const dur = e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : "-";
    const ce = e.ceApplied.length > 0 ? `CE:${e.ceApplied.join("+")}` : "";
    const tok = e.inputTokens != null
      ? `↑${e.inputTokens}${e.outputTokens != null ? `/↓${e.outputTokens}` : ""}`
      : "";
    const tools = e.toolCalls > 0 ? `tools:${e.toolCalls}` : "";
    const err = e.error ? `❌${e.error.slice(0, 30)}` : "";
    const parts = [ts, e.sessionKey, dur, tok, ce, tools, err].filter(Boolean);
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}
