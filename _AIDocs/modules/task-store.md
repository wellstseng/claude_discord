# modules/task-store — 任務 CRUD

> 檔案：`src/core/task-store.ts`
> 更新日期：2026-04-19

## 職責

Per-session 結構化任務追蹤。LLM 透過 tool 建立、更新、查詢任務。
支援磁碟持久化：未完成任務自動存檔至 `~/.catclaw/workspace/data/tasks/`，重啟後可載入。

## Task 型別

```typescript
type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: string;           // 自增數字（per-store）
  subject: string;
  description?: string;
  status: TaskStatus;
  blocks: string[];     // 此任務阻擋了哪些任務
  blockedBy: string[];  // 此任務被哪些任務阻擋
  createdAt: number;
  updatedAt: number;
}
```

## TaskStore API

```typescript
class TaskStore {
  constructor(sessionKey: string = "")
  create(subject: string, description?: string): Task
  get(id: string): Task | undefined
  list(filter?: { status?: TaskStatus }): Task[]    // 依 createdAt 排序
  update(id: string, updates: { subject?, description?, status?, addBlocks?, addBlockedBy? }): Task | undefined
  delete(id: string): boolean
  clear(): void
  loadFromDisk(): void                              // 從持久化檔案載入任務
}
```

### 持久化行為

- 每次 create / update / delete 自動 persist
- 只存未完成任務（completed 的不存）
- 所有任務 completed 時自動刪除持久化檔案
- 檔案格式：`tasks_{safeSessionKey}.json`（TaskStoreDump）

### 依賴管理

- `addBlocks` / `addBlockedBy` 自動建立雙向關聯
- 任務 completed → 自動解除被此任務阻擋的 blockedBy 關聯
- 任務 delete → 清理所有雙向關聯

## Per-Session Store

```typescript
initTaskPersistence(dir: string): void             // 初始化持久化目錄（platform.ts 呼叫）
getTaskStore(sessionKey: string): TaskStore         // 取得或建立（首次存取自動 loadFromDisk）
deleteTaskStore(sessionKey: string): void           // 清除（含磁碟檔案）
listAllTasks(): Array<{ sessionKey, tasks[] }>      // 供 dashboard 使用
loadAllPersistedTasks(): Array<{ sessionKey, tasks[] }>  // 載入所有持久化的未完成任務（重啟通知用）
```

每個 session（channelId）有獨立的 TaskStore 實例，透過 `sessionKey` 索引。

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `tools/task.ts` | LLM tool：task_create / task_update / task_list |
| `task-ui.ts` | 按鈕互動時 update/delete |
| `dashboard.ts` | `listAllTasks()` API |
| `session.ts` | session 結束時 `deleteTaskStore()` |
