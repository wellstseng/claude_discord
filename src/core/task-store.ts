/**
 * @file core/task-store.ts
 * @description Per-session task management — 結構化任務追蹤
 *
 * 每個 session（channelId）維護一份任務列表，LLM 可透過 tool 建立、更新、查詢任務。
 * 生命週期跟隨 session，不持久化。
 */

import { randomUUID } from "node:crypto";

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

// ── TaskStore ────────────────────────────────────────────────────────────────

export class TaskStore {
  private tasks = new Map<string, Task>();
  private counter = 0;

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

    // 刪除
    if (updates.status === "completed") {
      // 自動解除 blocks 關聯（被此任務阻擋的任務移除 blockedBy 中此 id）
      for (const bid of task.blocks) {
        const other = this.tasks.get(bid);
        if (other) other.blockedBy = other.blockedBy.filter(b => b !== id);
      }
    }

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
    return this.tasks.delete(id);
  }

  clear(): void {
    this.tasks.clear();
    this.counter = 0;
  }
}

// ── Per-session store ────────────────────────────────────────────────────────

const stores = new Map<string, TaskStore>();

export function getTaskStore(sessionKey: string): TaskStore {
  let store = stores.get(sessionKey);
  if (!store) {
    store = new TaskStore();
    stores.set(sessionKey, store);
  }
  return store;
}

export function deleteTaskStore(sessionKey: string): void {
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
