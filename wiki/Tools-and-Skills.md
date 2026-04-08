# Tools and Skills

`src/tools/` + `src/skills/` — 可擴充的 Tool 與 Skill 系統。

## Tool 系統

### Tool 介面

```typescript
interface Tool {
  name: string              // snake_case 命名
  description: string
  tier: ToolTier            // public | standard | elevated | admin | owner
  parameters: JsonSchema
  resultTokenCap?: number   // 結果截斷上限（預設 8000 tokens）
  timeoutMs?: number        // 執行超時（預設 30,000 ms）
  concurrencySafe?: boolean // 是否可並行（read-only tools）
  deferred?: boolean        // 延遲載入（tool_search 才取得 schema）
  execute(params, ctx): Promise<ToolResult>
}
```

### ToolRegistry

- `register(tool)` — 註冊到 `Map<name, tool>`
- `loadFromDirectory(dir)` — 掃描 `*.js`，ESM import 後自動註冊
- `watchDirectory(dir)` — fs.watch 監聽，hot-reload 新增/修改的 tool
- `execute(name, params, ctx)` — 帶 timeout 的執行
- `definitions()` — 匯出 `ToolDefinition[]` 給 LLM

### 結果截斷

per-tool 截斷策略（`truncateToolResult()`）：

| Tool | 策略 |
| ---- | ---- |
| `read_file` | 行數限制 + 檔案大小限制 |
| `grep` | 結果筆數限制 |
| `run_command` | stdout/stderr 字元數限制 |
| 其他 | 通用 token cap（預設 8000） |

### Builtin Tools

| 分類 | Tools |
| ---- | ----- |
| **檔案操作** | `read_file`, `write_file`, `edit_file`, `glob`, `grep` |
| **執行** | `run_command`, `llm_task` |
| **記憶** | `memory_recall` |
| **設定** | `config_get`, `config_patch` |
| **Session** | `clear_session`, `task_manage` |
| **Web** | `web_search`, `web_fetch` |
| **Subagent** | `spawn_subagent`, `subagents` |
| **探索** | `tool_search`（deferred tool schema 查詢） |

### Tool Tier 與權限

Tool tier 決定哪些角色可以使用：

| 角色 | 可用 tier |
| ---- | --------- |
| platform-owner | public, standard, elevated, admin, owner |
| admin | public, standard, elevated, admin |
| developer | public, standard, elevated |
| member | public, standard |
| guest | public |

## Skill 系統

### 兩種 Skill 類型

**1. Command-type（TypeScript 實作）：**

```typescript
interface Skill {
  name: string
  description: string
  tier: SkillTier
  trigger: string[]           // 觸發詞（大小寫不敏感前綴匹配）
  preflight?(ctx): Promise<{ok, reason}>  // 可選前置檢查
  execute(ctx): Promise<SkillResult>
}
```

**2. Prompt-type（Markdown 檔案）：**

- 位於 `skills/builtin-prompt/{category}/SKILL.md`
- YAML frontmatter 定義 description
- 內容注入 system prompt 作為額外指令

### SkillRegistry

- `matchSkill(text)` — 前綴匹配使用者輸入
- 啟動時自動載入 builtin skills
- 支援外部 skill 目錄（使用者自訂）

### Builtin Skills

| Skill | 功能 |
| ----- | ---- |
| `/help` | 使用說明 |
| `/status` | 系統狀態 |
| `/config` | 設定管理 |
| `/mode` | 模式切換 |
| `/plan` | 規劃模式 |
| `/compact` | 手動壓縮 session |
| `/account` | 帳號管理 |
| `/register` | 使用者註冊 |
| `/session-manage` | Session 管理 |
| `/project` | 專案管理 |
| `/use` | 模型選擇 |
| `/think` | Extended thinking 開關 |
| `/context` | Context 資訊 |
| `/aidocs` | 知識庫查詢 |
| `/restart` | 重啟 |
| `/stop` | 停止 |
