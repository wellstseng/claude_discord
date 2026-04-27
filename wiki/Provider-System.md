# Provider System

`src/providers/` — LLM 抽象層，支援多 provider failover 與 circuit breaker。

## 架構

```mermaid
graph TD
    AGL[Agent Loop] --> FP[FailoverProvider]
    FP --> CB1[CircuitBreaker]
    FP --> CB2[CircuitBreaker]
    FP --> CB3[CircuitBreaker]
    CB1 --> P1[Claude API]
    CB2 --> P2[Ollama]
    CB3 --> P3[OpenAI-compat]
```

## Provider 介面

所有 provider 實作 `LLMProvider` 介面：

```typescript
interface LLMProvider {
  id: string
  modelId: string
  supportsToolUse: boolean
  init(): Promise<void>
  stream(messages, tools, opts): AsyncGenerator<StreamEvent>
  shutdown(): Promise<void>
}
```

## 支援的 Provider

| Provider | 說明 |
| -------- | ---- |
| `claude` / `claude-oauth` | Anthropic Claude API（V2 使用 `claude-oauth` + OAuth token） |
| `openai-compat` | OpenAI-compatible API（任何相容端點） |
| `ollama` | 本地 Ollama 推理 |
| `codex-oauth` | OAuth-based Codex；**共用 `~/.codex/auth.json` 與 Codex CLI**（避免雙方 refresh 互踩），支援 nested 格式 + JWT exp 解析（4-23） |
| `cli-claude` | Spawn Claude CLI（ACP 路徑），可走 control_request 互動權限審批 |
| `cli-gemini` | Spawn Gemini CLI |
| `cli-codex` | Spawn Codex CLI；繼承全域 `~/.codex` 設定，approval decision 採用新 enum API |

> **內建模型清單**：自 4-26 起改從 `@mariozechner/pi-ai` 動態抽取（`buildBuiltinProviders()`），pi-ai 升版重啟自動帶新 provider/model。Dashboard 模型快捷依「auth-profile.json 的 provider」動態分組。

## ProviderRegistry

路由決策優先序：

```text
channels[channelId] → projects[projectId] → roles[role] → defaultId
```

支援 per-channel、per-project、per-role 指定不同 provider。

## Failover 機制

`FailoverProvider.stream()` 的處理流程：

1. 依序嘗試 failover chain 中的 provider
2. 跳過 circuit breaker 為 open 狀態的 provider
3. 成功 → `breaker.recordSuccess()`，回傳結果
4. 4xx 錯誤（非 429、非 quota）→ 不記錄失敗，直接拋出（用戶端錯誤不算 provider 問題）
5. **5xx / 429 / quota error / 網路錯誤** → `breaker.recordFailure()`，嘗試下一個（4-26：quota error 也觸發 failover，避免長時間掛死在已耗盡的 provider）
6. 全部失敗 → 拋出合併錯誤訊息

## Circuit Breaker

三態狀態機：

```text
        ┌─ success ─┐
        ↓            │
    [Closed] ──errorThreshold──→ [Open]
        ↑                          │
        │                     cooldown elapsed
        │                          ↓
        └── success ──────── [Half-Open]
                                   │
                              failure → [Open]
```

| 參數 | 預設 | 說明 |
| ---- | ---- | ---- |
| `errorThreshold` | 3 | windowMs 內失敗幾次觸發 open |
| `windowMs` | 60,000 ms | 失敗計數視窗 |
| `cooldownMs` | 30,000 ms | open 後冷卻時間 |

**Half-Open** 狀態只允許一次試探請求：成功 → 回到 closed，失敗 → 回到 open。

## 輔助模組

| 模組 | 檔案 | 說明 |
| ---- | ---- | ---- |
| AuthProfileStore | `auth-profile-store.ts` | 多憑證管理（API key / token / OAuth），Round-Robin 選取 + Cooldown 追蹤 + 持久化 |
| ModelRef | `model-ref.ts` | Model alias 解析，支援 `"provider/model"` 格式與短別名（如 `"sonnet"` → `anthropic/claude-sonnet-4-6`） |
| ModelsConfig | `models-config.ts` | V2 多模型設定，管理 `models.json` 產生與載入（內建目錄 + catclaw.json 自訂覆寫） |
