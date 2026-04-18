# CatClaw V3 計畫書：自律化 Agent 編排（完整版）

> 版本：V3.2
> 日期：2026-03-27
> 前置：V2 平台（platform-rebuild branch）已完成

---

## V3 主題：自律化（Autonomous Orchestration）

V3 目標：讓 agent 能自主拆解任務、派遣子 agent 分工並行執行，支援一次性與持久兩種模式。

---

## 核心架構決策

### 同步 vs 非同步

| 模式 | async: false（預設） | async: true |
|------|---------------------|-------------|
| spawn 回傳 | 等待完成後回傳 SpawnResult | 立即回傳 `{ status: "spawned", runId }` |
| 父 agent | 阻塞等待 | 繼續執行，子背景跑 |
| 完成通知 | tool_result 直接帶回 | Discord channel 推送 + registry 更新 |
| 適合 | 短/中任務、需要結果才能繼續 | 長任務、可以先回覆使用者再等結果 |

兩條路都走，SUB-1 先做同步（穩定），SUB-4 加非同步（背景執行）。

### 子 agent 兩層限制

- `allowSpawn: false` 傳給子 agentLoop → **邏輯面**過濾，子 agent 看不到 spawn 工具
- 非 prompt 說「不行」，是 tool list 直接不含此 tool

### 並行執行

同一輪 LLM response 含多個 `spawn_subagent` → `Promise.all()` 並行，時間 = max(A,B)。
（只有 spawn_subagent 並行，其他有副作用的 tool 維持串行）

---

## SpawnResult 格式

```typescript
type SpawnResult =
  | { status: "completed";  result: string; sessionKey: string; turns: number }
  | { status: "spawned";    runId: string; sessionKey: string }   // async mode
  | { status: "timeout";    result: null }
  | { status: "error";      error: string }
  | { status: "forbidden";  reason: "no_spawn_allowed" | "max_concurrent" }
```

---

## Sprint 規劃

### S-V3-1：Subagent 核心 spawn（同步模式）

**目標**：LLM 能呼叫 `spawn_subagent` tool，子 loop 隔離執行並同步回傳結果，支援並行。

#### `src/core/subagent-registry.ts`（新建）

```typescript
interface SubagentRunRecord {
  runId: string
  parentSessionKey: string
  childSessionKey: string         // 格式：{parent}:sub:{uuid}
  task: string
  label?: string
  mode: "run" | "session"         // one-shot | 持久
  async: boolean
  status: "running" | "completed" | "failed" | "killed" | "timeout"
  result?: string
  error?: string
  abortController: AbortController
  discordChannelId?: string       // async 模式通知用
  keepSession: boolean
  createdAt: number
  endedAt?: number
}

class SubagentRegistry {
  spawn(opts): SubagentRunRecord
  get(runId): SubagentRunRecord | undefined
  listByParent(parentSessionKey, recentMinutes?): SubagentRunRecord[]
  kill(runId): void
  complete(runId, result): void
  fail(runId, error): void
  timeout(runId): void
  countRunning(parentSessionKey): number
}
// max concurrent = 3 per parent session
```

#### `src/tools/builtin/spawn-subagent.ts`（新建）

```typescript
{
  name: "spawn_subagent",
  description: `產生隔離子 agent 執行任務。
- async:false（預設）：同步等待完成，結果直接回傳。
- async:true：立即回傳 runId，子 agent 背景執行，完成時推送 Discord 通知。
多個任務可同時呼叫（同一輪並行執行，時間 = max）。`,
  input_schema: {
    task: string,
    label?: string,
    provider?: string,          // 指定 provider ID（預設繼承父）
    runtime?: "default" | "coding", // coding = 精簡工具組（read/write/bash）
    maxTurns?: number,          // 預設 10
    timeoutMs?: number,         // 預設 120000
    async?: boolean,            // 預設 false
    keepSession?: boolean,      // 完成後保留 session（持久模式 / debug）
    mode?: "run" | "session",   // session = 持久，需搭配 keepSession:true
    attachments?: Array<{
      name: string,
      content: string,
      encoding?: "utf8" | "base64"
    }>
  }
}

// 執行流程（sync）
async function executeSpawnSubagent(params, ctx):
  1. 檢查 allowSpawn → forbidden
  2. 檢查 concurrent >= 3 → forbidden
  3. 建立 childSessionKey：{parentKey}:sub:{uuid}
  4. 注入 subagent system prompt
  5. if async: false → Promise.race(agentLoop, timeout) → SpawnResult
     if async: true  → agentLoop 背景執行，立即回傳 { status: "spawned", runId }
  6. 完成後若 !keepSession → 刪除 child session
```

#### `src/core/agent-loop.ts` 修改

- `allowSpawn?: boolean`（預設 true），子 agent 傳 false
- **並行**：同一輪多個 spawn_subagent → Promise.all()，其他 tool 串行
- 父 /stop → linked abort 傳給所有子 AbortController

**Subagent system prompt（預設模式）**
```
你是一個專門執行子任務的 agent。完成以下任務後回傳結果。
你沒有 spawn_subagent 工具。
任務：{task}
{attachments_hint}
```

**Coding runtime system prompt**
```
你是一個程式碼執行 agent。只使用 read_file / write_file / bash 工具。
不要做社交互動，只做技術任務。
任務：{task}
```

**通過條件**
- [ ] 父 agent 呼叫 spawn_subagent → 子 loop 完畢 → 父收到 SpawnResult
- [ ] 子 agent tool list 不含 spawn_subagent（邏輯確認）
- [ ] 同一輪 2 個 spawn → 並行執行，時間 < 串行總和
- [ ] timeout → `{ status: "timeout" }`
- [ ] concurrent 超限 → `{ status: "forbidden" }`
- [ ] 父 /stop → 子 AbortController 觸發

---

### S-V3-2：管理工具（list / kill / steer）+ keepSession + /subagents Skill

**目標**：LLM 與使用者都能查看、終止、轉向子 agent。

#### `src/tools/builtin/subagents.ts`（新建）

```typescript
{
  name: "subagents",
  input_schema: {
    action: "list" | "kill" | "steer",
    runId?: string,       // kill/steer 指定；kill 省略 = kill all
    message?: string,     // steer 用
    recentMinutes?: number
  }
}
// steer 機制：SessionManager.append(childSessionKey, { role:"user", content: message })
// 子 loop 下一輪自然讀到新指令
```

#### `src/skills/builtin/subagents.ts`（新建）

```
/subagents              → 列出所有子 agent（表格：runId/label/status/執行時間/provider）
/subagents kill <id>    → 終止指定
/subagents kill all     → 終止所有
```

#### `catclaw.json` 新增

```jsonc
"subagents": {
  "maxConcurrent": 3,
  "defaultTimeoutMs": 120000,
  "defaultKeepSession": false
}
```

**通過條件**
- [ ] `/subagents` 回覆狀態表
- [ ] `/subagents kill <runId>` 終止，AbortController 觸發
- [ ] `subagents(action:"steer")` 注入後子下一輪收到
- [ ] `keepSession:true` 完成後 session 保留

---

### S-V3-3：Multi-Provider + Workspace 繼承 + Attachments + Coding Runtime

**目標**：子 agent 可指定不同 provider；繼承父工作目錄；spawn 時可帶資料；coding 精簡工具組。

#### Attachments 處理

- spawn 前寫入 `{workspaceDir}/attachments/{uuid}/`
- 子 system prompt 尾部注入：`可用附件：{name1}（位於 attachments/{uuid}/）`
- `keepSession:false` → 完成後清除 attachments 目錄

#### Coding Runtime

- `runtime: "coding"` → toolList 只含 `read_file / write_file / bash`
- system prompt 強調技術角色，無社交工具

**通過條件**
- [ ] `provider:"codex"` 子 agent 確實使用 CodexOAuthProvider
- [ ] 子 agent 能讀寫父設定的 workspaceDir
- [ ] attachments 寫入正確路徑，子 system prompt 含附件說明
- [ ] `runtime:"coding"` 子 agent tool list 只含三個工具

---

### S-V3-4：非同步模式 + 完成通知 Discord

**目標**：長任務子 agent 背景執行，完成後推送 Discord 通知，父 agent 不阻塞。

#### spawn_subagent `async: true` 路徑

```typescript
// spawn 時記錄 discordChannelId（從 agentLoopOpts 傳入）
registry.record.discordChannelId = ctx.channelId

// 背景執行
const runPromise = runChildAgentLoop(task, childOpts)
runPromise
  .then(result => {
    registry.complete(runId, result.text)
    if (record.discordChannelId) {
      notifyDiscordCompletion(record)  // 推送 Discord 訊息
    }
  })
  .catch(err => {
    registry.fail(runId, err.message)
    notifyDiscordCompletion(record, { error: true })
  })

// 立即回傳
return { status: "spawned", runId, sessionKey: childKey }
```

#### Discord 完成通知

```typescript
async function notifyDiscordCompletion(record: SubagentRunRecord, opts?):
  // 找到 Discord client
  const channel = discordClient.channels.cache.get(record.discordChannelId)
  const label = record.label ?? `子任務 ${record.runId.slice(0,8)}`

  if opts?.error:
    channel.send(`❌ **${label}** 失敗：${record.error}`)
  else:
    const preview = record.result?.slice(0, 500)
    channel.send(`✅ **${label}** 完成\n${preview}`)
```

#### `subagents(action:"wait", runId, timeoutMs?)` 新增

父 agent 在需要結果時可以主動等待：
```typescript
// 輪詢 registry 直到 status !== "running"（max timeoutMs）
// 回傳 SpawnResult（completed/timeout/error/killed）
```

**通過條件**
- [ ] `async:true` spawn 立即回傳 `{ status:"spawned", runId }`
- [ ] 子 agent 完成後 Discord 頻道收到通知訊息（含 label + 結果摘要）
- [ ] 子 agent 失敗後 Discord 頻道收到錯誤通知
- [ ] `subagents(action:"wait", runId)` 能等到結果

---

### S-V3-5：持久子 Agent（mode: session）+ Discord Thread 綁定

**目標**：子 agent 完成後 session 保留並與 Discord thread 綁定，使用者可直接在 thread 繼續對話。

#### spawn 時建立 Discord thread

```typescript
// mode: "session" 時
if params.mode === "session":
  1. 建立 Discord thread（from 原始訊息）
  2. 記錄 threadId → childSessionKey binding
  3. 在 thread 第一則訊息：「已建立子 agent：{label}，在此 thread 繼續對話」
  4. 子 agent 完成 task 後保持 alive（session 不刪）
  5. thread 內後續訊息 → 直接路由到 childSessionKey，不經父 session
```

#### Discord 訊息路由修改（`discord.ts`）

```typescript
// preflight 新增一個 check：
// 若 message.channelId 在 subagentThreadBindings →
//   直接 agentLoop(prompt, { sessionKey: boundChildKey, platform:"discord" })
//   跳過父 session routing
```

#### SubagentRegistry 新增 thread binding

```typescript
interface SubagentRunRecord {
  ...
  discordThreadId?: string      // mode:session 時綁定的 thread ID
}

// 新增方法
getByThreadId(threadId: string): SubagentRunRecord | undefined
```

**通過條件**
- [ ] `mode:"session"` spawn → Discord thread 建立，第一則說明訊息
- [ ] 子 agent 完成 task 後 session 保留（不清除）
- [ ] 在 thread 輸入訊息 → 路由到子 session，不經父
- [ ] `/subagents` 能看到 persistent 子 agent 及其 threadId

---

### S-V3-6：ACP-Like Coding Runtime（CLI 子 agent）

**目標**：spawn_subagent 可以指定使用 Claude Code CLI 作為子 agent 執行體（對應 OpenClaw ACP）。

#### `runtime: "acp"` 路徑

```typescript
// spawn 時若 runtime === "acp"
// 改用舊 Claude CLI 路徑（claude -p stream-json）而非新 agentLoop
// session key 仍隔離：{parent}:sub:acp:{uuid}
// 工具由 Claude Code 自己管理（--dangerously-skip-permissions 或 --allowedTools）
```

#### 為何需要

- 新 agentLoop 的工具是 CatClaw 自己定義的（有限）
- Claude Code CLI 有完整工具（ReadFile / Edit / Bash / WebSearch...）
- 複雜程式碼任務用 ACP 比自製 agentLoop 更強

#### 實作

```typescript
async function spawnAcpSubagent(task, opts):
  1. 建立隔離 session name（基於 childSessionKey）
  2. spawn: ["claude", "-p", "--output-format", "stream-json",
             "--resume", childSessionName,
             "--dangerously-skip-permissions",
             task]
  3. 解析 stream-json events → 累積 finalText
  4. 回傳 SpawnResult（與其他 runtime 格式一致）
```

**通過條件**
- [ ] `runtime:"acp"` spawn → 確認使用 claude CLI（log 驗證）
- [ ] 子 Claude Code 能使用 Edit/Bash 等工具完成程式碼任務
- [ ] 結果以相同 SpawnResult 格式回傳父 agent

---

## 新增 / 修改檔案清單

### 新建
```
src/core/subagent-registry.ts
src/tools/builtin/spawn-subagent.ts
src/tools/builtin/subagents.ts
src/skills/builtin/subagents.ts
```

### 修改
```
src/core/agent-loop.ts      allowSpawn / workspaceDir / 並行 tool / async 子 loop 啟動
src/core/config.ts          SubagentsConfig
src/core/platform.ts        初始化 SubagentRegistry 全域單例
src/discord.ts              thread binding 路由 + 完成通知 helper
src/tools/registry.ts       註冊 spawn-subagent / subagents
src/skills/registry.ts      註冊 /subagents
~/.catclaw-test/catclaw.json subagents 設定區塊
```

---

## Sprint 依賴關係

```
S-V3-1（核心 spawn：同步 + 並行 + allowSpawn）
    ↓
S-V3-2（list/kill/steer + keepSession + /subagents skill）
    ↓
S-V3-3（multi-provider + workspace + attachments + coding runtime）
    ↓
S-V3-4（非同步模式 + Discord 完成通知）        S-V3-6（ACP CLI 子 agent）
    ↓                                                 ↑ 可獨立，依賴 S-V3-1
S-V3-5（持久子 agent + Discord thread 綁定）
```

---

## 與 OpenClaw 功能完整對照

| OpenClaw 功能 | CatClaw V3 對應 | Sprint |
|--------------|----------------|--------|
| sessions_spawn（同步） | spawn_subagent（async:false） | SUB-1 |
| SubagentRegistry | SubagentRegistry | SUB-1 |
| 並行執行 | Promise.all() 並行 tool | SUB-1 |
| allowSpawn 限制 | allowSpawn:false 邏輯面 | SUB-1 |
| Timeout | Promise.race + AbortController | SUB-1 |
| subagents list/kill | subagents tool + /subagents | SUB-2 |
| steer | subagents(action:"steer") | SUB-2 |
| cleanup:keep | keepSession:true | SUB-2 |
| Multi-provider | provider 參數 | SUB-3 |
| Workspace 繼承 | workspaceDir 繼承 | SUB-3 |
| Attachments | attachments 寫檔 + prompt 注入 | SUB-3 |
| sessions_spawn（非同步） | spawn_subagent（async:true） | SUB-4 |
| Completion announcement Discord | Discord 完成通知 | SUB-4 |
| subagents wait | subagents(action:"wait") | SUB-4 |
| mode:session（持久） | mode:"session" + thread 綁定 | SUB-5 |
| ACP runtime（Claude Code） | runtime:"acp" CLI 子 agent | SUB-6 |

---

## V3 後續 Optional 功能（不在 V3 Sprint 內，視需求評估）

| 功能 | 說明 | 優先度 |
|------|------|--------|
| **Tool 8-layer policy pipeline** | 現有 2 層（permission gate + safety guard）擴充至按 profile/group/sandbox/depth 層層過濾 | 中 |
| **Auth profile 輪替** | 多 API key 輪替 + cooldown + failover，支援長時間高並行任務 | 中 |

---

## V4 未來方向

→ 詳見 [PLAN-V4.md](PLAN-V4.md)

---

## V2 → V3 差異總覽

| 層次 | V2 | V3 |
|------|----|----|
| 執行模式 | 單一 agent loop | 父 + 子（2 層，父 spawn，子不可 spawn） |
| 子 agent 模式 | 無 | one-shot（sync/async）+ 持久（session）+ ACP |
| Provider | 多 provider 路由 | 每個子 agent 可獨立指定 provider |
| Session | 單一 per channel | parent + child（隔離，完成後依設定清理） |
| 並行 | 無 | 同一輪多個 spawn 並行（Promise.all） |
| 使用者操控 | /stop /rollback /queue /turn-audit | + /subagents list/kill |
| LLM 操控 | 無子 agent 管理 | subagents tool（list/kill/steer/wait） |
| Discord 整合 | 收訊/回覆 | + 子 agent 完成通知 + thread 綁定路由 |
| 資料傳遞 | prompt 文字 | prompt + attachments 檔案 |
| Context 隔離 | CE 壓縮 | 子 agent 獨立 context，父不受污染 |
