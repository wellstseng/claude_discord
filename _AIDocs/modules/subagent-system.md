# Subagent System — 子 Agent 編排與追蹤

> 對應原始碼：`src/core/subagent-registry.ts`、`src/core/subagent-discord-bridge.ts`
> 更新日期：2026-04-06

## 概觀

Subagent 系統管理子 agent 的生命週期（spawn / kill / complete / fail / timeout）
並提供 Discord 橋接（async 完成通知、持久 thread 建立）。

## subagent-registry.ts

### 核心型別

```ts
type SubagentStatus = "running" | "completed" | "failed" | "killed" | "timeout";
type SubagentMode = "run" | "session";
type SubagentRuntime = "default" | "coding" | "acp" | "explore" | "plan" | "build" | "review";
```

### SubagentRunRecord

| 欄位 | 說明 |
|------|------|
| `runId` | UUID |
| `parentSessionKey` | 父 session key |
| `childSessionKey` | `{parent}:sub:{uuid}` |
| `task` | 任務描述 |
| `label?` | 顯示名稱（通知用） |
| `mode` | `"run"`（一次性）或 `"session"`（持久 thread） |
| `runtime` | Agent type（對應 agent-types.ts） |
| `async` | 是否非同步執行 |
| `status` | `running` / `completed` / `failed` / `killed` / `timeout` |
| `result?` | 完成結果文字 |
| `error?` | 錯誤訊息 |
| `abortController` | 中止控制器 |
| `discordChannelId?` | async 模式通知用 |
| `discordThreadId?` | mode:session thread 綁定 |
| `keepSession` | 是否保留 session |
| `accountId` | 繼承父 accountId |
| `createdAt` | 建立時間（epoch ms） |
| `endedAt?` | 結束時間（epoch ms） |
| `turns?` | 執行的 turn 數 |
| `parentId?` | 父 subagent runId（支援巢狀 spawn） |

### SpawnResult

```ts
type SpawnResult =
  | { status: "completed";  result: string; sessionKey: string; turns: number }
  | { status: "spawned";    runId: string; sessionKey: string }  // async
  | { status: "timeout";    result: null }
  | { status: "error";      error: string }
  | { status: "forbidden";  reason: "no_spawn_allowed" | "max_concurrent" };
```

### SubagentRegistry class

| 方法 | 說明 |
|------|------|
| `create(opts)` | 建立 RunRecord，回傳 record |
| `get(runId)` | 取得 record |
| `listByParent(parentKey, recentMinutes?)` | 列出某 parent 下的子 agent |
| `countRunning(parentKey)` | 計算 running 數量 |
| `isOverConcurrentLimit(parentKey)` | 是否超過 maxConcurrent（預設 3） |
| `kill(runId)` | 中止 + **級聯中止所有子 agent** |
| `killAll(parentKey)` | 中止某 parent 下所有 running |
| `complete(runId, result, turns?)` | 標記完成 |
| `fail(runId, error)` | 標記失敗 + 級聯中止子 agent |
| `timeout(runId)` | 標記逾時 |

全域單例：`initSubagentRegistry(maxConcurrent?)` / `getSubagentRegistry()`

### 級聯中止

`kill()` 和 `fail()` 會自動級聯中止所有 `parentId === runId` 且 running 的子 agent。

## subagent-discord-bridge.ts

### 功能

| 功能 | 說明 |
|------|------|
| **Thread Binding（SUB-5）** | `bindSubagentThread(threadId, childSessionKey)` — 建立 thread → session 對應 |
| **Thread 建立** | `createSubagentThread(channelId, msgId, label, childKey)` — 在原始訊息上開 thread |
| **Async 通知（SUB-4）** | `sendSubagentNotification(record, opts?)` — 完成/失敗時通知頻道 |

### Thread 路由

```
Discord Thread Message
  → getSubagentThreadBinding(channelId)
  → childSessionKey
  → 路由到子 agent 的 session
```

### 通知格式

- 成功：`✅ **{label}** 完成\n{result preview (500 chars)}`
- 失敗：`❌ **{label}** 失敗：{error}`
