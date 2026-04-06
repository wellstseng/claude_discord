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

### 憑證檔格式（V2，對齊 OpenClaw）

路徑：`{CATCLAW_WORKSPACE}/agents/default/auth-profile.json`

```json
{
  "version": 1,
  "profiles": {
    "anthropic:default": { "type": "api_key", "provider": "anthropic", "key": "sk-ant-..." }
  },
  "order": { "anthropic": ["anthropic:default"] },
  "usageStats": { "anthropic:default": { "lastUsed": 0, "cooldownUntil": 0 } }
}
```

profileId 格式：`"provider:name"`，credential type：`api_key` / `token` / `oauth`。

### 生命週期

1. `new AuthProfileStore(filePath: string)` + `load()`
2. `load()` → 讀取 auth-profile.json（profiles + order + usageStats）
3. `pickForProvider(provider: string): PickResult | null` → 依 order 找未 disabled + cooldown 未過期的 profile
4. 呼叫失敗 → `setCooldown(id, reason)` 設 cooldown 或永久停用

### Cooldown 時長

| reason | 時長 |
|--------|------|
| `rate_limit` | 5 小時 |
| `overloaded` | 5 分鐘 |
| `billing` | 24 小時 |
| `auth` | 永久停用（Infinity） |

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

## CircuitBreaker（circuit-breaker.ts）

Provider 健康狀態追蹤，防止持續呼叫已故障的 provider。

### 狀態機

```
closed → （windowMs 內失敗 ≥ errorThreshold）→ open
open → （冷卻 cooldownMs 後）→ half-open
half-open → 成功 → closed
half-open → 失敗 → open
```

### 設定（CircuitBreakerConfig）

| 參數 | 預設 | 說明 |
|------|------|------|
| `errorThreshold` | 3 | 觸發開路的錯誤次數門檻 |
| `windowMs` | 60,000 | 計算錯誤次數的時間窗口（ms） |
| `cooldownMs` | 30,000 | 開路後的冷卻時間（ms） |

### API

| 方法 | 說明 |
|------|------|
| `isAvailable(): boolean` | 是否允許呼叫（closed/half-open → true，open 未冷卻 → false） |
| `recordSuccess()` | half-open → closed，清除錯誤記錄 |
| `recordFailure()` | 計入失敗，達門檻 → open |
| `getState(): BreakerState` | 回傳 "closed" / "open" / "half-open" |
| `getStatus(): BreakerStatus` | 回傳 state + errorCount + lastFailureAt + openedAt |
| `reset()` | 強制重置到 closed（維運用） |

## FailoverProvider（failover-provider.ts）

將多個 provider 組成 failover 鏈，實作 `LLMProvider` 介面。

### 建構

```typescript
const failover = new FailoverProvider("failover", [
  { provider: claudeProvider, breaker: new CircuitBreaker("claude-api") },
  { provider: ollamaProvider, breaker: new CircuitBreaker("ollama") },
]);
// 或使用 builder
const failover = buildFailoverProvider("failover", [claudeProvider, ollamaProvider], breakerCfg?);
```

### stream() 行為

1. 依序遍歷 chain，`breaker.isAvailable()` 為 false → 跳過
2. 呼叫 `provider.stream(messages, opts)`
3. 成功 → `breaker.recordSuccess()` → 回傳 StreamResult
4. 失敗 → `breaker.recordFailure()` → 嘗試下一個
5. 4xx（非 429）→ 不計入 breaker，直接 throw（非 provider 故障）
6. AbortError → 直接 throw（不算失敗）
7. 全部失敗 → throw Error

### 監控 API

| 方法 | 說明 |
|------|------|
| `getStatus(): FailoverStatus` | 回傳 activeProvider + chain 中各 provider 的 BreakerStatus |
| `resetAll()` | 重置所有 circuit breaker |
| `resetProvider(id)` | 重置指定 provider 的 breaker |

### LLMProvider 介面實作

| 屬性 | 邏輯 |
|------|------|
| `modelId` | 取 chain[0] 的 modelId |
| `supportsToolUse` | chain 中任一支援 → true |
| `maxContextTokens` | 取第一個可用 provider 的上限 |

## CodexOAuthProvider（codex-oauth.ts）

OpenAI Codex OAuth Provider，使用 Responses API（`/v1/responses`）。

### 認證流程

1. 讀取 `~/.codex/auth.json`（或自訂 `oauthTokenPath`）
2. 檢查 `expires_at` → 過期前 5 分鐘觸發 HTTP refresh
3. 更新 auth.json + 用 `access_token` 作 Bearer header

### 建構子

```typescript
new CodexOAuthProvider(id, entry, authStore?)
```

| 屬性 | 預設 |
|------|------|
| `baseUrl` | `https://chatgpt.com/backend-api` |
| `modelId` | `openai-codex/gpt-5.4` |
| `tokenPath` | `~/.codex/auth.json` |
| `refreshUrl` | `https://auth.openai.com/oauth/token` |
| `supportsToolUse` | `true` |
| `maxContextTokens` | 128,000 |

### auth.json 格式

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": 1234567890,
  "token_type": "Bearer"
}
```

## models-config.ts — 模型目錄管理

### BUILTIN_PROVIDERS 內建目錄

| Provider Key | API | 包含模型 |
|-------------|-----|---------|
| `anthropic` | anthropic-messages | claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5-20250514, claude-haiku-4-5-20251001 |
| `openai` | openai-completions | gpt-4o, gpt-4o-mini |
| `openai-codex` | openai-codex-responses | gpt-5.4 |

### ensureModelsJson(workspaceDir, modelsConfig?)

產生 `{CATCLAW_WORKSPACE}/agents/default/models.json`。

合併模式（`modelsConfig.mode`）：

| mode | 行為 |
|------|------|
| `merge`（預設） | BUILTIN_PROVIDERS + 自訂合併（自訂的 baseUrl/api 覆寫，models 追加） |
| `replace` | 只用自訂 providers |

寫入使用 atomic write（先寫 `.tmp` 再 rename），內容相同時不寫入。

### loadModelsJson(workspaceDir)

讀取已生成的 models.json，快取在模組層級變數。

## Provider Registry V2 — 最新 API

### ProviderRegistry class

```typescript
class ProviderRegistry {
  constructor(defaultId: string, routing: ProviderRoutingConfig, aliases?: Record<string, ModelAliasEntry>)

  register(provider: LLMProvider): void
  resolve(opts?: ResolveOpts): LLMProvider    // 路由解析
  get(id: string): LLMProvider | undefined    // 直接取得（支援 alias 解析）
  list(): LLMProvider[]
  initAll(): Promise<void>
  shutdownAll(): Promise<void>
}
```

### ResolveOpts

```typescript
interface ResolveOpts {
  channelId?: string;
  projectId?: string;
  role?: string;
}
```

路由優先序：`channels[channelId]` → `projects[projectId]` → `roles[role]` → `defaultId`

### Alias 解析

`resolve()` 和 `get()` 都支援 alias → `provider/model` 格式解析（透過 `parseModelRef`）。

### buildProviderRegistryV2()

```typescript
async function buildProviderRegistryV2(
  agentDefaults: AgentDefaultsConfig,
  modelsJson: ModelsJsonConfig,
  authStore: AuthProfileStore | null,
  routing: ProviderRoutingConfig,
): Promise<ProviderRegistry>
```

流程：
1. 解析 `agentDefaults.model.primary` 為 ModelRef
2. 收集 primary + fallbacks + models 表中所有 ref
3. 按 provider 分組，由 `apiToProviderType()` 推斷型別
4. 建立對應 LLMProvider 實例（ClaudeApiProvider / OllamaProvider / OpenAICompatProvider / CodexOAuthProvider / CliProvider）
5. 註冊到 ProviderRegistry
