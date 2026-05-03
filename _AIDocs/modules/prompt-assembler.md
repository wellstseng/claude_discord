# modules/prompt-assembler — 模組化 System Prompt 組裝

> 檔案：`src/core/prompt-assembler.ts`
> 更新日期：2026-05-03

## 職責

將 system prompt 拆成可組合的模組，按 mode + 角色 + intent 動態組裝。

## Frozen Snapshot for Prompt Cache（2026-05-03 落地）

### 機制

`PromptContext` 加 `frozenMaterials?: FrozenPromptMaterials` 欄位（從 `session-snapshot.ts` import）。下列 6 個 module 的 `build(ctx)` 開頭判 `ctx.frozenMaterials`：有值即直接讀凍結值短路返回；無值（session 開場第一個 turn）走原邏輯。

| 模組 | 凍結來源 | 原邏輯（cache killer） |
|------|---------|---------------------|
| `date-time` | `ctx.frozenMaterials.dateTimeText` | `new Date().toLocaleString()` 每 turn 變 |
| `catclaw-md` | `ctx.frozenMaterials.catclawMdText` | `readFileSync(CATCLAW.md)` 每 turn 讀 |
| `coding-rules` | `ctx.frozenMaterials.codingRulesText` | precision 模式 `readFileSync(coding-discipline.md)` |
| `tool-summary` | `ctx.frozenMaterials.toolSummaryText` | 讀全域 `_toolSummaryText`（mid-session setter 改） |
| `skill-summary` | `ctx.frozenMaterials.skillSummaryText` | 讀全域 `_skillSummaryText` |
| `failure-recall` | `ctx.frozenMaterials.failureRecallText` | 讀全域 `_failureRecallCache` |

### `prepareFrozenMaterials(opts)` export

由 `session-snapshot.ts::prepareSessionSnapshot()` 在 SessionStart hook 內呼叫：用 `frozenMaterials = undefined` 的 `ctx` 跑各 module `build()` 一次，把回傳值打包成 `FrozenPromptMaterials` 的前 6 個欄位。

### identity module 變動

`identityModule` 移除每 turn 變動的 speakerDisplay 段（搬到 user message `[meta]` 前綴）；保留群組頻道一般說明。

詳見 `_AIDocs/modules/session-snapshot.md` Part B。



## 內建模組

| 模組名 | Priority | 說明 |
|--------|----------|------|
| `date-time` | 5 | 系統時鐘：注入今日日期（含星期）+ 當前時間（Asia/Taipei），並明示 LLM 以此為「今天/昨天/這週」相對時間基準，避免以 knowledge cutoff 推斷錯誤年份 |
| `identity` | 10 | CatClaw 身份描述 + 群組場景說話者 |
| `context-integrity` | 15 | Anti-Hallucination 鐵則（禁止憑 stub/標記推論原文 + retry escalation 防線） |
| `catclaw-md` | 15 | CATCLAW.md 層級繼承（root → project） |
| `tools-usage` | 20 | 工具使用規則 |
| `coding-rules` | 30 | 行為約束（precision 模式載入外部 .md） |
| `git-rules` | 40 | Git 安全協定 |
| `output-format` | 50 | 輸出規則（直球、繁中、不總結） |
| `discord-reply` | 55 | Discord 回覆規則（有 Discord MCP 才注入） |
| `tool-summary` | 56 | 可用工具摘要（含 MCP 工具），由 `platform.ts` 延遲注入 |
| `skill-summary` | 57 | 可用 Skill 指令摘要，由 `platform.ts` 延遲注入 |
| `failure-recall` | 55 | 跨 session 錯誤學習（已知 tool 陷阱注入） |
| `memory-rules` | 60 | 記憶系統使用規則 |

## Context-aware Intent Detection

```typescript
detectIntent(userMessage: string): "coding" | "research" | "conversation"
```

根據關鍵字權重判定 intent：

| Intent | 觸發 | 啟用模組 |
|--------|------|---------|
| `coding` | codingScore ≥ 2 | 全部 |
| `research` | researchScore ≥ 2 且 codingScore = 0 | 省略 coding-rules, git-rules（含 context-integrity） |
| `coding`（fallback） | codingScore ≥ 1 | 全部 |
| `conversation` | 其餘 | date-time, identity, context-integrity, catclaw-md, output-format, discord-reply, memory-rules |

## CATCLAW.md 兩層載入

```
1. Workspace 層級：workspaceDir → 往上搜尋 CATCLAW.md → 直到 filesystem root
   root-level first，project-level last（後者覆寫前者）
2. Agent 層級：workspace/agents/{bootAgentId}/CATCLAW.md（agent 專屬規則，疊加在全域之後）
   路徑解析：workspace 優先（resolveAgentWorkspaceDir），fallback 到 data dir（resolveAgentDataDir）
```

所有 agent 統一機制。spawn 出的 agent 由 spawn-subagent.ts 的 `loadAgentPrompt()` 載入。

自動建立：workspace 無 CATCLAW.md 時優先從 `templates/CATCLAW.md` 複製，否則用內建預設。

## 組裝器

```typescript
assembleSystemPrompt(opts: AssembleOpts): string
```

| opts 欄位 | 說明 |
|-----------|------|
| role | 使用者角色 |
| mode | ModePreset |
| modeName | "normal" / "precision" |
| extraBlocks | 額外區塊（memory / systemOverride / modeExtras） |
| extraBlockNames | extraBlocks 對應名稱（trace segment 標記） |
| moduleFilter | 指定啟用模組（null = 全部） |
| traceOutput | 追蹤輸出（modulesActive / modulesSkipped / segments） |

> `AssembleOpts extends PromptContext`，繼承 `projectId`, `isGroupChannel`, `speakerDisplay`, `accountId`, `speakerRole`, `workspaceDir`, `activeMcpServers` 等欄位。

流程：
1. 合併 builtin + custom modules
2. 排除 config.promptAssembler.disabledModules
3. 套用 moduleFilter
4. 依 priority 排序
5. 注入 extraBlocks
6. 逐模組 build()，串接為字串
7. 寫入 traceOutput（如有）

## 擴充

```typescript
registerPromptModule(mod: PromptModule): void
```

外部可註冊自訂 prompt 模組。

## Debug

```typescript
listPromptModules(): Array<{ name: string; priority: number }>
```

列出所有已註冊模組（供 dashboard/debug）。

## AssembleTraceOutput

```typescript
interface AssembleTraceOutput {
  modulesActive: string[];
  modulesSkipped: string[];
  segments: Array<{ name: string; content: string }>;
}
```

Sprint 8 新增。discord.ts 傳入此物件，組裝完成後可讀取哪些模組被注入/跳過。

## Tool Summary 注入

```typescript
setToolSummary(tools: Array<{ name: string; description: string }>): void
```

由 `platform.ts` 步驟 13 呼叫（延遲 2s 等 MCP 連線完成），將 ToolRegistry 中所有已註冊工具（含 MCP 工具）的名稱與描述首行注入 system prompt。解決 Agent Loop 冷啟動時 AI 不知道有哪些工具可用的問題。

## Skill Summary 注入

```typescript
setSkillSummary(skills: Array<{ name: string; description: string; trigger: string[] }>): void
```

由 `platform.ts` 步驟 13 與 Tool Summary 同時呼叫，將 SkillRegistry 中所有已註冊 skill 的名稱、描述、觸發指令注入 system prompt。讓 LLM 知道有哪些 skill 可用，能引導使用者直接輸入對應指令。

## Failure Recall Cache

```typescript
refreshFailureRecallCache(): Promise<void>
```

啟動時（`platform.ts` 步驟 10b）非同步載入 failure recall 快取。`failure-recall` module 同步讀取此快取注入 system prompt。
