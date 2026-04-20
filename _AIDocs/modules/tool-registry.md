# modules/tool-registry — Tool 註冊 + Builtin Tools

> 檔案：`src/tools/registry.ts` + `src/tools/builtin/`
> 更新日期：2026-04-20

## 職責

Tool 自動掃描載入、register/execute、hot-reload、MCP tool 整合。

## ToolRegistry

```typescript
class ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  all(): Tool[]
  loadFromDirectory(dir: string): Promise<void>  // 掃描 dist/tools/builtin/
  watchDirectory(dir: string): void               // Hot-reload
  execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
```

### Tool 介面

```typescript
interface Tool {
  name: string;
  description: string;
  tier: "public" | "standard" | "elevated" | "admin" | "owner";
  deferred?: boolean;          // true = 名稱注入 system prompt，schema 需 tool_search 載入
  parameters: JsonSchema;
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  result?: unknown;
  error?: string;
  fileModified?: boolean;
  modifiedPath?: string;
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;  // MCP image 等 rich content
}
```

### ToolContext

```typescript
interface ToolContext {
  accountId: string;
  sessionId: string;
  channelId: string;
  projectId?: string;
  eventBus: Pick<EventEmitter, "emit">;
  spawnDepth?: number;       // 0=頂層，≥2 時禁止再 spawn
  parentRunId?: string;      // 父 subagent 的 runId
  traceId?: string;          // 當前 turn 的 traceId
  agentId?: string;          // Agent ID（spawn 帶 agent 身份時注入）
  isAdmin?: boolean;         // 管理者 agent（agent config.json 的 admin flag）
}
```

## 25 Builtin Tools

### 檔案操作（elevated）

| Tool | 說明 |
|------|------|
| `read_file` | 讀取檔案（支援行範圍、圖片、PDF） |
| `write_file` | 建立/覆寫檔案（Read-before-Write 強制，File Size Guard: 預設 500KB） |
| `edit_file` | 精確字串替換（old_string → new_string，File Size Guard: 預設 1MB） |
| `glob` | Glob pattern 檔案搜尋（支援 `offset` / `limit` 分頁；硬上限 1000 筆；結果按 mtime 降序） |
| `grep` | 正則內容搜尋，ripgrep 風格（支援 `offset` / `head_limit` 分頁；硬上限 200 筆） |

### 系統指令（elevated）

| Tool | 說明 |
|------|------|
| `run_command` | 執行 shell 指令（timeout + cwd + abort） |

### 網路（elevated，deferred）

| Tool | 說明 | resultTokenCap | timeoutMs |
|------|------|---------------|-----------|
| `web_fetch` | HTTP 請求 + HTML→純文字（SSRF 保護：拒絕私有 IP / localhost） | 8000 | 20000 |
| `web_search` | 網頁搜尋（DuckDuckGo） | 4000 | 15000 |

**web_fetch SSRF 保護**：解析 URL hostname，以正則比對拒絕 `localhost`、`127.x`、`::1`、`10.x`、`172.16-31.x`、`192.168.x`、`169.254.x`、`fc/fd` 前綴。只允許 `http:` / `https:` 協定。 |

### 記憶（standard，deferred）

| Tool | 說明 |
|------|------|
| `memory_recall` | 向量+關鍵字記憶搜尋 |
| `atom_write` | 寫入/更新記憶 atom（scope: global/agent/project/account，global 寫入需 `globalMemoryWrite` 權限） |
| `atom_delete` | 刪除記憶 atom（scope: global/agent/project/account） |

### Config（admin，deferred）

| Tool | 說明 |
|------|------|
| `config_get` | 讀取 catclaw.json 設定 |
| `config_patch` | 修改 catclaw.json 設定（whitelist 含 restartNotify.enabled / showPendingTasks） |

### Subagent（standard）

| Tool | 說明 |
|------|------|
| `spawn_subagent` | 啟動子 agent（task + provider + depth 控制 + agent/model/workspaceDir） |
| `subagents` | 列出/查詢子 agent 狀態 |

### Session（standard，deferred）

| Tool | 說明 |
|------|------|
| `clear_session` | 清空 session 歷史 |
| `session_context` | 查詢當前 session 的 context window 用量、CE threshold 距離、rate limit 狀態 |

### 任務（standard，deferred）

| Tool | 說明 |
|------|------|
| `task_manage` | 任務 CRUD（TaskStore） |

### LLM（standard，deferred）

| Tool | 說明 |
|------|------|
| `llm_task` | 委派子任務給 LLM（非 agent loop，單次推理） |

### Skill（standard）

| Tool | 說明 |
|------|------|
| `skill` | 執行 builtin skill 指令（LLM 傳入完整指令如 `/cron list`，橋接 SkillContext 執行）。admin agent（`ctx.isAdmin`）跳過 checkTier，並用 `allowedUserIds[0]` 作為 effectiveAuthorId 讓 skill 內部 isAdmin 檢查通過 |

### Hook（elevated/standard）

| Tool | Tier | 說明 |
|------|------|------|
| `hook_register` | elevated | 寫入新 hook 腳本至 `workspace/hooks/` 或 `agents/{id}/hooks/`（fs.watch 自動 reload） |
| `hook_list` | standard | 列出已註冊 hooks（可依 event / scope 篩選） |
| `hook_remove` | elevated | 刪除或停用（rename to `*.disabled.*`）指定 hook |

### File Watcher（elevated）

| Tool | 說明 |
|------|------|
| `filewatch` | 管理檔案監聽目錄（list/add/remove）— 動態新增或移除外部檔案監聽 |

### Meta（public）

| Tool | 說明 |
|------|------|
| `tool_search` | 搜尋 deferred tools 的完整 schema |

## Deferred Tool Loading

Deferred tools 的 schema 不直接注入 `tools` 參數（省 token）。
流程：
1. `deferred: true` 的 tool → 名稱+描述注入 system prompt
2. LLM 需要使用時 → 呼叫 `tool_search` → 取得完整 schema
3. Schema 載入到 `loadedDeferredNames` → 後續 LLM 呼叫可直接使用

## MCP Tool 整合

MCP server 的 tools 透過 `McpClient` 自動注冊到 ToolRegistry。
名稱格式：`mcp_${serverName}_${toolName}`（單底線）

## Permission Tier

| Tier | 說明 |
|------|------|
| `public` | 未註冊也可用 |
| `standard` | 所有角色可用 |
| `elevated` | member 以上 |
| `admin` | admin 以上 |
| `owner` | platform-owner 專用 |

PermissionGate 根據 accountId 的角色過濾可用 tools。

## 全域單例

```typescript
initToolRegistry(opts?: { defaultTimeoutMs?: number }): ToolRegistry
getToolRegistry(): ToolRegistry
```

## Timeout 策略

- **預設 `defaultTimeoutMs = 0`**（不逾時）— tool 內部自行決定中斷時機
- **Per-tool `timeoutMs`** 可覆寫（如 `web_fetch=20000`, `web_search=15000`）
- **Soft warning**：執行超過 `SOFT_WARN_MS = 60_000` 發 warn log，不中斷
- 可由 `catclaw.json.contextEngineering.toolBudget.toolTimeoutMs` 覆寫全域預設

## Hook 整合

- **registry.execute**：tool `timeoutMs > 0` 且逾時時觸發 `ToolTimeout`（observer）
- **write-file**：`PreFileWrite`（可 block）
- **edit-file**：`PreFileEdit`（可 block）
- **run-command**：`PreCommandExec`（可 block）
- **atom-write**：`PreAtomWrite`（可 block/modify content）、`PostAtomWrite`
- **atom-delete**：`PreAtomDelete`（可 block）、`PostAtomDelete`
- **spawn-subagent**：`PreSubagentSpawn`（可 block）、`PostSubagentComplete`、`SubagentError`

詳見 `modules/hooks.md`。
