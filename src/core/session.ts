/**
 * @file core/session.ts
 * @description Session 管理 + Turn Queue
 *
 * Session = 一個頻道/帳號的對話上下文（messages history + provider binding）
 * Turn Queue = per-session FIFO 佇列，序列化多並發訊息
 *
 * 設計要點：
 * - Session key：`ch:{channelId}` 或 `dm:{accountId}:{channelId}`
 * - 持久化：atomic write（先寫 .tmp 再 rename）
 * - TTL 清理：啟動時掃描，刪除過期 session
 * - Turn Queue 規則：max depth 5，排隊超時 60s，自動移出
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import type { Message } from "../providers/base.js";
import { config, type SessionConfig } from "./config.js";

type SessionEventBus = {
  emit(event: "session:end", sessionId: string): boolean;
};

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface Session {
  sessionKey: string;
  accountId: string;
  channelId: string;
  providerId: string;
  messages: Message[];
  createdAt: number;        // timestamp ms
  lastActiveAt: number;
  turnCount: number;
}

export interface TurnRequest {
  sessionKey: string;
  accountId: string;
  prompt: string;
  signal?: AbortSignal;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── SessionManager ────────────────────────────────────────────────────────────

const TURN_QUEUE_MAX_DEPTH  = 5;
// 佇列排隊超時：至少 120s，但不超過 turnTimeoutMs（預設 300s）
const TURN_QUEUE_TIMEOUT_MS_DEFAULT = 120_000;
const MAX_HISTORY_TURNS_DEFAULT = 50;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private queues   = new Map<string, TurnRequest[]>();
  private cfg: SessionConfig;
  private persistDir: string;
  private eventBus?: SessionEventBus;

  constructor(cfg: SessionConfig, eventBus?: SessionEventBus) {
    this.cfg = cfg;
    this.persistDir = resolvePath(cfg.persistPath);
    this.eventBus = eventBus;
  }

  // ── 初始化 ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    mkdirSync(this.persistDir, { recursive: true });
    this.cleanExpired();
    this.loadAll();
    log.info(`[session] 初始化完成，已載入 ${this.sessions.size} 個 session`);
  }

  // ── Session CRUD ──────────────────────────────────────────────────────────────

  getOrCreate(sessionKey: string, accountId: string, channelId: string, providerId: string): Session {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        sessionKey, accountId, channelId, providerId,
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        turnCount: 0,
      };
      this.sessions.set(sessionKey, session);
      log.debug(`[session] 建立 ${sessionKey}`);
    }
    return session;
  }

  get(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  /** 新增訊息（user + assistant），並觸發 compact / persist */
  addMessages(sessionKey: string, messages: Message[]): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.messages.push(...messages);
    session.lastActiveAt = Date.now();
    session.turnCount++;

    // compact：保留最近 N 輪（不含 system messages）
    const maxTurns = this.cfg.maxHistoryTurns ?? MAX_HISTORY_TURNS_DEFAULT;
    if (session.messages.length > maxTurns * 2) {
      session.messages = session.messages.slice(-maxTurns * 2);
    }

    this.persist(session);
  }

  getHistory(sessionKey: string): Message[] {
    return this.sessions.get(sessionKey)?.messages ?? [];
  }

  /**
   * CE 壓縮後，將精簡版 messages 寫回 session（取代原始內容）。
   * 寫入前備份原始 session 至 _ce_backups/{key}_{ts}.json，保留最近 3 份。
   */
  replaceMessages(sessionKey: string, messages: Message[]): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    // 備份原始 session
    this._backupBeforeReplace(session);

    session.messages = messages;
    session.lastActiveAt = Date.now();
    this.persist(session);
    log.debug(`[session] replaceMessages ${sessionKey} → ${messages.length} messages`);
  }

  private _backupBeforeReplace(session: Session): void {
    try {
      const backupDir = join(this.persistDir, "_ce_backups");
      mkdirSync(backupDir, { recursive: true });

      const safe = session.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const ts = Date.now();
      const backupPath = join(backupDir, `${safe}_${ts}.json`);
      writeFileSync(backupPath, JSON.stringify(session, null, 2), "utf-8");

      // 保留最近 3 份，刪除最舊的
      const prefix = `${safe}_`;
      const files = readdirSync(backupDir)
        .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
        .sort();  // 字典序 = 時間序（timestamp 前綴）

      if (files.length > 3) {
        for (const f of files.slice(0, files.length - 3)) {
          try { unlinkSync(join(backupDir, f)); } catch { /* 靜默 */ }
        }
      }
    } catch (err) {
      log.warn(`[session] CE backup 失敗 ${session.sessionKey}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    const filePath = this.sessionPath(sessionKey);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* 靜默 */ }
    // 清理 frozen prompt materials（in-memory map，避免 leak）
    void import("./session-snapshot.js").then(m => m.clearFrozenMaterials(sessionKey)).catch(() => { /* 靜默 */ });
    log.debug(`[session] 刪除 ${sessionKey}`);
    this.eventBus?.emit("session:end", sessionKey);
  }

  /** 清空指定 session 的訊息（保留 session 殼），回傳被清除的訊息數 */
  clearMessages(sessionKey: string): number {
    const session = this.sessions.get(sessionKey);
    if (!session) return 0;
    const count = session.messages.length;
    session.messages = [];
    session.turnCount = 0;
    // 清空訊息 = 邏輯重啟 session → 強制下個 turn SessionStart hook 重建 frozen snapshot
    void import("./session-snapshot.js").then(m => m.clearFrozenMaterials(sessionKey)).catch(() => { /* 靜默 */ });
    this.persist(session);
    log.info(`[session] clearMessages ${sessionKey}：${count} 條`);
    return count;
  }

  /** 清除所有過期 session，回傳清除數量 */
  purgeExpired(): number {
    const ttlMs = (this.cfg.ttlHours ?? 168) * 3600_000;
    const cutoff = Date.now() - ttlMs;
    let count = 0;
    for (const [key, session] of this.sessions) {
      if (session.lastActiveAt < cutoff) {
        this.delete(key);
        count++;
      }
    }
    // 同時清理磁碟上的孤兒檔案
    try {
      const files = readdirSync(this.persistDir).filter(f => f.endsWith(".json") && !f.startsWith("_"));
      for (const f of files) {
        const filePath = join(this.persistDir, f);
        try {
          const raw = readFileSync(filePath, "utf-8");
          const { lastActiveAt, sessionKey } = JSON.parse(raw) as Session;
          if (lastActiveAt < cutoff && !this.sessions.has(sessionKey)) {
            unlinkSync(filePath);
            count++;
          }
        } catch { try { unlinkSync(filePath); count++; } catch { /* 靜默 */ } }
      }
    } catch { /* 靜默 */ }
    log.info(`[session] purgeExpired：清除 ${count} 個`);
    return count;
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  // ── Turn Queue ────────────────────────────────────────────────────────────────

  /**
   * 排入 turn queue，回傳 Promise（當前 turn 可開始執行時 resolve）
   * 超過 max depth → reject（忙碌中）
   * 排隊超過 60s → reject（超時）
   */
  enqueueTurn(request: Omit<TurnRequest, "enqueuedAt" | "resolve" | "reject">): Promise<void> {
    const { sessionKey } = request;
    const queue = this.queues.get(sessionKey) ?? [];

    if (queue.length >= TURN_QUEUE_MAX_DEPTH) {
      return Promise.reject(new Error("BUSY: turn queue 已滿（depth=5），請稍後再試"));
    }

    return new Promise<void>((resolve, reject) => {
      const entry: TurnRequest = {
        ...request,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };
      queue.push(entry);
      this.queues.set(sessionKey, queue);

      // 超時自動移出（跟隨 turnTimeoutMs，至少 120s）
      const queueTimeoutMs = Math.max(config.turnTimeoutMs ?? 300_000, TURN_QUEUE_TIMEOUT_MS_DEFAULT);
      const timeoutId = setTimeout(() => {
        const q = this.queues.get(sessionKey);
        if (q) {
          const idx = q.indexOf(entry);
          if (idx >= 0) {
            q.splice(idx, 1);
            reject(new Error(`TIMEOUT: 排隊超過 ${Math.round(queueTimeoutMs / 1000)}s，自動移出`));
          }
        }
      }, queueTimeoutMs);

      // 若是第一個 → 立即 resolve（不等待）
      if (queue.length === 1) {
        clearTimeout(timeoutId);
        resolve();
      } else {
        // 等待前一個 dequeue
        (entry as unknown as Record<string, unknown>)["_timeoutId"] = timeoutId;
      }
    });
  }

  /** 前一個 turn 完成，讓下一個開始 */
  dequeueTurn(sessionKey: string): void {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length === 0) return;

    queue.shift();  // 移除剛完成的

    if (queue.length > 0) {
      const next = queue[0];
      // 清理超時計時器
      const timeoutId = (next as unknown as Record<string, unknown>)["_timeoutId"];
      if (timeoutId) clearTimeout(timeoutId as ReturnType<typeof setTimeout>);
      next.resolve();  // 讓下一個 turn 開始
    } else {
      this.queues.delete(sessionKey);
    }
  }

  getQueueDepth(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  /**
   * 清除 sessionKey 的等待佇列（保留正在執行的 position=0）
   * 回傳被取消的 turn 數量
   */
  clearQueue(sessionKey: string): number {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length <= 1) return 0;

    const waiting = queue.splice(1); // 移除 position 1+，留下正在執行的 0
    let count = 0;
    for (const entry of waiting) {
      const timeoutId = (entry as unknown as Record<string, unknown>)["_timeoutId"];
      if (timeoutId) clearTimeout(timeoutId as ReturnType<typeof setTimeout>);
      entry.reject(new Error("CANCELLED: queue cleared by /stop clear"));
      count++;
    }
    log.debug(`[session] clearQueue ${sessionKey}：已取消 ${count} 條排隊`);
    return count;
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────────

  private sessionPath(sessionKey: string): string {
    // sessionKey 可能含 : 等字元，轉底線安全存檔
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.persistDir, `${safe}.json`);
  }

  private persist(session: Session): void {
    try {
      const filePath = this.sessionPath(session.sessionKey);
      const tmpPath  = filePath + ".tmp";
      const sessionJson = JSON.stringify(session);
      const checksum = createHash("sha256").update(sessionJson).digest("hex");
      const withChecksum = JSON.stringify({ ...session, _checksum: checksum }, null, 2);
      writeFileSync(tmpPath, withChecksum, "utf-8");
      renameSync(tmpPath, filePath);  // atomic write
    } catch (err) {
      log.warn(`[session] persist 失敗 ${session.sessionKey}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadAll(): void {
    try {
      const files = readdirSync(this.persistDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const filePath = join(this.persistDir, f);
        try {
          const raw = readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw) as Session & { _checksum?: string };
          const { _checksum, ...sessionData } = parsed;
          if (_checksum) {
            const expected = createHash("sha256").update(JSON.stringify(sessionData)).digest("hex");
            if (expected !== _checksum) {
              const bakPath = filePath + ".bak";
              try { if (existsSync(bakPath)) unlinkSync(bakPath); } catch { /* 靜默 */ }
              try { renameSync(filePath, bakPath); } catch { /* 靜默 */ }
              log.warn(`[session] checksum 驗證失敗，已備份：${filePath}`);
              continue;
            }
          }
          // 通過驗證或無 _checksum（舊格式向下相容）
          const session = sessionData as Session;
          this.sessions.set(session.sessionKey, session);
        } catch { /* 損壞的 session 檔，跳過 */ }
      }
    } catch { /* 目錄不存在 */ }
  }

  private cleanExpired(): void {
    const ttlMs = (this.cfg.ttlHours ?? 168) * 3600_000;
    const cutoff = Date.now() - ttlMs;
    try {
      const files = readdirSync(this.persistDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const filePath = join(this.persistDir, f);
        try {
          const raw = readFileSync(filePath, "utf-8");
          const { lastActiveAt, sessionKey } = JSON.parse(raw) as Session;
          if (lastActiveAt < cutoff) {
            unlinkSync(filePath);
            log.debug(`[session] 清除過期 ${f}`);
            this.eventBus?.emit("session:end", sessionKey);
          }
        } catch { /* 損壞，刪除 */
          try { unlinkSync(filePath); } catch { /* 靜默 */ }
        }
      }
    } catch { /* 靜默 */ }
  }
}

// ── Session Key 工具函式 ──────────────────────────────────────────────────────

/**
 * 產生 session key（含平台前綴）
 * - 群組頻道（isDm=false）：`{platform}:ch:{channelId}`
 * - DM（isDm=true）：`{platform}:dm:{accountId}:{channelId}`
 *
 * 持久化檔名：`:` → `_`，例如 `discord_ch_111.json`
 */
export function makeSessionKey(channelId: string, accountId: string, isDm: boolean, platform = "discord"): string {
  return isDm ? `${platform}:dm:${accountId}:${channelId}` : `${platform}:ch:${channelId}`;
}

// ── 路徑解析 ──────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : resolve(p);
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _manager: SessionManager | null = null;

export function initSessionManager(cfg: SessionConfig, eventBus?: SessionEventBus): SessionManager {
  _manager = new SessionManager(cfg, eventBus);
  return _manager;
}

export function getSessionManager(): SessionManager {
  if (!_manager) throw new Error("[session] SessionManager 尚未初始化，請先呼叫 initSessionManager()");
  return _manager;
}

export function resetSessionManager(): void {
  _manager = null;
}
