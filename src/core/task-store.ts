/**
 * @file core/task-store.ts
 * @description Per-session task management — 結構化任務追蹤
 *
 * 每個 session（channelId）維護一份任務列表，LLM 可透過 tool 建立、更新、查詢任務。
 * 支援磁碟持久化：未完成任務自動存檔，重啟後可載入。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  /** 依賴：此任務阻擋了哪些任務 */
  blocks: string[];
  /** 依賴：此任務被哪些任務阻擋 */
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** 持久化時的檔案格式 */
interface TaskStoreDump {
  sessionKey: string;
  counter: number;
  tasks: Task[];
  savedAt: string;
}

// ── 持久化目錄 ──────────────────────────────────────────────────────────────

let _persistDir: string | null = null;

/** 初始化持久化目錄（由 platform.ts 呼叫） */
export function initTaskPersistence(dir: string): void {
  _persistDir = dir;
  mkdirSync(dir, { recursive: true });
}

function persistPath(sessionKey: string): string | null {
  if (!_persistDir) return null;
  // sessionKey 可能含 : 或其他特殊字元，用安全檔名
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(_persistDir, `tasks_${safe}.json`);
}

// ── TaskStore ────────────────────────────────────────────────────────────────

export class TaskStore {
  private tasks = new Map<string, Task>();
  private counter = 0;
  private sessionKey: string;
  private dirty = false;

  constructor(sessionKey: string = "") {
    this.sessionKey = sessionKey;
  }

  create(subject: string, description?: string): Task {
    const id = String(++this.counter);
    const task: Task = {
      id,
      subject,
      description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.persist();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus }): Task[] {
    let result = Array.from(this.tasks.values());
    if (filter?.status) {
      result = result.filter(t => t.status === filter.status);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  update(id: string, updates: Partial<Pick<Task, "subject" | "description" | "status">> & {
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.addBlocks) {
      for (const bid of updates.addBlocks) {
        if (!task.blocks.includes(bid)) task.blocks.push(bid);
        // 雙向關聯
        const other = this.tasks.get(bid);
        if (other && !other.blockedBy.includes(id)) other.blockedBy.push(id);
      }
    }
    if (updates.addBlockedBy) {
      for (const bid of updates.addBlockedBy) {
        if (!task.blockedBy.includes(bid)) task.blockedBy.push(bid);
        const other = this.tasks.get(bid);
        if (other && !other.blocks.includes(id)) other.blocks.push(id);
      }
    }

    task.updatedAt = Date.now();

    // 完成時自動解除 blocks 關聯
    if (updates.status === "completed") {
      for (const bid of task.blocks) {
        const other = this.tasks.get(bid);
        if (other) other.blockedBy = other.blockedBy.filter(b => b !== id);
      }
    }

    this.persist();
    return task;
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    // 清理雙向關聯
    for (const bid of task.blocks) {
      const other = this.tasks.get(bid);
      if (other) other.blockedBy = other.blockedBy.filter(b => b !== id);
    }
    for (const bid of task.blockedBy) {
      const other = this.tasks.get(bid);
      if (other) other.blocks = other.blocks.filter(b => b !== id);
    }
    const ok = this.tasks.delete(id);
    this.persist();
    return ok;
  }

  clear(): void {
    this.tasks.clear();
    this.counter = 0;
    this.removePersistFile();
  }

  // ── 持久化 ─────────────────────────────────────────────────────────────────

  /** 將未完成任務存檔 */
  private persist(): void {
    const fp = persistPath(this.sessionKey);
    if (!fp) return;

    const pending = this.list().filter(t => t.status !== "completed");
    if (pending.length === 0) {
      this.removePersistFile();
      return;
    }

    try {
      const dump: TaskStoreDump = {
        sessionKey: this.sessionKey,
        counter: this.counter,
        tasks: pending,
        savedAt: new Date().toISOString(),
      };
      writeFileSync(fp, JSON.stringify(dump, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[task-store] 持久化失敗 ${this.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removePersistFile(): void {
    const fp = persistPath(this.sessionKey);
    if (!fp) return;
    try { unlinkSync(fp); } catch { /* 檔案不存在也沒關係 */ }
  }

  /** 從磁碟載入任務 */
  loadFromDisk(): void {
    const fp = persistPath(this.sessionKey);
    if (!fp || !existsSync(fp)) return;

    try {
      const raw = JSON.parse(readFileSync(fp, "utf-8")) as TaskStoreDump;
      this.counter = raw.counter;
      for (const task of raw.tasks) {
        this.tasks.set(task.id, task);
      }
      log.debug(`[task-store] 已從磁碟載入 ${raw.tasks.length} 個任務 (${this.sessionKey})`);
    } catch (err) {
      log.warn(`[task-store] 載入失敗 ${this.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Per-session store ────────────────────────────────────────────────────────

const stores = new Map<string, TaskStore>();

export function getTaskStore(sessionKey: string): TaskStore {
  let store = stores.get(sessionKey);
  if (!store) {
    store = new TaskStore(sessionKey);
    store.loadFromDisk();
    stores.set(sessionKey, store);
  }
  return store;
}

export function deleteTaskStore(sessionKey: string): void {
  const store = stores.get(sessionKey);
  if (store) store.clear();
  stores.delete(sessionKey);
}

/** 列出所有 session 的 task（供 dashboard 使用） */
export function listAllTasks(): Array<{ sessionKey: string; tasks: Task[] }> {
  const result: Array<{ sessionKey: string; tasks: Task[] }> = [];
  for (const [key, store] of stores) {
    const tasks = store.list();
    if (tasks.length > 0) result.push({ sessionKey: key, tasks });
  }
  return result;
}

/** 載入所有持久化的未完成任務（重啟時用） */
export function loadAllPersistedTasks(): Array<{ sessionKey: string; tasks: Task[] }> {
  if (!_persistDir || !existsSync(_persistDir)) return [];

  const result: Array<{ sessionKey: string; tasks: Task[] }> = [];
  try {
    const files = readdirSync(_persistDir).filter(f => f.startsWith("tasks_") && f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(_persistDir, file), "utf-8")) as TaskStoreDump;
        const pending = raw.tasks.filter(t => t.status !== "completed");
        if (pending.length > 0) {
          result.push({ sessionKey: raw.sessionKey, tasks: pending });
          // 同時載入到記憶體 store
          const store = getTaskStore(raw.sessionKey);
          // getTaskStore 已經會呼叫 loadFromDisk，不需重複載入
        }
      } catch { /* 單一檔案損壞不影響其他 */ }
    }
  } catch (err) {
    log.warn(`[task-store] 掃描持久化目錄失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
