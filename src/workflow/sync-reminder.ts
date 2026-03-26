/**
 * @file workflow/sync-reminder.ts
 * @description 同步提醒 — turn:after 後若有修改檔案，emit workflow:sync_needed
 *
 * 對應架構文件第 9 節「同步提醒」
 */

import { log } from "../logger.js";
import { getModifiedFiles, clearSession } from "./file-tracker.js";
import type { CatClawEvents } from "../core/event-bus.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
  emit<K extends keyof CatClawEvents>(event: K, ...args: CatClawEvents[K]): boolean;
};

// ── 設定 ──────────────────────────────────────────────────────────────────────

/** turn:after 後最少修改幾個檔案才發出提醒（0 = 任何修改都提醒） */
const MIN_FILES_TO_REMIND = 1;

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initSyncReminder(eventBus: EventBus): void {
  eventBus.on("turn:after", (ctx, _response) => {
    const files = getModifiedFiles(ctx.sessionKey);
    if (files.length >= MIN_FILES_TO_REMIND) {
      log.debug(`[sync-reminder] session ${ctx.sessionKey} 本 turn 共修改 ${files.length} 個檔案`);
      eventBus.emit("workflow:sync_needed", files);
    }
  });

  // session:end 後清理追蹤紀錄
  eventBus.on("session:end", (sessionId) => {
    clearSession(sessionId);
  });

  log.info("[sync-reminder] 初始化完成");
}
