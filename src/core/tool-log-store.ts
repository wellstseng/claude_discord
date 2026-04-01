/**
 * @file core/tool-log-store.ts
 * @description Tool Log Store — 儲存每個 turn 的完整 tool 執行記錄
 *
 * 設計：
 * - Tool results 存為獨立 JSON 檔，session history 只存索引摘要
 * - 路徑：data/tool-logs/{platform}_{safe_session_key}/turn_{n}.json
 * - LLM context 只存 "[工具記錄] op×N → path" 摘要，不佔大量 token
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ToolLogEntry {
  id: string;
  name: string;
  params: unknown;
  result: unknown;
  error?: string;
  durationMs: number;
}

export interface ToolLog {
  ts: string;
  sessionKey: string;
  turnIndex: number;
  tools: ToolLogEntry[];
}

// ── ToolLogStore ──────────────────────────────────────────────────────────────

export class ToolLogStore {
  private logDir: string;

  constructor(dataDir: string) {
    this.logDir = resolve(
      dataDir.startsWith("~") ? dataDir.replace("~", homedir()) : dataDir,
      "tool-logs",
    );
  }

  /**
   * 儲存 turn 的 tool log，回傳相對路徑（供 session history 索引用）
   * 若 tools 陣列為空，不儲存，回傳 null
   */
  save(sessionKey: string, turnIndex: number, tools: ToolLogEntry[]): string | null {
    if (tools.length === 0) return null;

    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = join(this.logDir, safeKey);
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* 已存在 */ }

    const fileName = `turn_${turnIndex}.json`;
    const filePath = join(dir, fileName);
    const relativePath = `tool-logs/${safeKey}/${fileName}`;

    const record: ToolLog = {
      ts: new Date().toISOString(),
      sessionKey,
      turnIndex,
      tools,
    };

    try {
      writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
      log.debug(`[tool-log] 儲存 ${relativePath}（${tools.length} tools）`);
    } catch (err) {
      log.warn(`[tool-log] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    return relativePath;
  }

  /**
   * 清除超過 retentionDays 天未修改的 tool log 目錄
   * 預設保留 7 天（對齊 session TTL 預設值）
   */
  cleanup(retentionDays = 7): void {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      const dirs = readdirSync(this.logDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => join(this.logDir, e.name));
      for (const dir of dirs) {
        try {
          const mtime = statSync(dir).mtimeMs;
          if (mtime < cutoff) {
            rmSync(dir, { recursive: true, force: true });
            log.debug(`[tool-log] 清除過期目錄：${dir}`);
          }
        } catch { /* 靜默 */ }
      }
    } catch { /* logDir 不存在 */ }
  }

  /**
   * 產生供 session history 索引的摘要訊息文字
   * 例：[工具記錄] read_file×2, edit_file×1 → tool-logs/discord_ch_111/turn_42.json
   */
  static buildIndexSummary(tools: ToolLogEntry[], logPath: string): string {
    const counts = new Map<string, number>();
    for (const t of tools) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
    const ops = Array.from(counts.entries())
      .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
      .join(", ");
    return `[工具記錄] ${ops} → ${logPath}`;
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _toolLogStore: ToolLogStore | null = null;

export function initToolLogStore(dataDir: string): ToolLogStore {
  _toolLogStore = new ToolLogStore(dataDir);
  return _toolLogStore;
}

export function getToolLogStore(): ToolLogStore | null {
  return _toolLogStore;
}
