# modules/agent-loop — 核心對話迴圈

> 檔案：`src/core/agent-loop.ts` (~1880 行)
> 更新日期：2026-04-29

## 職責

一軌制 Agent Loop：CatClaw 控制所有 tool，LLM 只負責思考。

流程：
1. 身份 + 權限檢查
2. Session 歷史載入 + Context Engine 壓縮
3. Memory Recall（可選，子 agent / cron 使用）
4. System prompt 組裝（memory context + group isolation + plan mode + deferred tools + nudge + session note）
5. AutoCompact（預留 output 空間）
6. LLM 呼叫迴圈 → tool_use → execute → tool_result → 迴圈至 end_turn
7. 後處理（萃取 + session snapshot + trace finalize）

## 常數

| 常數 | 值 | 說明 |
|------|-----|------|
| `BASE_LOOPS` | 50 | 單次 turn 起始 LLM 迴圈數（自適應可延長至 `LOOP_CAP_CEILING`） |
| `LOOP_CAP_CEILING` | 80 | 自適應延長的絕對天花板 |
| `MAX_CONTINUATIONS` | 3 | Output Token Recovery 最大續接次數 |
| `MAX_DEFERRED_NUDGES` | 3 | Deferred tool 活化後空回應的續接提示上限 |
| `MAX_EMPTY_TOOL_USE` | 3 | 連續空 tool_use iteration 上限（`stopReason=tool_use` 但 `toolCalls=[]`） |
| `DEFAULT_RESULT_TOKEN_CAP` | 0 | Tool result 預設不截斷（per-tool resultTokenCap 仍生效）；**error 訊息永遠不截斷** |

### 空 tool_use 防護（2026-04-29 新增）

模型偶爾會產出 `stopReason==="tool_use"` 但 `toolCalls=[]` 的「空 tool_use iteration」（Claude API quirk）。
舊行為：第一次空 tool_use 直接 `break`，但觸頂訊息一律寫「工具呼叫上限」名實不符。
新行為：
- 空 tool_use → `emptyToolUseCount++`、`continue`，給模型再一次機會
- 累計到 `MAX_EMPTY_TOOL_USE` 則設 `emptyToolUseExhausted=true` 後 break
- 偵測到實際 tool 呼叫即重置計數
- `loopCount` 仍由 while 條件遞增，死循環防護不變

### 觸頂訊息分流

`maxLoopsReached` 內部按實際 tool 執行數分流：
- `toolsRun >= loopCap` → 「已達工具呼叫上限」
- `toolsRun < loopCap` → 「已達對話輪次上限」（iteration 被空轉/續接吃掉）

`emptyToolUseExhausted` 分支獨立顯示「模型連續 N 次產出空 tool_use」，並排在 `maxLoopsReached` 之前判斷。

## 主函式

```typescript
export async function* agentLoop(
  prompt: string,
  opts: AgentLoopOpts,
  deps: AgentLoopDeps,
): AsyncGenerator<AgentLoopEvent>
```

Generator pattern — 呼叫端 `for await (const event of agentLoop(...))` 消費事件。

## AgentLoopOpts

| 欄位 | 型別 | 說明 |
|------|------|------|
| `channelId` | string | 平台頻道 ID |
| `accountId` | string | CatClaw accountId |
| `isAdmin` | boolean? | Agent admin flag（admin 不受路徑限制） |
| `isGroupChannel` | boolean? | 是否為群組頻道（影響 system prompt 多人聲明） |
| `speakerRole` | string? | 說話者角色（群組場景） |
| `speakerDisplay` | string? | 說話者顯示名稱 |
| `provider` | LLMProvider | 已選定的 LLM Provider |
| `systemPrompt` | string? | 已組裝的 system prompt |
| `signal` | AbortSignal? | Turn timeout / /cancel |
| `turnTimeoutMs` | number? | Turn 超時毫秒 |
| `showToolCalls` | "all"\|"summary"\|"none" | 工具呼叫顯示模式 |
| `projectId` | string? | 專案 ID |
| `allowSpawn` | boolean? | 是否允許 spawn_subagent（預設 true） |
| `spawnDepth` | number? | Spawn 深度（≥2 時強制禁止） |
| `trace` | MessageTrace? | 追蹤收集器 |
| `inboundContext` | string? | 頻道脈絡（注入 messages 層） |
| `thinking` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Extended thinking 等級 |
| `modePreset` | ModePreset? | 模式 preset（影響 CE/budget/prompt） |
| `execApproval` | object? | run_command DM 確認 |
| `sessionMemory` | object? | 對話筆記（read/extract） |
| `memoryRecall` | object? | 記憶 Recall（子 agent/cron 用） |
| `platform` | string? | 平台識別碼（預設 "discord"） |
| `retryMaxAttempts` | number? | LLM 呼叫失敗重試次數（預設 3） |
| `retryBaseMs` | number? | 重試 backoff 基礎毫秒（預設 1000） |
| `retryMaxMs` | number? | 重試 backoff 最大毫秒（預設 30000） |
| `workspaceDir` | string? | 子 agent 工作目錄 |
| `_sessionKeyOverride` | string? | 覆寫 session key（子 agent 用） |
| `parentRunId` | string? | 父 subagent runId |
| `agentId` | string? | Agent ID（spawn 帶 agent 身份時注入，傳遞到 ToolContext + safety guard + recall） |
| `imageAttachments` | array? | 圖片附件 content blocks |
| `promptBreakdownHints` | object? | Prompt 組裝分類提示 |

## AgentLoopEvent

| type | 欄位 | 說明 |
|------|------|------|
| `text_delta` | text | LLM 文字增量 |
| `thinking` | thinking | Extended thinking |
| `tool_start` | name, id, params | 工具開始執行 |
| `tool_result` | name, id, result, error? | 工具完成 |
| `tool_blocked` | name, reason | 工具被攔截 |
| `done` | text, turnCount | 完成 |
| `error` | message | 錯誤 |
| `context_warning` | level, utilization, estimatedTokens, contextWindow, source | Context 使用率警告（`level: "high" \| "critical"`，`source: "session" \| "model"`） |
| `ce_applied` | strategies, tokensBefore, tokensAfter | CE 壓縮完成通知（`{ strategies: string[]; tokensBefore: number; tokensAfter: number }`） |

## AgentLoopDeps

| 依賴 | 型別 | 來源 |
|------|------|------|
| sessionManager | SessionManager | platform.ts |
| permissionGate | PermissionGate | platform.ts |
| toolRegistry | ToolRegistry | platform.ts |
| safetyGuard | SafetyGuard | platform.ts |
| eventBus | EventBus | event-bus.ts |
| memoryEngine | MemoryEngine? | memory/engine.ts |

> deps 為 inline type（非獨立 interface）。

## 關鍵流程

### Tool 執行

```
LLM 回覆含 tool_use
  → permission gate 檢查
  → safety guard 檢查
  → pre-tool-use hook
  → exec approval（run_command DM 確認，可選）
  → tool.execute(params, ctx)
  → 智慧截斷 tool result
  → post-tool-use hook
  → tool_result 加入 messages
  → 下一輪 LLM 呼叫
```

### Output Token Recovery

LLM 回 `max_tokens` 截斷 → 自動續接（最多 MAX_CONTINUATIONS 次）。
續接時注入 `繼續` user 訊息，保持 context 連貫。

### AutoCompact

LLM 呼叫迴圈中，token 超出 contextReserve → `messages.slice(1)` 移除最舊 message → repairToolPairing。
壓縮後注入最近編輯檔案的內容摘要（post-compact recovery）。

### Trace 記錄點

- `recordContextEnd` — 歷史 token + system prompt token
- `recordCE` — CE 壓縮前後 token
- `recordContextSnapshot` — 完整 system prompt + messages
- `recordLLMCallStart/End` — 每次 LLM 呼叫
- `recordToolCall` — 每次工具呼叫
- `recordMemoryRecall` — memory recall（agent-loop 內路徑）
- `appendAgentLoopBlocks` — 追加的 system prompt 區塊
- `recordPostProcess` — 後處理
- `recordResponse` — 最終回覆
- `recordAbort` — 中斷

### Workflow 事件橋接

Turn 執行期間監聽 eventBus 事件，轉為 trace workflow events：
- `rut` — 重複模式偵測
- `oscillation` — 擺盪偵測
- `sync_needed` — 需同步
- `file_modified` — 檔案修改追蹤

## Tool Loop Detection（三層防護）

`runBeforeToolCall` 內，Step 4：

| 層級 | 條件 | 說明 |
|------|------|------|
| 4a 精確迴圈 | 最近 5 筆同名 ≥3 且同參數 ≥3 | 完全相同呼叫的死迴圈 |
| 4b 寬鬆防線 | 最近 10 筆中同名 ≥8 且其中 ≥5 筆「失敗 + args 與當前相似」 | 換參數但一直無效的重試（僅看 tool name 會誤擋探索性呼叫，需疊 args 相似度 + 失敗判定） |
| 4c 交替迴圈 | A→B→A→B→A 模式（period-2） | 兩工具互踢的死循環 |

比對使用 `JSON.stringify(params)` 做參數簽名。

## Tool Result 智慧截斷

依 tool 類型套用不同截斷策略（`TRUNCATION_STRATEGIES`）：
- `run_command` — head + tail + 省略行數
- `read_file` — head + tail
- `grep` / `glob` / `web_search` — 搜尋結果截斷
- 預設 — head + tail

Per-turn 工具結果 token 累計追蹤（`turnToolResultTokens`），接近 budget 時壓縮後續結果。

**截斷提示顯式化**：所有截斷策略在插入位置附上 `[⚠️ CatClaw 已截斷：...]` 說明原始規模 + 如何取回完整內容：
- `read_file` → 提示用 `offset` / `limit` 參數讀取被省略區段
- `grep` / `glob` / `web_search` → 提示用更精確的 pattern 或 glob 過濾縮小範圍
- `run_command` → 提示將輸出寫到檔案後用 `read_file` 分頁讀取
- 預設 → 提示縮小參數範圍後重新呼叫

**錯誤訊息永遠不截斷** — ToolResult 的 `error` 欄位直通 agent，避免錯誤被截斷後失去線索。

## Hook 整合

觸發點（詳見 `modules/hooks.md`）：

- **SessionStart**：session 建立時（首次 turn）
- **UserPromptSubmit**：收到 user prompt（可 block/modify）
- **PreTurn / PostTurn**：每個 turn 前後
- **PreLlmCall / PostLlmCall**：provider.stream 前後（附 tokens/duration）
- **AgentResponseReady**：最終 response yield 前（可重寫 text）
- **AgentError**：fatal 錯誤（observer）
- **SafetyViolation**：SafetyGuard 阻擋工具時（observer）

## Turn Cap Warning

`turnCount >= turnCapWarning`（預設 100）且 `turnCount % 20 === 0` 時發 `log.warn`，提醒建議執行 `/clear-session`。設定 `contextEngineering.turnCapWarning = 0` 可關閉。
