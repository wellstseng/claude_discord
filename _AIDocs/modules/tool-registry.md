# modules/tool-registry — Tool 註冊 + Builtin Tools

> 檔案：`src/tools/registry.ts` + `src/tools/builtin/`
> 更新日期：2026-04-10

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

## 18 Builtin Tools

### 檔案操作（elevated）

| Tool | 說明 |
|------|------|
| `read_file` | 讀取檔案（支援行範圍、圖片、PDF） |
| `write_file` | 建立/覆寫檔案（Read-before-Write 強制，File Size Guard: 預設 500KB） |
| `edit_file` | 精確字串替換（old_string → new_string，File Size Guard: 預設 1MB） |
| `glob` | Glob pattern 檔案搜尋 |
| `grep` | 正則內容搜尋（ripgrep 風格） |

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

### Config（admin，deferred）

| Tool | 說明 |
|------|------|
| `config_get` | 讀取 catclaw.json 設定 |
| `config_patch` | 修改 catclaw.json 設定 |

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
initToolRegistry(opts?): ToolRegistry
getToolRegistry(): ToolRegistry
```
