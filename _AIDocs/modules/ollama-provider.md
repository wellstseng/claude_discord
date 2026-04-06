# modules/ollama-provider — Ollama 本地 LLM Provider

> 檔案：`src/providers/ollama.ts`
> 更新日期：2026-04-06

## 職責

透過 Ollama Native HTTP API（`/api/chat`）與本地 LLM 模型通訊。
與 openai-compat 的差異：端點不同、NDJSON 串流（非 SSE）、支援 `think` 參數。

## 核心流程

```
stream(messages, opts)
  ↓ convertMessages() — catclaw Anthropic 格式 → Ollama 格式
  ↓ POST /api/chat { model, messages, stream: true, options, think, tools? }
  ↓ parseNdjsonStream() — NDJSON 每行一個 JSON
  ↓ tool_calls 有值 → stopReason = "tool_use"
  → StreamResult { events, stopReason, toolCalls, text, usage }
```

## 設定

```jsonc
// catclaw.json V1
"providers": {
  "ollama": { "type": "ollama", "host": "http://localhost:11434", "model": "qwen3:1.7b" }
}

// models-config.json V2
"providers": {
  "ollama": { "baseUrl": "http://localhost:11434", "api": "ollama", "models": [...] }
}
```

| 參數 | 預設 | 說明 |
|------|------|------|
| `host` / `baseUrl` | `http://localhost:11434` | Ollama HTTP 端點 |
| `model` | `qwen3:1.7b` | 模型 ID |
| `think` | `false` | 啟用 thinking 模式（qwen3 等） |
| `numPredict` | `4096` | 最大生成 token 數 |
| `supportsToolUse` | `true`（預設） | 建構時預設 true，init() 查 `/api/show` capabilities 可覆寫 |

## init() — 自動偵測 tool_use 能力

啟動時 POST `/api/show` 查詢模型 capabilities：
- `capabilities` 包含 `"tools"` → `supportsToolUse = true`
- 否則 → 純文字模式
- Ollama offline → 使用預設值（graceful）

## 訊息格式轉換

| catclaw 格式 | Ollama 格式 |
|-------------|------------|
| `{ role: "user", content: "text" }` | `{ role: "user", content: "text" }` |
| user content blocks（text + image） | `{ role: "user", content, images: [base64...] }` |
| user tool_result blocks | `{ role: "tool", content }` 每個 result 一則 |
| assistant tool_use blocks | `{ role: "assistant", tool_calls: [{ function: { name, arguments } }] }` |
| system prompt | `{ role: "system", content }` 置頂 |

## NDJSON 串流解析

逐行讀取 response body：
- `message.content` → `text_delta` event
- `message.tool_calls` → 收集 ToolCall（自動生成 UUID 作 ID）
- `done: true` → 統計 `prompt_eval_count` / `eval_count`
- `done_reason: "length"` → `max_tokens`

## Token 計量

| 來源 | 使用 |
|------|------|
| `prompt_eval_count` | input tokens（Ollama 回傳） |
| `eval_count` | output tokens（Ollama 回傳） |
| 字數 ÷ 4 | fallback 估算（`estimated: true`） |

## Basic Auth

設定 `mode: "password"` + `username` 時啟用 Basic Auth header。
用於連接受密碼保護的 Ollama 實例（如 Open WebUI 代理）。

## 全域單例

無。由 ProviderRegistry 管理生命週期。
