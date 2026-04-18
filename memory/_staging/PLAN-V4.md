# CatClaw V4 計畫書：Agent 能力強化

> 版本：V4.0（草案）
> 日期：2026-03-27
> 前置：V3 自律化 Agent 編排（platform-rebuild branch）完成並 merge main

---

## V4 主題：可靠性 + 工具能力擴充

V4 目標：在 V3 子 agent 編排基礎上，強化執行可靠性（重試、failover）、提升工具表達力（llm-task、session 控制），並完善 context 防護機制。

---

## Sprint 總覽

| Sprint | 主題 | 功能 | 前置 | 狀態 |
|--------|------|------|------|------|
| V4-1 | 重試可靠性 | 重試 + backoff、Thinking level failover | - | ✅ |
| V4-2 | Context 防護 | Tool result context guard、Context overflow 三段 failover | V4-1 | ✅ |
| V4-3 | 工具能力 | llm-task tool、session_status、sessions_send 喚醒 | V4-1 | ✅ |
| V4-4 | 編排進階 | allowNestedSpawn、Subagent 間通訊（pipeline） | V4-1 | ✅ |
| V4-5 | 記憶整合 | Subagent 結果寫入記憶、Vector search 啟用 | V4-3 | ✅ |
| V4-6 | 排程整合 | Cron + subagent | V4-4 | ✅ |

依賴關係：V4-1 → V4-2, V4-3, V4-4 → V4-5 → V4-6

---

## V4-1：重試可靠性

### 目標
agentLoop 的 LLM 呼叫從「失敗即回傳 error」升級為「帶重試 + backoff 的穩健呼叫」。

### 功能 1：重試 + backoff

**影響檔案：** `src/core/agent-loop.ts`、`src/providers/types.ts`

**設計：**
```
重試參數（AgentLoopOpts 新增）：
  retryMaxAttempts?: number  // 預設 3
  retryBaseMs?: number       // 預設 1000ms
  retryMaxMs?: number        // 預設 30000ms

重試觸發條件：
  - HTTP 429（rate limit）→ 讀 Retry-After header，否則 backoff
  - HTTP 5xx（server error）→ exponential backoff
  - Network error / timeout → exponential backoff
  - HTTP 4xx（非 429）→ 不重試，直接 error

backoff 計算：
  delay = min(baseMs * 2^(attempt-1) + jitter, maxMs)
  jitter = random(0, baseMs * 0.1)
```

**實作步驟：**
1. `src/providers/types.ts` — `LLMCallError` 新增 `retryable: boolean`、`retryAfterMs?: number`
2. `src/core/agent-loop.ts` — 抽出 `callLLMWithRetry()` wrapper，包裝 provider.call()
3. AgentLoopOpts 新增重試參數，有預設值
4. 重試日誌：`log.warn([agent-loop] retry attempt=N err=...)`

### 功能 2：Thinking level failover

**影響檔案：** `src/providers/registry.ts` 或各 provider adapter

**設計：**
```
如果 provider 不支援 thinking（如舊版 claude-instant、第三方 provider）：
  → 捕獲 "thinking not supported" 類型的 error
  → 自動以 thinking:false 重試一次
  → 不拋出 error，透明降級
```

**實作步驟：**
1. Provider adapter（claude-api）捕獲 thinking 相關 4xx error
2. 降級後設 `opts.thinkingEnabled = false` 重試
3. 記錄降級事件到 log.info

---

## V4-2：Context 防護

### 目標
防止單個 tool result 或累積 context 炸掉 token 預算。

### 功能 3：Tool result context guard

**影響檔案：** `src/core/agent-loop.ts`、`src/tools/types.ts`

**設計：**
```
每個 tool 執行後，結果寫入 messages 前先檢查：
  - 單次 result 超過 maxResultTokens（預設 8000 tokens）→ 截斷 + 附加 [截斷提示]
  - 可在 tool 定義加 resultTokenCap?: number 覆寫 per-tool 上限

截斷策略：
  - 保留前 N 行 + 末尾 M 行（頭尾保留，中間省略）
  - 附加：[結果過長，已截斷。完整輸出共 X 行，顯示前 50 行 + 末 20 行]
```

**影響 Tool 定義：**
```typescript
interface Tool {
  // 現有欄位...
  resultTokenCap?: number  // 新增，覆寫全域預設
}
```

### 功能 4：Context overflow 三段 failover

**影響檔案：** `src/core/context-engineering.ts`（或 CE 相關）

**設計：**
```
第一段（已有）：CE compaction → 壓縮舊 turns
第二段（新增）：超過 budgetGuard.maxUtilization 且壓縮後仍超 →
  強制截斷最舊的 N 個 messages（保留 system + 最近 M turns）
第三段（新增）：截斷後仍超 →
  停止執行，回傳 error type="context_overflow"
  Discord 顯示：「Context 已達上限，建議輸入 /rollback 或開新對話」
```

---

## V4-3：工具能力

### 功能 5：llm-task tool

**新增檔案：** `src/tools/builtin/llm-task.ts`

**設計：**
```
單次 LLM 呼叫，指定 JSON schema 輸出，不跑 tools、不累積 session。
適合：分類、評分、摘要、條件判斷等結構化子任務。

參數：
  prompt: string          // 任務描述
  schema: object          // JSON schema（期望輸出格式）
  provider?: string       // 指定 provider（預設繼承父）
  model?: string          // 指定 model
  timeoutMs?: number      // 逾時（預設 30000）

回傳：
  { result: <schema 結構>, raw: string, model: string }
```

**實作步驟：**
1. 建立 `llm-task.ts`，直接呼叫 provider.call() 一次（不用 agentLoop）
2. system prompt = "回傳符合指定 JSON schema 的結果，不要其他文字"
3. 解析 response 為 JSON，驗證 schema
4. JSON 解析失敗 → 回傳 error（不重試，讓父 agent 決定）
5. 標準 tier tool，allowSpawn:false 環境也可使用

### 功能 6：session_status

**修改檔案：** `src/tools/builtin/subagents.ts`（新增 action）

**設計：**
```
action: "status"
params: { runId: string }

回傳：
  {
    runId, status, label, task,
    turns, createdAt, endedAt,
    durationMs, childSessionKey
  }
```

### 功能 7：sessions_send 喚醒機制

**設計：**
```
現有 steer（注入訊息）不會喚醒已 idle 的子 agent。
喚醒機制：
  - 子 session 仍在 running 狀態 → 直接 steer（現有行為）
  - 子 session 已 completed 但 keepSession:true →
      重新建立 agentLoop（非 async），注入 steer 訊息，繼續執行
  - 子 session keepSession:false 或已 killed → 回傳 error

params 新增：
  action: "resume"   // 喚醒已 idle 的 session
```

---

## V4-4：編排進階

### 功能 8：allowNestedSpawn

**影響檔案：** `src/tools/builtin/spawn-subagent.ts`、`src/core/agent-loop.ts`

**設計：**
```
spawn_subagent 新增參數：
  allowNestedSpawn?: boolean  // 預設 false

當 allowNestedSpawn: true 時：
  → agentLoop opts.allowSpawn = true（子 agent 可以再 spawn）
  → 但 depth 限制：最多 3 層（parent → child → grandchild）
  → grandchild 的 allowSpawn 強制 false

depth 追蹤：
  ToolContext 新增 spawnDepth: number（0 = 頂層 parent）
  每層 +1，≥ 2 時 allowSpawn 強制 false
```

### 功能 9：Subagent 間通訊（pipeline 模式）

**設計：**
```
spawn_subagent 新增參數：
  inputFrom?: string   // runId，從該子 agent 的 result 作為此 agent 的 task input

行為：
  1. 等待 inputFrom 對應的 runId 完成（polling registry）
  2. 取得其 result，前綴到 task 描述
  3. 再 spawn 本 agent

簡單 pipeline：
  const r1 = spawn(task1, async:true)
  const r2 = spawn(task2, inputFrom: r1.runId)  // 自動等待 r1 完成
```

---

## V4-5：記憶整合

### 功能 10：Subagent 結果寫入記憶

**設計：**
```
spawn_subagent 新增參數：
  saveToMemory?: boolean    // 預設 false
  memoryTag?: string        // 標籤，方便搜尋

完成時：
  registry.complete() 後，若 saveToMemory:true
  → 呼叫 MemoryEngine.save({ content: result, tag: memoryTag, source: "subagent" })
```

### 功能 11：Vector search 啟用

**前置：** Ollama 在線 + embedding model 可用

**設計：**
```
agentLoop opts 新增：
  memoryRecall?: { enabled: boolean, vectorSearch: boolean, topK: number }

執行前注入：
  若 memoryRecall.vectorSearch:true → 呼叫 MemoryEngine.search(task, topK)
  → 將 top K 結果注入 system prompt 的 context 區塊
```

---

## V4-6：排程整合

### 功能 12：Cron + subagent

**影響檔案：** `src/core/cron.ts`、`catclaw.json`

**設計：**
```
catclaw.json cron.jobs 新增 subagent 欄位：
  {
    "name": "daily-report",
    "cron": "0 9 * * *",
    "subagent": {
      "task": "產生昨日摘要報告",
      "runtime": "default",
      "provider": "claude-api",
      "notify": "discord:ch:1234567890"   // 完成後通知哪個頻道
    }
  }

Cron 觸發時：
  → 呼叫 spawn_subagent（async:true）
  → 完成後透過 subagent-discord-bridge 通知指定頻道
```

---

## V3 Optional 功能（尚未決定是否納入 V4）

| 功能 | 說明 | 優先度 |
|------|------|--------|
| **Tool 8-layer policy pipeline** | 現有 2 層（permission gate + safety guard）擴充至按 profile/group/sandbox/depth 層層過濾 | 中 |
| **Auth profile 輪替** | 多 API key 輪替 + cooldown + failover，支援長時間高並行任務 | 中 |

---

## 實作優先順序建議

1. **V4-1**（重試 + backoff）— 最高 CP 值，現在跑長任務容易因單次失敗中斷
2. **V4-2**（context 防護）— tool result guard 很快就能做，防止意外炸 context
3. **V4-3**（llm-task + session 控制）— llm-task 開啟結構化子任務場景
4. **V4-4/5/6** — 視實際使用需求排序
