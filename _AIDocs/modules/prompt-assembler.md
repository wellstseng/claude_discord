# modules/prompt-assembler — 模組化 System Prompt 組裝

> 檔案：`src/core/prompt-assembler.ts`
> 更新日期：2026-04-05

## 職責

將 system prompt 拆成可組合的模組，按 mode + 角色 + intent 動態組裝。

## 內建模組

| 模組名 | Priority | 說明 |
|--------|----------|------|
| `date-time` | 5 | 當前時間（Asia/Taipei） |
| `identity` | 10 | CatClaw 身份描述 + 群組場景說話者 |
| `catclaw-md` | 15 | CATCLAW.md 層級繼承（root → project） |
| `tools-usage` | 20 | 工具使用規則 |
| `coding-rules` | 30 | 行為約束（precision 模式載入外部 .md） |
| `git-rules` | 40 | Git 安全協定 |
| `output-format` | 50 | 輸出規則（直球、繁中、不總結） |
| `discord-reply` | 55 | Discord 回覆規則（有 Discord MCP 才注入） |
| `memory-rules` | 60 | 記憶系統使用規則 |

## Context-aware Intent Detection

```typescript
detectIntent(userMessage: string): "coding" | "research" | "conversation"
```

根據關鍵字權重判定 intent：

| Intent | 觸發 | 啟用模組 |
|--------|------|---------|
| `coding` | codingScore ≥ 2 | 全部 |
| `research` | researchScore ≥ 2 且 codingScore = 0 | 省略 coding-rules, git-rules |
| `coding`（fallback） | codingScore ≥ 1（但 < 2 且 research 未達 2） | 全部 |
| `conversation` | 其餘 | date-time, identity, catclaw-md, output-format, discord-reply, memory-rules |

## CATCLAW.md 層級繼承

```
workspaceDir → 往上搜尋 CATCLAW.md → 直到 filesystem root
root-level first，project-level last（後者覆寫前者）
```

自動建立：workspace 無 CATCLAW.md 時自動生成預設。

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
