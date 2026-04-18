# PLAN-V5 — CatClaw = Codex 版 Claude Code CLI + 多人 AI 開發平台

> 建立日期：2026-04-04
> 完成日期：2026-04-05
> 狀態：✅ 完成（18/20 項已關閉，2 項低優先延後）

## 願景

**CatClaw 是 Codex 版的 Claude Code CLI**——以 Discord 為前端介面，透過 Anthropic Messages API 直接驅動 Agent Loop，
提供等同 Claude Code 的完整開發能力，同時支援多人協作、記憶持久化、權限控制等 Claude Code 不具備的平台級功能。

## 四大目標

1. **精準記憶** — atom 系統 + vector recall ✅（已實作）
2. **省 token** — prompt cache + context 壓縮強化
3. **高精密 coding** — extended thinking + 行為約束 + 精密模式
4. **作對的事** — 能用程式邏輯處理的事情不需要用語意來做

---

## Part A — Claude Code vs CatClaw 全面 Gap Analysis

### 1. Tool System（LLM 可呼叫的工具）

| Claude Code Tool | CatClaw 對應 | 狀態 | 差異 / Gap |
|-----------------|-------------|------|-----------|
| **Read** | `read_file` | ✅ 已有 | CC 支援圖片/PDF/Jupyter 預覽。CatClaw 僅文字。 |
| **Write** | `write_file` | ✅ 已有 | CC 要求先 Read 才能 Write（防盲寫）。CatClaw 無此約束。 |
| **Edit** | `edit_file` | ✅ 已有 | CC 用 exact string match replace（unique check）。CatClaw 用行號 patch？需確認。 |
| **Glob** | `glob` | ✅ 已有 | 功能對齊。 |
| **Grep** | `grep` | ✅ 已有 | CC 支援 output_mode(content/files/count)、multiline、offset/head_limit。CatClaw 需確認細節。 |
| **Bash** | `run_command` | ✅ 已有 | CC 有 sandbox、timeout、background mode。CatClaw 有 exec-approval。 |
| **Agent** (subagent) | `spawn_subagent` + `subagents` | ⚠️ 部分 | CC 有 **typed agents**（general/Explore/Plan）。CatClaw 有 async + 3 種 runtime（default/coding/acp）+ steer/resume 續接，但缺乏**型別化 agent 定義**和 **worktree isolation**。 |
| **TaskCreate/Update/Get/List** | ❌ 無 | 🔴 缺失 | CC 有結構化任務追蹤系統。CatClaw 無。 |
| **ToolSearch** (deferred loading) | ❌ 無 | 🔴 缺失 | CC 按需載入 tool schema，減少 system prompt 膨脹。CatClaw 全量注入 14 個 tool。 |
| **NotebookEdit** | ❌ 無 | ⚪ N/A | Jupyter 不適用 Discord bot 情境。 |
| **WebFetch** | `web_fetch` | ✅ 已有 | |
| **WebSearch** | `web_search` | ✅ 已有 | |
| **Skill** (invoke skill) | Skill 系統 | ✅ 已有 | CC 的 skill 是 prompt 展開型。CatClaw 有 command + prompt 兩型。 |
| — | `memory_recall` | ✅ CatClaw 獨有 | CC 無 LLM 主動 recall tool。 |
| — | `config_get/patch` | ✅ CatClaw 獨有 | 運行時設定操作。 |
| — | `llm_task` | ✅ CatClaw 獨有 | 輕量 LLM 子任務（不 spawn full agent）。 |

### 2. Agent / Subagent System

| Claude Code 功能 | CatClaw 狀態 | Gap 描述 |
|-----------------|-------------|---------|
| **Typed agents**（general/Explore/Plan/claude-code-guide） | 🔴 缺失 | CatClaw spawn 無型別，全用同一套 system prompt。需要為不同 agent 型別定義不同的 tool set + prompt。 |
| **Background execution** + 自動通知 | ✅ 已有 | CatClaw spawn_subagent 支援 `async: true`，背景執行後可用 `subagents wait/status` 查詢。 |
| **Worktree isolation** | 🔴 缺失 | CC 可在 git worktree 隔離分支工作。高價值但實作複雜。 |
| **SendMessage 續接** | ✅ 已有 | CatClaw `subagents` tool 支援 `steer`（注入訊息）和 `resume`（恢復 keepSession 的 agent）。 |
| **Max spawn depth = 3** | ✅ 已有 | CatClaw 已有 spawnDepth 限制。 |
| **Parallel agent launch** | ⚠️ 部分 | CatClaw spawn_subagent 已支援同輪並行，但缺乏 background 模式。 |

### 3. Context Engineering / 省 Token

| Claude Code 功能 | CatClaw 狀態 | Gap 描述 |
|-----------------|-------------|---------|
| **Prompt Caching (cache_control breakpoints)** | 🔴 缺失 | CC 在 system prompt + tool definitions 上設 cache breakpoints，重用率極高。**這是最大的省 token 機會。** |
| **Auto-compact** (context 壓縮) | ✅ 已有 | CatClaw 有 ContextEngine（Compaction + BudgetGuard + SlidingWindow + OverflowHardStop）。 |
| **Token Budget Nudge** | ✅ 已有 | CatClaw 在 60%/70% 時提示 LLM 簡潔回應。 |
| **Tool result 截斷** | ✅ 已有 | 有 resultTokenCap + perTurnTotalCap。 |
| **Output Token Recovery** (max_tokens 續接) | ✅ 已有 | MAX_CONTINUATIONS=3 自動續接。 |
| **Post-compact Recovery** (恢復最近編輯檔案) | ✅ 已有 | 壓縮後重新注入最近 5 個編輯檔案。 |
| **Deferred tool loading** (減少 system prompt) | 🔴 缺失 | 全量注入所有 tool。可用 ToolSearch 模式，只在需要時載入。 |
| **Tool Pairing Repair** | ✅ 已有 | 截斷後修補孤立 tool_use/tool_result。 |
| **Per-message token tracking** | ✅ 已有 | Message.tokens 欄位。 |
| **Session Note (摘要注入)** | ✅ 已有 | checkAndSaveNote + 注入 system prompt。 |

### 4. Behavioral Rules / 行為約束（高精密 Coding）

| Claude Code 規則 | CatClaw 狀態 | Gap 描述 |
|-----------------|-------------|---------|
| **先 Read 才能 Edit/Write** | 🔴 缺失 | CC 強制 LLM 先讀取檔案才能修改。CatClaw 無此約束。 |
| **最小變動原則** | ⚠️ 僅在 prompt | CATCLAW.md 有文字描述，但無程式碼層面強制。 |
| **不加廢話（no docstring/comments/type annotation to unchanged code）** | ⚠️ 僅在 prompt | 同上。 |
| **安全 coding（OWASP top 10）** | 🔴 缺失 | CC system prompt 明確列出。CatClaw 無。 |
| **Destructive ops 確認** | ✅ 已有 | exec-approval DM 確認機制。 |
| **Git safety protocol** | 🔴 缺失 | CC 有詳細的 git commit/PR 規則（不 amend、不 force push、不 skip hooks、新 commit）。CatClaw 無。 |
| **Output efficiency** (簡潔回應) | ⚠️ 僅在 prompt | CC 有系統性的「Lead with answer, skip filler」規則。 |
| **Reversibility awareness** | 🔴 缺失 | CC 要求 AI 評估操作的可逆性和影響範圍，高風險操作前確認。 |
| **Error diagnosis before retry** | ⚠️ 僅在 prompt | CC 明確禁止盲目重試。CatClaw 有 fix-escalation 但偏 workflow 層。 |
| **Tool Loop Detection** | ✅ 已有 | 連續 5 次 + 交替循環偵測。 |
| **Extended Thinking** | ✅ 已有 | mode system（normal/precision）+ thinking level。 |

### 5. Memory System

| Claude Code 功能 | CatClaw 狀態 | Gap 描述 |
|-----------------|-------------|---------|
| **Auto-memory（file-based）** | ✅ 已有 | CatClaw atom 系統更強（分層、向量搜尋、confidence 演進）。 |
| **Memory types（user/feedback/project/reference）** | ✅ 已有 | CatClaw 用 atom 分類，語意相近。 |
| **MEMORY.md index** | ✅ 已有 | CatClaw MEMORY.md 索引 + trigger keyword。 |
| **Memory staleness detection** | ⚠️ 部分 | CC 強調驗證記憶是否過時。CatClaw 有 decay 但不夠主動。 |

### 6. Skill System

| Claude Code 功能 | CatClaw 狀態 | Gap 描述 |
|-----------------|-------------|---------|
| **/commit** (git commit 工作流) | 🔴 缺失 | CC 有詳細的 git commit 規範（parallel git status + diff + log → 分析 → commit）。 |
| **PR creation workflow** | 🔴 缺失 | CC 有 `gh pr create` 流程。 |
| **Hooks** (pre/post tool call) | ⚠️ 部分 | CatClaw 有 EventBus（tool:before/after），但不是 user-configurable shell hooks。 |
| **User-invocable skills** | ✅ 已有 | CatClaw /configure /use /mode /status 等。 |

### 7. 多人 AI 開發平台（CatClaw 獨有優勢）

| CatClaw 功能 | Claude Code 對應 | 說明 |
|-------------|-----------------|------|
| **5 級角色權限** | ❌ CC 無 | guest → member → developer → admin → platform-owner |
| **Tool Tier 物理過濾** | ❌ CC 無 | 依角色移除 tool，不靠 prompt |
| **Multi-user session** | ❌ CC 無 | 同頻道多人共享 context |
| **Provider routing** | ❌ CC 無 | per-channel/project/role 路由不同 LLM |
| **Circuit breaker + failover** | ❌ CC 無 | Provider 熔斷 + 自動切換 |
| **Multi-credential rotation** | ❌ CC 無 | AuthProfileStore 多憑證輪替 |
| **Web Dashboard** | ❌ CC 無 | 監控面板 |
| **Cron job system** | ❌ CC 無 | 排程任務 |
| **Message Trace（7 階段）** | ❌ CC 無 | 完整訊息生命週期追蹤 |
| **Rate Limiter** | ❌ CC 無 | 依角色限速 |
| **Exec Approval（DM 確認）** | ❌ CC 無 | 高風險指令需 DM 確認 |

---

## Part B — 分階段實作計畫

### Phase 1：Prompt Cache + 省 Token 強化（最高 ROI）

**目標**：省 token 目標的核心。預估可省 80-90% 的 system prompt + tool defs 重複 token。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B1.1 Prompt Cache Breakpoints** | 在 claude-api.ts 的 system prompt 和 tool definitions 上加 `cache_control: { type: "ephemeral" }` breakpoints。pi-ai `streamSimpleAnthropic` 需確認是否支援，不支援則改用 Anthropic SDK 直接呼叫。 | 中 | 🔥🔥🔥 |
| **B1.2 Deferred Tool Loading** | 將低頻 tool（config_get/patch、spawn_subagent 等）改為 deferred——system prompt 僅列出名稱+一行描述，LLM 需要時呼叫 `tool_search` 取得完整 schema。減少每次 request 的 tool token 開銷。 | 中 | 🔥🔥 |
| **B1.3 Tool Result 智慧截斷強化** | 依 tool 類型用不同策略：read_file 保留頭尾+行號、grep 限制匹配數、run_command 只保留 stderr + exit code + 尾部。 | 低 | 🔥 |

### Phase 2：高精密 Coding 行為約束

**目標**：讓 CatClaw 在 coding 任務上達到 Claude Code 級別的精密度。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B2.1 Read-before-Write 強制** | 在 agent-loop 的 before_tool_call hook 中，追蹤已 read 的檔案路徑。write_file / edit_file 的目標路徑若不在已讀清單中 → 阻擋並提示 LLM 先讀取。 | 低 | 🔥🔥🔥 |
| **B2.2 Coding Discipline System Prompt** | 從 CC system prompt 提取核心行為規則，寫成 `prompts/coding-discipline.md`，precision mode 自動注入。包含：最小變動、不加廢話、安全 coding、先診斷再修正。 | 低 | 🔥🔥 |
| **B2.3 Git Safety Protocol** | 實作 git_commit / git_push tool（或在 run_command 中偵測 git 命令），加入安全規則：不 amend（除非明確要求）、不 force push main、不 skip hooks、destructive ops 需確認。 | 中 | 🔥🔥 |
| **B2.4 Reversibility Assessment** | 在 before_tool_call 中，依工具和參數評估操作可逆性（destructive score 0-3）。score ≥ 2 → 自動插入確認訊息讓 LLM 重新考慮。 | 中 | 🔥 |

### Phase 3：Typed Agent System（升級 subagent）

**目標**：讓 CatClaw 的 subagent 達到 Claude Code Agent tool 的能力。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B3.1 Agent Type 定義** | 在 config 或程式碼中定義 agent types（Explore/Plan/Build/Review），每個 type 有：可用 tool 白名單、system prompt、model 覆寫、timeout 覆寫。 | 中 | 🔥🔥🔥 |
| **B3.2 Background Agent + Notification** | spawn_subagent 加 `background: true` 參數。背景 agent 完成後透過 EventBus 通知 parent，parent 在下次 LLM 回應中注入結果。 | 高 | 🔥🔥 |
| **B3.3 Agent SendMessage 續接** | 完成的 agent session 不立即銷毀，parent 可透過 `send_message` tool 發送後續指令給 child agent，child 用原 context 繼續。 | 高 | 🔥 |
| **B3.4 Worktree Isolation** | spawn 時 `isolation: "worktree"` → 自動 `git worktree add` 建立隔離工作區，agent 在隔離分支工作，完成後由 parent 決定 merge 或丟棄。 | 高 | 🔥 |

### Phase 4：Task Management System

**目標**：讓 LLM 能結構化追蹤複雜任務進度。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B4.1 task_create / task_update / task_list / task_get** | 新增 4 個 tool。per-session 任務列表，支援 status (pending/in_progress/completed)、dependencies (blocks/blockedBy)。儲存在 session metadata 中。 | 中 | 🔥🔥 |
| **B4.2 Task UI（Discord embed）** | 任務列表以 Discord embed 格式呈現（✅/🔄/⏳ 圖示 + 進度百分比）。 | 低 | 🔥 |

### Phase 5：System Prompt 組裝強化

**目標**：讓 CatClaw 的 system prompt 達到 Claude Code 級別的結構化和有效性。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B5.1 System Prompt 模組化組裝器** | 將 system prompt 拆成模組（identity / tools-usage / coding-rules / git-rules / output-format / memory-rules），按 mode + 角色動態組裝。 | 中 | 🔥🔥 |
| **B5.2 Context-aware prompt injection** | 根據偵測到的任務類型（coding / research / conversation），動態注入不同的行為規則模組。 | 中 | 🔥 |
| **B5.3 CATCLAW.md 願景更新** | 在 system prompt 開頭加入「CatClaw = Codex 版 Claude Code CLI + 多人 AI 開發平台」願景。 | 低 | 🔥 |

### Phase 6：多人 AI 開發平台強化

**目標**：這是 CatClaw 的獨有優勢，持續強化。

| 項目 | 說明 | 難度 | 影響 |
|------|------|------|------|
| **B6.1 開發者角色 Tool Set** | 為 `developer` 角色定義完整的 coding tool set（等同 Claude Code），guest 只有 read-only。 | 低 | 🔥🔥 |
| **B6.2 專案綁定強化** | 頻道綁定專案 → 自動設定 cwd、載入專案 memory、注入專案 CLAUDE.md。 | 中 | 🔥🔥 |
| **B6.3 協作衝突偵測** | 多人同頻道時，偵測同時編輯同一檔案 → 警告。 | 中 | 🔥 |

---

## Part C — 優先序與 Sprint 規劃

### Sprint 1（立即可做，最高 ROI）
- **B1.1** Prompt Cache Breakpoints
- **B2.1** Read-before-Write 強制
- **B2.2** Coding Discipline System Prompt
- **B5.3** CATCLAW.md 願景更新

### Sprint 2（中等複雜度）
- **B1.2** Deferred Tool Loading
- **B2.3** Git Safety Protocol
- **B3.1** Agent Type 定義
- **B4.1** Task Management（tool 層）

### Sprint 3（高複雜度）
- **B3.2** Background Agent + Notification
- **B5.1** System Prompt 模組化組裝器
- **B1.3** Tool Result 智慧截斷強化
- **B6.1** 開發者角色 Tool Set

### Sprint 4（長期）
- **B3.3** Agent SendMessage 續接
- **B3.4** Worktree Isolation
- **B2.4** Reversibility Assessment
- **B6.2** 專案綁定強化
- **B6.3** 協作衝突偵測

---

## Part D — 技術風險與決策點

### D1. Prompt Cache 實作路徑

**問題**：pi-ai `streamSimpleAnthropic` 是否支援 `cache_control` breakpoints？

**選項**：
1. 檢查 pi-ai 是否支援 → 如果支援，直接用
2. 如果不支援 → 直接用 `@anthropic-ai/sdk`（官方 SDK）呼叫，繞過 pi-ai
3. 如果不支援 → fork pi-ai 加入支援

**建議**：選項 2。`@anthropic-ai/sdk` 是標準，長期維護有保障。可以新建 `claude-api-native.ts` provider，與現有 pi-ai provider 並存。

### D2. Deferred Tool Loading 策略

**問題**：哪些 tool 應該 defer？

**原則**：
- **Always loaded**（高頻）：read_file, write_file, edit_file, glob, grep, run_command
- **Deferred**（中頻）：web_search, web_fetch, spawn_subagent, memory_recall
- **Deferred**（低頻）：config_get, config_patch, task_*, tool_search 自身

### D3. 行為約束的實作層級

**問題**：行為規則應該在哪一層實作？

| 層級 | 方式 | 適合什麼 |
|------|------|---------|
| System prompt | 文字提示 | 編碼風格、語氣、輸出格式 |
| before_tool_call hook | 程式碼阻擋 | Read-before-Write、destructive ops 確認 |
| Tool implementation | 工具內部邏輯 | Git safety（在 run_command 中偵測 git 指令） |

**原則（目標 4）**：能用程式邏輯處理的事情不需要用語意來做。
→ Read-before-Write 用 hook 強制 ✅
→ Git safety 用 tool 內部偵測 ✅
→ 編碼風格用 prompt ✅（只能靠語意）

---

## Part E — 完成摘要（2026-04-05）

### Sprint 實作紀錄

| Sprint | Commit | 包含項目 |
|--------|--------|---------|
| pre-V5 | b959701 | B2.1 Read-before-Write、B2.2 Coding Discipline、B5.3 CATCLAW.md 願景 |
| S1+S2 | 7fee6f1 | B1.1 Prompt Cache、B1.2 Deferred Tool、B2.3 Git Safety、B3.1 Agent Types、B4.1 Task Management |
| S3 | 31ef3ac | B3.2 Background Agent Notification、B5.1 Prompt Assembler、B1.3 Smart Truncation、B6.1 Role Tool Sets |
| S4 | b8c11d0 | B3.3 SendMessage、B3.4 Worktree Isolation、B2.4 Reversibility、B6.2 Project Binding、B6.3 Collab Conflict |

### Gap 關閉狀態：18/20 ✅

| 項目 | 狀態 | 備註 |
|------|------|------|
| B4.2 Task UI（Discord embed） | ❌ 延後 | 功能性低，task_manage tool 已足夠 |
| B5.2 Context-aware prompt injection | ❌ 延後 | 需 prompt-assembler 實戰驗證後再設計 |

### 下一階段建議

PLAN-V5 核心 gap 已關閉。建議進入**穩定化 + 實戰驗證階段**，不急於開 V6：

1. **整合測試強化** — 目前 smoke-v2.mjs 只覆蓋 config/auth/provider，缺少 agent-loop、tool 執行、subagent spawn 的整合測試
2. **prompt-assembler 接入 discord.ts** — 目前 prompt-assembler 已實作但尚未成為 agent-loop 的預設 system prompt 來源，需接線驗證
3. **B5.2 Context-aware prompt injection** — 待 prompt-assembler 實戰穩定後，依任務類型動態注入行為模組
4. **實戰回饋收集** — 用 CatClaw 自己做日常開發，記錄 prompt quality、tool 使用效率、token 消耗等指標
