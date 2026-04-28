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
  resultTokenCap?: number   // 結果截斷上限（預設 0 = 不截斷；per-tool 可覆寫）
  timeoutMs?: number        // 執行超時（預設 0 = 不逾時，超過 60 秒僅軟警告）
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
| `grep` | 結果筆數限制（支援 `offset` / `head_limit` 分頁） |
| `glob` | 結果筆數限制（支援 `offset` / `limit` 分頁） |
| `run_command` | stdout/stderr 字元數限制 |
| 其他 | 通用 token cap（預設 0 = 不截斷） |

**錯誤訊息永遠不截斷** — ToolResult 的 `error` 欄位直通 agent，避免錯誤被截斷後失去線索。

### Timeout 策略

- **預設 `defaultTimeoutMs = 0`**：不逾時，tool 內部自行決定中斷時機
- **Per-tool `timeoutMs`** 仍可覆寫（如 `web_fetch=20000`、`web_search=15000`）
- **Soft warning**：執行超過 60 秒發 warn log，不中斷
- 可由 `catclaw.json.contextEngineering.toolBudget.toolTimeoutMs` 覆寫全域預設

### Builtin Tools（完整清單）

| Tool | 說明 | Tier | Deferred |
| ---- | ---- | ---- | -------- |
| `read_file` | 讀取檔案內容 | elevated | ❌ |
| `write_file` | 寫入或覆蓋檔案內容（目錄不存在會自動建立） | elevated | ❌ |
| `edit_file` | 對已存在的檔案進行精確字串替換（支援 replace_all） | elevated | ❌ |
| `glob` | 按 glob 模式搜尋檔案路徑（結果按修改時間降序，上限 1000 筆） | elevated | ❌ |
| `grep` | 在檔案內容中搜尋正規表達式（支援 offset/head_limit 分頁） | elevated | ❌ |
| `run_command` | 在 shell 執行指令並取得輸出 | elevated | ❌ |
| `llm_task` | 單次 LLM 呼叫，回傳 JSON 結構化結果 | standard | ✅ |
| `memory_recall` | 搜尋記憶庫，取得相關知識片段（全域/專案/個人） | standard | ✅ |
| `atom_write` | 寫入或更新一筆記憶 atom（自動更新 MEMORY.md 索引和向量資料庫） | standard | ❌ |
| `atom_delete` | 刪除一筆記憶 atom（同時移除 MEMORY.md 索引和向量資料庫條目） | standard | ❌ |
| `config_get` | 讀取 catclaw.json 設定值（支援 dot-path） | admin | ✅ |
| `config_patch` | 修改 catclaw.json 設定值（支援 dot-path） | admin | ✅ |
| `clear_session` | 清除當前頻道的 session 歷史（清空 messages + 重置 turnCount） | standard | ❌ |
| `session_context` | 查詢當前 session 的 context window 使用狀態（token 數、CE threshold 距離） | standard | ❌ |
| `task_manage` | 任務管理（create / list / update / complete / delete） | standard | ✅ |
| `web_search` | 使用 DuckDuckGo 搜尋網頁（最多 10 筆） | elevated | ✅ |
| `web_fetch` | 抓取 URL 的內容並以純文字回傳 | elevated | ✅ |
| `spawn_subagent` | 產生隔離子 agent 執行任務 | standard | ✅ |
| `subagents` | 管理子 agent（list / kill / steer / wait / status / resume / send_message） | standard | ✅ |
| `skill` | 執行 skill（傳入完整指令如 "/help"） | standard | ❌ |
| `tool_search` | 查詢可用 tool 的完整 schema（用於取得 deferred tool 的參數定義） | public | ❌ |
| `hook_list` | 列出目前已註冊的 hooks（可用 event/scope 篩選） | standard | ❌ |
| `hook_register` | 寫入新 hook 腳本至 hooks/ 資料夾（fs.watch 自動 reload） | elevated | ❌ |
| `hook_remove` | 刪除或停用已註冊的 hook（支援 delete/disable 兩種模式） | elevated | ❌ |
| `filewatch` | 管理檔案監聽目錄（觸發 FileChanged / FileDeleted hook event） | elevated | ❌ |

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

### Builtin Skills（完整清單）

#### Command-type Skills（TypeScript 實作）

| Skill | 觸發詞 | 說明 | Tier |
| ----- | ------ | ---- | ---- |
| `/help` | `/help` | 顯示所有指令清單（含權限標註） | public |
| `/status` | `/status` | 顯示當前 session 與系統狀態（provider、turn、queue、記憶） | standard |
| `/memory` | `/memory` | 記憶庫管理（list / search / status） | standard |
| `/config` | `/config` | 讀取與修改 catclaw.json 設定（get / schema / patch / reload） | admin |
| `/configure` | `/configure` | 調整 provider / model 設定 | admin |
| `/mode` | `/mode` | 切換運作模式（normal / precision / 自訂） | standard |
| `/plan` | `/plan` | 切換 Plan Mode（只分析規劃，不執行修改） | standard |
| `/compact` | `/compact` | 手動觸發 CE 壓縮當前頻道的 session | standard |
| `/context` | `/context` | 顯示當前頻道的 context 使用狀態（token 消耗分布） | standard |
| `/think` | `/think` | 切換 extended thinking 模式（on / off / minimal / low / medium / high / xhigh） | standard |
| `/session` | `/session` | Session 管理（list / clear / compact / purge / delete） | standard |
| `/account` | `/account` | 帳號管理（create / invite / approve / pairings / list / info / link） | admin |
| `/register` | `/register` | 透過邀請碼自助建立帳號 | public |
| `/project` | `/project` | 專案管理（建立、列表、資訊、切換、成員管理） | standard |
| `/use` | `/use` | 暫時切換此頻道的 LLM provider（runtime，不改 config） | admin |
| `/system` | `/system` | 設定此頻道的 system prompt 附加文字 | admin |
| `/usage` | `/usage` | 查詢 token 消耗統計與 CE 壓縮效果 | standard |
| `/turn-audit` | `/turn-audit` | 查詢 Trace Store（token 消耗、CE 觸發、訊息流追蹤） | standard |
| `/aidocs-status` | `/aidocs-status`, `/aidocs status` | 顯示 _AIDocs 知識庫狀態（文件數、覆蓋率、最近變更） | standard |
| `/aidocs-audit` | `/aidocs-audit`, `/aidocs audit` | 審計 _AIDocs 覆蓋率：列出缺失或未覆蓋的模組 | elevated |
| `/aidocs-update` | `/aidocs-update`, `/aidocs update` | 檢查並顯示指定模組文件與原始碼的差異摘要 | elevated |
| `/hook` | `/hook` | Hook 系統管理（list / events / remove / help） | standard |
| `/cron` | `/cron`, `/排程`, `/remind`, `/提醒` | 排程管理（建立、列出、刪除、啟停排程；支援 msg/exec/claude/agent/cli-bridge 動作） | standard |
| `/subagents` | `/subagents` | 查詢與管理子 agent（list / kill） | standard |
| `/stop` | `/stop` | 強制中斷當前 turn，自動回退 session 到本次前的狀態 | standard |
| `/queue` | `/queue` | 查看 TurnQueue 狀態（幾條排隊） | standard |
| `/rollback` | `/rollback` | 手動還原 CE 壓縮前的 session 狀態（--list 列出可用快照） | standard |
| `/clear` | `/clear` | 清除當前頻道的 session 歷史（保留 session，清空 messages） | standard |
| `/add-bridge` | `/add-bridge`, `/addbridge` | 新增 CLI Bridge 設定並驗證上線 | admin |
| `/migrate` | `/migrate` | 記憶遷移管理（從 ~/.claude 匯入、重建索引、查看狀態） | admin |
| `/restart` | `重啟`, `restart` | 重啟 CatClaw bot | admin |
| `/capabilities` | `/capabilities`, `/caps` | 列出 CatClaw 平台全部可用能力（hooks/tools/skills/modules/mcp） | public |

#### Prompt-type Skills（Markdown 注入）

| Skill | 說明 |
| ----- | ---- |
| `/commit` | Create a git commit with proper analysis and safety rules |
| `/pr` | Create a GitHub pull request with proper analysis |
| `/discord` | Discord ops via the message tool（channel=discord） |
