# modules/health-monitor — 元件健康追蹤與通報

> 檔案：`src/core/health-monitor.ts`
> 引入日期：2026-04-27

## 解決的問題

CatClaw 大量子系統採 **graceful skip**（不掛主流程，繼續跑），但缺乏「失敗達閾值就要通報人類」的機制 → 變成**靜默失敗**：

- Ollama model name 寫錯（`qwen3:14b` 不存在）→ embedding 一直 `OllamaClient 尚未初始化` graceful skip → 12 天無人發現
- memory-extractor flush 22 次無一次成功萃取（model 拿不到）→ 無 ERROR、無紅燈、無通報
- log 看似正常運作，實際關鍵組件全部癱瘓

> 此模組是反「靜默失敗」設計：失敗就計數，連續達門檻就升級 ERROR 並通報。

## 核心 API

```ts
import { recordSuccess, recordFailure, getAllHealth, reportStartupSummary } from "./core/health-monitor.js";

// 在 graceful skip 點呼叫
try {
  await provider.embed(texts);
  recordSuccess("embedding:ollama");
} catch (err) {
  recordFailure("embedding:ollama", err.message);
}

// 啟動時對關鍵 component 跑 verify，集中印紅綠燈摘要
reportStartupSummary([
  { name: "ollama:primary:llm", ok: true,  detail: "model qwen3:1.7b @ http://localhost:11434" },
  { name: "ollama:primary:embedding", ok: false, detail: "model not found" },
]);

// REST API 取所有 component 狀態（dashboard 用）
const all = getAllHealth();
```

## 升級門檻（in-memory，重啟歸零）

| 連續失敗次數 | 狀態     | 動作 |
|-------------|----------|------|
| 1           | healthy → 仍 healthy | 只更新 lastError + 計數 |
| 2           | degraded             | `log.warn` + emit `health:degraded` |
| 5           | unhealthy            | `log.error` + emit `health:critical`（觸發通報） |
| 任何成功    | 從 degraded/unhealthy → healthy | `log.info` + emit `health:recovered` + 清通報節流 |

通報節流：同 component `health:critical` 1 小時內只 emit 一次（避免轟炸）。

## Event Bus 整合

`src/core/event-bus.ts` 新增 4 個事件：

| 事件 | Payload | 觸發時機 |
|------|---------|----------|
| `health:startup`   | `[results: Array<{ name, ok, detail }>]` | `reportStartupSummary()` 被呼叫時（一次） |
| `health:degraded`  | `[name, error]` | 連續失敗達 2 次（首次） |
| `health:critical`  | `[name, error]` | 連續失敗達 5 次 + 1 小時內未通報過 |
| `health:recovered` | `[name]`        | 從 degraded/unhealthy 恢復 healthy |

`src/index.ts` 訂閱這些事件 → Discord errorNotifyChannel：

- `health:startup`（有失敗才送）→ `🩺 Startup Health Summary — N 項失敗`
- `health:critical` → `🚨 Component CRITICAL: \`name\``
- `health:recovered` → `✅ Component 已恢復: \`name\``

## Startup Health Check 流程

`src/core/platform.ts` 在 `_ready = true` 之前呼叫 `runStartupHealthCheck(config)`：

1. **Ollama backend reachability + 各 model 存在性**
   `OllamaClient.verifyAllModels()` → 對每個 enabled backend 跑 `POST /api/show` 驗 llm 與 embedding model
2. **Embedding provider verify**
   `EmbeddingProvider.verify?()` — Ollama 實作會比對 model name 是否在某個 backend；非 Ollama provider 預設假設 ok
3. **Extraction provider verify**
   同上，比對 llm model name

集中印出：

```
[health] ━━━━━━━━━━━━━━━ Startup Health Summary ━━━━━━━━━━━━━━━
[health] ✓ ollama:primary:llm：model qwen3:1.7b @ http://localhost:11434
[health] ✗ ollama:primary:embedding：model "qwen3-embedding:8b" not found on primary
[health] ✓ extraction-provider:ollama：qwen3:1.7b（verify 通過）
[health] ✗ embedding-provider:ollama：無 backend 定義 embedding model "qwen3-embedding:8b"
[health] ━━━━━━━━━━━━━━━ 2 OK / 2 FAIL ━━━━━━━━━━━━━━━
```

**失敗不 throw**：保持 graceful，dashboard 仍可訪問；但 `log.error` + Discord 通報。

## Dashboard 整合

- **GET `/api/health`** → 回 `{ summary, components, startup }`
- **「日誌」tab → 🩺 Component Health 面板**
  - 紅綠燈總覽（healthy/degraded/unhealthy/unknown 計數）
  - 表格列出每個 component（狀態 / 名稱 / 成功 / 失敗 / 連續失敗 / 最後失敗時間 / 最後錯誤訊息）
  - 折疊區塊：啟動健康摘要

## 已接通的 graceful skip 點

| 位置 | Component name |
|------|---------------|
| `OllamaEmbeddingProvider.embed()` | `embedding:ollama` |
| `GoogleEmbeddingProvider.embed()` | `embedding:google` |
| `OllamaExtractionProvider.generate()` / `chat()` | `extraction:ollama`（含「回傳空字串視為 silent fail」判定） |

## 設計決策

- **Component 名稱用 `:` 分層**（`embedding:ollama`、`ollama:primary:llm`），方便 dashboard 排序與 filter
- **Startup 失敗者初始化為 unhealthy + consecutiveFailures = CRITICAL_THRESHOLD**：第一次失敗就視為 critical（避免要再撞 5 次才通報）
- **不寫磁碟**：所有狀態在 memory，重啟歸零（避免 stale 警告誤導）
- **不 throw**：保留 graceful skip 的初衷（不掛主流程），但用「通報」補回可見性

## 相關文件

- `modules/ollama-provider.md` — Ollama Client 的 `verifyModel` / `verifyAllModels` API
- `modules/dashboard.md` — `/api/health` endpoint + 健康面板
- `modules/event-bus.md` — health:* event 型別
- `modules/platform.md` — `runStartupHealthCheck()` 在啟動序的位置

## 已知限制（後續可改進）

- L1 fail-loud 只覆蓋 Ollama 路徑；非 Ollama provider（Anthropic/OpenAI/Google）尚未實作 verify（目前回 `ok: true`）
- 通報通道是 errorNotifyChannel（Discord channel），不是 owner DM。需要 DM 可改 `index.ts` 訂閱處 fetch user 而非 channel
- 沒有 component-level TTL：unhealthy 會持續到下次成功；不會自動降級為 degraded
