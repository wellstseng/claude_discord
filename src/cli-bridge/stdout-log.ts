/**
 * @file cli-bridge/stdout-log.ts
 * @description StdoutLogger — CLI Bridge 完整日誌記錄
 *
 * 記錄所有 stdout 事件和完整 turn 歷程到 JSONL 檔案。
 * 支援查詢（Dashboard 用）和 WebSocket 即時推送 hook。
 *
 * 日誌路徑：{logDir}/{label}/
 *   - stdout.jsonl  — 即時 stdout 事件
 *   - turns.jsonl   — 完整 turn 歷程
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { CliBridgeEvent, TurnRecord, StdoutLogEntry } from "./types.js";

export class StdoutLogger {
  private logDir: string;
  private stdoutPath: string;
  private turnsPath: string;
  private eventListeners: Array<(entry: StdoutLogEntry) => void> = [];

  // 記憶體中保留最近 N 筆（快速查詢用，不用每次讀檔）
  private recentEvents: StdoutLogEntry[] = [];
  private recentTurns: TurnRecord[] = [];
  private readonly MAX_RECENT_EVENTS = 500;
  private readonly MAX_RECENT_TURNS = 100;

  constructor(logDir: string, private label: string) {
    const expanded = logDir.startsWith("~") ? logDir.replace("~", homedir()) : logDir;
    this.logDir = resolve(expanded, label);
    this.stdoutPath = join(this.logDir, "stdout.jsonl");
    this.turnsPath = join(this.logDir, "turns.jsonl");

    // 確保目錄存在
    mkdirSync(this.logDir, { recursive: true });

    // 載入既有歷程
    this.loadExisting();
  }

  // ── 記錄 stdout 事件 ──────────────────────────────────────────────────────

  append(event: CliBridgeEvent, raw?: string): void {
    const entry: StdoutLogEntry = {
      ts: new Date().toISOString(),
      event,
      raw,
    };

    // 記憶體
    this.recentEvents.push(entry);
    if (this.recentEvents.length > this.MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }

    // 磁碟（靜默失敗）
    try {
      appendFileSync(this.stdoutPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log.debug(`[stdout-log:${this.label}] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    // 通知 listeners（WebSocket 推送用）
    for (const listener of this.eventListeners) {
      try { listener(entry); } catch { /* 靜默 */ }
    }
  }

  // ── 記錄 turn 歷程 ────────────────────────────────────────────────────────

  recordTurn(turn: TurnRecord): void {
    // 記憶體
    this.recentTurns.push(turn);
    if (this.recentTurns.length > this.MAX_RECENT_TURNS) {
      this.recentTurns.shift();
    }

    // 磁碟
    try {
      appendFileSync(this.turnsPath, JSON.stringify(turn) + "\n", "utf-8");
    } catch (err) {
      log.debug(`[stdout-log:${this.label}] turn 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(`[stdout-log:${this.label}] turn recorded: ${turn.turnId.slice(0, 8)} source=${turn.source} tools=${turn.toolCalls.length}`);
  }

  // ── 查詢（Dashboard 用）──────────────────────────────────────────────────

  getRecentEvents(limit: number): StdoutLogEntry[] {
    return this.recentEvents.slice(-limit);
  }

  getTurnHistory(limit: number): TurnRecord[] {
    return this.recentTurns.slice(-limit);
  }

  /** 取得指定 turn */
  getTurn(turnId: string): TurnRecord | undefined {
    return this.recentTurns.find(t => t.turnId === turnId);
  }

  /** 更新 turn 的 Discord 送達狀態 */
  updateTurnDelivery(turnId: string, delivery: TurnRecord["discordDelivery"], messageId?: string, reason?: string): void {
    const turn = this.recentTurns.find(t => t.turnId === turnId);
    if (turn) {
      turn.discordDelivery = delivery;
      if (messageId) turn.discordMessageId = messageId;
      if (reason) turn.failedReason = reason;
    }
  }

  // ── WebSocket 即時推送 hook ────────────────────────────────────────────────

  onEvent(listener: (entry: StdoutLogEntry) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  // ── 日誌路徑（外部存取用）────────────────────────────────────────────────

  get paths() {
    return {
      dir: this.logDir,
      stdout: this.stdoutPath,
      turns: this.turnsPath,
    };
  }

  // ── 內部：載入既有歷程 ────────────────────────────────────────────────────

  private loadExisting(): void {
    // 載入 turns
    if (existsSync(this.turnsPath)) {
      try {
        const lines = readFileSync(this.turnsPath, "utf-8").split("\n").filter(l => l.trim());
        for (const line of lines.slice(-this.MAX_RECENT_TURNS)) {
          try {
            this.recentTurns.push(JSON.parse(line) as TurnRecord);
          } catch { /* skip bad line */ }
        }
        log.debug(`[stdout-log:${this.label}] 載入 ${this.recentTurns.length} 筆 turn 歷程`);
      } catch { /* 靜默 */ }
    }

    // stdout events 不載入（量太大，只從啟動後開始記錄）
  }
}
