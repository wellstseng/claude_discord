# providers — LLM Provider 系統

> 更新日期：2026-04-05

## 檔案

| 檔案 | 說明 |
|------|------|
| `src/providers/base.ts` | 型別定義：LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent |
| `src/providers/registry.ts` | ProviderRegistry：V1（ProviderEntry）+ V2（三層分離：agentDefaults + models.json + authStore） |
| `src/providers/claude-api.ts` | ClaudeApiProvider（@mariozechner/pi-ai） |
| `src/providers/auth-profile-store.ts` | AuthProfileStore：多憑證管理 + cooldown |
| `src/providers/ollama.ts` | OllamaProvider（OpenAI-compat API） |
| `src/providers/openai-compat.ts` | OpenAICompatProvider（第三方 OpenAI-compat） |
| `src/providers/codex-oauth.ts` | CodexOAuthProvider（pi-ai OAuth） |
| `src/providers/acp-cli.ts` | CliProvider：透過 AI Agent CLI（Claude/Gemini/Codex）spawn 做 LLM 推理 |
| `src/providers/models-config.ts` | models.json 產生與載入（內建目錄 + 自訂合併） |
| `src/providers/model-ref.ts` | ModelRef 解析（"provider/model" 格式） |
| `src/providers/failover-provider.ts` | FailoverProvider + CircuitBreaker |

## ClaudeApiProvider（claude-api.ts）

使用 `@mariozechner/pi-ai` v0.58.0 的 `streamSimpleAnthropic` 呼叫 Anthropic API。

### 核心流程

```
stream(messages, opts)
  ↓ AuthProfileStore.pick() → credential
  ↓ getModel("anthropic", modelId)
  ↓ toPiMessages(messages) — catclaw → pi-ai 格式
  ↓ toPiTools(tools) — JSON Schema → Type.Unsafe(schema)
  ↓ streamSimpleAnthropic(model, context, { apiKey, maxTokens, signal, temperature })
  ↓ _convertEvent() — pi-ai events → catclaw ProviderEvent
  → StreamResult { events, stopReason, toolCalls, text }
```

### OAuth vs API Key 自動偵測

`streamSimpleAnthropic` 內部自動處理：
- `sk-ant-oat01-...` → `Authorization: Bearer` + OAuth betas headers
- `sk-ant-api...` → `x-api-key`

### 訊息格式轉換

catclaw 使用 Anthropic-native 格式（tool_result 在 user content blocks）；
pi-ai 使用分離的 `ToolResultMessage`（role: "toolResult"）。

轉換邏輯：
- `buildToolNameMap()` — 從 assistant 訊息建立 `tool_use_id → toolName` 反查表
- `toPiMessages()` — user string → UserMessage；user tool_result blocks → ToolResultMessage；assistant → AssistantMessage（TextContent + ToolCall）
- `toPiTools()` — `input_schema` JSON Schema → `Type.Unsafe(schema)`（typebox）

### ProviderEvent 對應

| pi-ai event | catclaw ProviderEvent |
|------------|----------------------|
| `text_delta` | `{ type: "text_delta", text }` |
| `thinking_delta` | `{ type: "thinking_delta", thinking }` |
| `toolcall_end` | `{ type: "tool_use", id, name, params }` |
| `done` (end_turn) | `{ type: "done", stopReason: "end_turn", text }` |
| `done` (toolUse) | `{ type: "done", stopReason: "tool_use", text }` |
| `error` | `{ type: "error", message }` |

### 設定（catclaw.json）

```jsonc
"providers": {
  "claude-oauth": {
    "type": "claude-api",
    "model": "claude-sonnet-4-6"   // 選填，預設 claude-sonnet-4-6
    // 無 token/profiles 欄位 — 憑證從 auth-profile.json 讀
  }
}
```

**不使用** `token: "${ENV_VAR}"` 或 `profiles[]`，已移除。

## AuthProfileStore（auth-profile-store.ts）

多憑證輪替 + cooldown 管理。

### 資料分離

| 用途 | 路徑 |
|------|------|
| 憑證（user-editable） | `{CATCLAW_WORKSPACE}/agents/default/auth-profile.json` |
| 狀態（runtime-managed） | `{CATCLAW_WORKSPACE}/data/auth-profiles/{providerId}-profiles.json` |

### 憑證檔格式

```json
[{ "id": "key-1", "credential": "sk-ant-oat01-..." }]
```

### 生命週期

1. `new AuthProfileStore({ providerId, persistPath, credentialsFilePath })` + `load()`
2. `load()` → 讀 state 檔 → 讀憑證檔 → `_mergeCredentials()`（更新 credential，保留 state）
3. `pick()` → 找第一個未 disabled + cooldown 未過期的 profile
4. 呼叫失敗 → `setCooldown(id, reason)` 設 cooldown 或永久停用

### Cooldown 時長

| reason | 時長 |
|--------|------|
| `rate_limit` | 15 分鐘 |
| `overloaded` | 5 分鐘 |
| `billing` | 永久停用 |
| `auth` | 永久停用 |

### 陷阱

- 永久停用後必須刪 state 檔（`data/auth-profiles/{id}-profiles.json`）再重啟才能恢復
- 憑證檔只讀不寫（由使用者維護）；state 檔由 runtime 自動更新

## CliProvider（acp-cli.ts）

透過 AI Agent CLI（Claude Code / Gemini CLI / Codex CLI）spawn 子程序做 LLM 推理。
使用訂閱制額度（Max Plan / Gemini Pro 等），不走 API 計費。

### 設計原則

- `supportsToolUse = false` — 純推理模式，tool 任務應由 fallback chain 走 API provider
- 將 `Message[]` 扁平化為文字 prompt，透過 `-p` non-interactive 模式送出
- 支援三種 CLI 後端，各有不同的輸出格式

### CLI 後端

| 後端 | 指令 | 輸出格式 | context window |
|------|------|---------|---------------|
| claude | `claude -p --output-format stream-json --max-turns 1 --verbose {prompt}` | stream-json | 200k |
| gemini | `gemini -p {prompt} --output-format stream-json` | stream-json | 1M |
| codex | `codex --quiet --full-auto {prompt}` | text | 200k |

### stream-json 事件解析

Claude/Gemini 共用 stream-json 格式，每行一個 JSON 物件：

| type | 處理 |
|------|------|
| `system` | 忽略（hook 啟動、init 等） |
| `assistant` | 取 `message.content[]` 的 text/thinking blocks，差量發 text_delta/thinking_delta |
| `result` | 取 `result` 文字 + `stop_reason`；`is_error` 時發 error event |

### 設定（models-config.json）

```json
{
  "aliases": {
    "cli-claude": "cli-claude/claude",
    "cli-gemini": "cli-gemini/gemini"
  },
  "providers": {
    "cli-claude": {
      "baseUrl": "",
      "models": [{
        "id": "claude",
        "name": "Claude CLI (Max Plan)",
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200000,
        "maxTokens": 16000
      }]
    }
  }
}
```

- `baseUrl` 空字串：使用預設 CLI 指令名（`claude`/`gemini`/`codex`）
- `baseUrl` 有值時：覆寫 CLI 執行檔路徑
- Provider name 必須是 `cli-claude`/`cli-gemini`/`cli-codex`（registry 靠 name 推斷 type）

### Token 估算

CLI 不回傳真實 token 數，用字數 ÷ 4 估算（`estimated: true`）。

## Provider Registry V2（三層分離）

### 設定層級

| 層 | 檔案 | 用途 |
|----|------|------|
| 模型目錄 | `models-config.json` → 生成 `agents/default/models.json` | provider 連線 + model 定義 |
| Agent 預設 | `models-config.json` 的 primary/fallbacks/aliases | 選用哪些 model |
| 認證 | `agents/default/auth-profile.json` | API credential |

### 型別推斷（apiToProviderType）

優先用 `ModelProviderDefinition.api` 欄位，fallback 用 provider name 推斷：

| api 欄位 | → ProviderType |
|----------|---------------|
| `anthropic-messages` | claude |
| `openai-completions` | openai-compat |
| `openai-codex-responses` | codex-oauth |
| `ollama` | ollama |
| (無) + name `cli-claude` | cli-claude |
| (無) + name `cli-gemini` | cli-gemini |

### Failover Chain

`models-config.json` 的 `routing.failoverChain` 可設定 failover 順序：

```json
{ "routing": { "failoverChain": ["cli-claude", "sonnet"] } }
```

走 `FailoverProvider` + `CircuitBreaker`，第一個失敗自動 fallback。
