/**
 * @file hooks/file-watcher.ts
 * @description FileWatcher — 通用外部檔案監聽 → FileChanged / FileDeleted hook event
 *
 * 5 層迴圈防護：
 * L1: suppressPath() API — hook 腳本主動抑制
 * L2: Hook Execution Context — hook 執行期間自動抑制
 * L3: Per-Path Cooldown — 同一路徑觸發後冷卻
 * L4: Global Rate Limit — 全域事件速率限制
 * L5: CATCLAW_HOOK_DEPTH（既有機制）
 */

import { watch, statSync, readdirSync, readFileSync, existsSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { FileWatchEntry, FileWatcherConfig } from "../core/config.js";
import { getHookRegistry } from "./hook-registry.js";

// ── 全域 singleton ──────────────────────────────────────────────────────────

let _instance: FileWatcher | null = null;

export function getFileWatcher(): FileWatcher | null {
  return _instance;
}
export function setFileWatcher(fw: FileWatcher): void {
  _instance = fw;
}

// ── FileWatcher class ───────────────────────────────────────────────────────

export class FileWatcher {
  private watchers = new Map<string, FSWatcher[]>();
  private entries = new Map<string, FileWatchEntry>();

  // Debounce
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  // Content hash dedup
  private contentHashes = new Map<string, string>();

  // L1: Write Suppression
  private suppressedPaths = new Map<string, number>();

  // L2: Hook Execution Context
  private _hookDepth = 0;

  // L3: Per-Path Cooldown
  private pathCooldowns = new Map<string, number>();

  // L4: Global Rate Limit
  private eventCount = 0;
  private eventWindowStart = Date.now();
  private maxEventsPerWindow: number;
  private eventWindowMs: number;

  constructor(
    entries: FileWatchEntry[],
    config?: Pick<FileWatcherConfig, "maxEventsPerWindow" | "eventWindowMs">,
  ) {
    this.maxEventsPerWindow = config?.maxEventsPerWindow ?? 50;
    this.eventWindowMs = config?.eventWindowMs ?? 60_000;
    for (const entry of entries) {
      this.entries.set(entry.label, entry);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    for (const [label, entry] of this.entries) {
      this._startWatch(label, entry);
    }
    log.info(`[file-watcher] 啟動 ${this.entries.size} 個監聽點`);
  }

  stop(): void {
    for (const [label, fswList] of this.watchers) {
      for (const fsw of fswList) fsw.close();
      log.debug(`[file-watcher] 停止監聽: ${label}`);
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    log.info("[file-watcher] 所有監聽已停止");
  }

  // ── L1: Write Suppression API ─────────────────────────────────────────────

  suppressPath(filePath: string, durationMs = 5000): void {
    this.suppressedPaths.set(filePath, Date.now() + durationMs);
  }

  // ── L2: Hook Execution Context API ────────────────────────────────────────

  enterHookContext(): void {
    this._hookDepth++;
  }

  leaveHookContext(): void {
    this._hookDepth = Math.max(0, this._hookDepth - 1);
  }

  // ── Dynamic Management API ────────────────────────────────────────────────

  addWatch(entry: FileWatchEntry): string {
    if (this.entries.has(entry.label)) {
      this.removeWatch(entry.label);
    }
    this.entries.set(entry.label, entry);
    this._startWatch(entry.label, entry);
    log.info(`[file-watcher] 動態新增監聽: ${entry.label} → ${entry.path}`);
    return `已新增監聽 "${entry.label}" → ${entry.path}`;
  }

  removeWatch(label: string): string {
    const fswList = this.watchers.get(label);
    if (fswList) {
      for (const fsw of fswList) fsw.close();
      this.watchers.delete(label);
    }
    this.entries.delete(label);
    log.info(`[file-watcher] 移除監聽: ${label}`);
    return `已移除監聽 "${label}"`;
  }

  listWatches(): Array<{ label: string; path: string; status: string; eventCount: number }> {
    const result: Array<{ label: string; path: string; status: string; eventCount: number }> = [];
    for (const [label, entry] of this.entries) {
      const fswList = this.watchers.get(label);
      result.push({
        label,
        path: entry.path,
        status: fswList && fswList.length > 0 ? "watching" : "stopped",
        eventCount: this.eventCount,
      });
    }
    return result;
  }

  // ── Internal: Watch Setup ─────────────────────────────────────────────────

  private _startWatch(label: string, entry: FileWatchEntry): void {
    const resolvedPath = this._expandHome(entry.path);
    if (!existsSync(resolvedPath)) {
      log.warn(`[file-watcher] 路徑不存在，跳過: ${resolvedPath}`);
      return;
    }

    const recursive = entry.recursive !== false;
    const fswList: FSWatcher[] = [];

    try {
      if (recursive) {
        // Node.js fs.watch recursive option (macOS/Windows 原生支援)
        const fsw = watch(resolvedPath, { recursive: true }, (eventType, filename) => {
          if (filename) this._onFsEvent(label, resolvedPath, filename);
        });
        fsw.on("error", (err) => {
          log.warn(`[file-watcher] watcher error (${label}): ${err.message}`);
        });
        fswList.push(fsw);
      } else {
        const fsw = watch(resolvedPath, (eventType, filename) => {
          if (filename) this._onFsEvent(label, resolvedPath, filename);
        });
        fsw.on("error", (err) => {
          log.warn(`[file-watcher] watcher error (${label}): ${err.message}`);
        });
        fswList.push(fsw);
      }
      this.watchers.set(label, fswList);
      log.info(`[file-watcher] 開始監聽: ${label} → ${resolvedPath} (recursive=${recursive})`);
    } catch (err) {
      log.warn(`[file-watcher] 無法監聽 ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Internal: Event Processing ────────────────────────────────────────────

  private _onFsEvent(label: string, rootDir: string, filename: string): void {
    const entry = this.entries.get(label);
    if (!entry) return;

    const filePath = join(rootDir, filename);

    // 基礎過濾
    if (this._shouldIgnore(entry, filePath)) return;

    // Debounce
    const debounceMs = entry.debounceMs ?? 1500;
    const timerKey = `${label}:${filePath}`;
    const existing = this.debounceTimers.get(timerKey);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(timerKey, setTimeout(() => {
      this.debounceTimers.delete(timerKey);
      this._processChange(label, entry, filePath).catch((err) => {
        log.warn(`[file-watcher] processChange error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, debounceMs));
  }

  private async _processChange(label: string, entry: FileWatchEntry, filePath: string): Promise<void> {
    // L2: Hook Execution Context
    if (this._hookDepth > 0) {
      log.debug(`[file-watcher] skip (hook context): ${filePath}`);
      return;
    }

    // L1: Write Suppression
    const suppressExpire = this.suppressedPaths.get(filePath);
    if (suppressExpire) {
      if (Date.now() < suppressExpire) {
        log.debug(`[file-watcher] skip (suppressed): ${filePath}`);
        return;
      }
      this.suppressedPaths.delete(filePath);
    }

    // L3: Per-Path Cooldown
    const cooldownMs = entry.cooldownMs ?? 10_000;
    const lastFired = this.pathCooldowns.get(filePath) ?? 0;
    if (Date.now() - lastFired < cooldownMs) {
      log.debug(`[file-watcher] skip (cooldown): ${filePath}`);
      return;
    }

    // L4: Global Rate Limit
    if (Date.now() - this.eventWindowStart > this.eventWindowMs) {
      this.eventCount = 0;
      this.eventWindowStart = Date.now();
    }
    if (++this.eventCount > this.maxEventsPerWindow) {
      log.warn(`[file-watcher] rate limit (${this.maxEventsPerWindow}/${this.eventWindowMs}ms), skip: ${filePath}`);
      return;
    }

    // stat 判斷存在/已刪
    const registry = getHookRegistry();
    if (!registry) return;

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return;

      // Hash dedup — 只讀 < 10MB 的檔案
      if (stat.size > 10 * 1024 * 1024) {
        log.debug(`[file-watcher] skip hash (>10MB): ${filePath}`);
        return;
      }

      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const prevHash = this.contentHashes.get(filePath);

      if (prevHash === hash) {
        log.debug(`[file-watcher] skip (hash unchanged): ${filePath}`);
        return;
      }

      this.contentHashes.set(filePath, hash);
      this.pathCooldowns.set(filePath, Date.now());

      const changeType = prevHash ? "modify" : "create";
      log.info(`[file-watcher] FileChanged (${changeType}): ${filePath} [${label}]`);

      await registry.runFileChanged({
        event: "FileChanged",
        filePath,
        watchLabel: label,
        changeType,
      });
    } catch (err: unknown) {
      // 檔案不存在 = 已刪除
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.contentHashes.delete(filePath);
        this.pathCooldowns.set(filePath, Date.now());

        log.info(`[file-watcher] FileDeleted: ${filePath} [${label}]`);

        await registry.runFileDeleted({
          event: "FileDeleted",
          filePath,
          watchLabel: label,
        });
      } else {
        log.warn(`[file-watcher] stat error: ${(err as Error).message}`);
      }
    }
  }

  // ── Internal: Filter ──────────────────────────────────────────────────────

  private _shouldIgnore(entry: FileWatchEntry, filePath: string): boolean {
    const resolvedRoot = this._expandHome(entry.path);
    const rel = relative(resolvedRoot, filePath);
    const parts = rel.split("/");

    // 忽略目錄
    const ignoreDirs = entry.ignoreDirs ?? [".obsidian", ".trash", ".git"];
    for (const part of parts) {
      if (ignoreDirs.includes(part)) return true;
    }

    // 忽略 pattern（簡單 glob 匹配）
    if (entry.ignorePatterns) {
      const name = basename(filePath);
      for (const pattern of entry.ignorePatterns) {
        if (this._matchGlob(pattern, name)) return true;
      }
    }

    return false;
  }

  /** 簡易 glob 匹配（支援 * 和 ?） */
  private _matchGlob(pattern: string, str: string): boolean {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regex}$`).test(str);
  }

  private _expandHome(p: string): string {
    if (p.startsWith("~/") || p === "~") {
      return join(homedir(), p.slice(1));
    }
    return p;
  }
}
