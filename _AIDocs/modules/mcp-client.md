# modules/mcp-client — MCP Server 連線

> 檔案：`src/mcp/client.ts`
> 更新日期：2026-04-20

## 職責

連接外部 MCP server（stdio JSON-RPC 2.0），自動取得 tool 清單並註冊到 ToolRegistry。
每個 server 一個 `McpClient` 實例。

## 設定

```jsonc
// catclaw.json
"mcpServers": {
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"],
    "env": { "API_KEY": "..." },
    "tier": "elevated"      // 此 server 所有 tool 的預設 tier（預設 elevated）
    // deferred 預設 true（McpClient 內部 `this.cfg.deferred !== false`），通常不需明確設定
  }
}
```

## 連線流程

```
McpClient.start()
  ↓ spawn(command, args)          — stdio: pipe/pipe/pipe
  ↓ JSON-RPC: initialize          — protocolVersion: "2024-11-05"
  ↓ notification: initialized
  ↓ JSON-RPC: tools/list          — 取得 server 提供的 tool 清單
  ↓ _registerTools()              — 註冊到 ToolRegistry
  → ready
```

## Tool 命名

MCP tool 註冊名稱格式：`mcp_{serverName}_{toolName}`

例：server `github`、tool `create_issue` → `mcp_github_create_issue`

## Tool 執行

```typescript
// 純文字回傳（向後相容）
client.call(toolName: string, args: Record<string, unknown>): Promise<string>

// Rich content 回傳（含圖片 blocks）
client.callRich(toolName: string, args: Record<string, unknown>): Promise<{
  text: string;
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;  // 有 image 時才設定
  isError: boolean;
}>
```

- `call()` 內部呼�� `callRich()`，只回傳 text
- `callRich()` 偵測 MCP response 中的 image content blocks，有 image 時回傳 `contentBlocks`
- `_registerTools()` 使用 `callRich()`，將 `contentBlocks` 設入 `ToolResult.contentBlocks`
- Agent-loop 偵測到 `contentBlocks` 時直接用 rich content 作為 tool_result（不走 JSON.stringify）
- Claude API provider 將 image blocks 轉為 Vision API 格式，其他 provider fallback 為 JSON

timeout: 30 秒。

## 崩潰重連

- 程序退出或啟動失敗 → 自動重連
- 最多 3 次，間隔指數退避（1s → 2s → 4s）
- 重連成功 → retries 歸零
- 超過上限 → 放棄（log warn）

## JSON-RPC 通訊

| 方向 | 說明 |
|------|------|
| → stdin | `JsonRpcRequest { jsonrpc: "2.0", id, method, params }` |
| ← stdout | `JsonRpcResponse { jsonrpc: "2.0", id, result?, error? }` |
| ← stderr | debug log |

每個 request 有獨立 id，pending Map 追蹤 resolve/reject。

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `platform.ts` | 遍歷 `config.mcpServers` 建立 McpClient + start() |
| ToolRegistry | `_registerTools()` 自動註冊 tool |
| `agent-loop.ts` | 透過 ToolRegistry 正常呼叫 MCP tool |
