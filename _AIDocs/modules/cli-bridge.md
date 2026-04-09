# CLI Bridge 模組

> 原始碼：`src/cli-bridge/` | 建立：2026-04-09

## 定位

第三條訊息處理路徑，與 Agent Loop（溫蒂）並行。透過持久 `claude -p --input-format stream-json` process，讓 Claude CLI（含原子記憶系統）可經由 CatClaw Discord 介面遠端通訊。

## 檔案結構

| 檔案 | 職責 |
|------|------|
| `types.ts` | 所有共用型別：stdin/stdout 事件、設定、TurnHandle、TurnRecord |
| `process.ts` | `CliProcess` — 持久 child process 封裝（EventEmitter、stdout diff 解析） |
| `bridge.ts` | `CliBridge` — 生命週期管理（直送 stdin、自動重啟、keep-alive、中斷） |
| `stdout-log.ts` | `StdoutLogger` — JSONL 日誌 + 記憶體快取 + WebSocket hook |
| `index.ts` | 全域單例：`initCliBridges` / `getCliBridge` / `shutdownAllBridges` |
| `reply.ts` | Discord 回覆處理：streaming edit + 重試 fallback + 送達狀態追蹤 |

## 關鍵設計

- **不排隊，直送 stdin** — CLI 自己管內部 queue，CatClaw 只管送和收
- **一 channel 一 process** — CLI session 是單對話，避免 context 混亂
- **指數退避自動重啟** — 1s, 2s, 4s, 8s, 16s, 30s
- **SIGINT 中斷** — 5s 超時 → 重啟 process
- **與 Agent Loop 完全獨立** — 不共享 Provider / Session / Memory

## 整合點

- **discord.ts**：在 Subagent Thread 路由之後、Agent Loop 路由之前，動態 import `getCliBridge` 判斷
- **index.ts**：`clientReady` 時呼叫 `startAllBridges()`，shutdown 時 `shutdownAllBridges()`
- **config.ts**：`BridgeConfig.cliBridge?: CliBridgeConfig`

## 設定

`catclaw.json` 的 `cliBridge` 區塊，`channels` map 每個 channel ID 對應一個 bridge 實例。

## stdout 事件解析

沿用 `acp.ts` 的 diff 邏輯（累積文字比對取 delta），但改為 EventEmitter 模式。支援事件：`session_init` / `text_delta` / `thinking_delta` / `tool_call` / `tool_result` / `result` / `control_request` / `status`。

## 擴充方向（D 清單）

| 功能 | 說明 | 優先級 |
|------|------|--------|
| control_request 處理 | CLI 要求權限確認 → 轉為 Discord 按鈕（Approve/Deny）→ 回寫 stdin control_response | 高 |
| thinking 顯示開關 | `showThinking: boolean` 設定 → thinking_delta 以 spoiler/collapse 顯示在 Discord | 中 |
| 多 channel 測試 | 同時綁定 2+ channel，驗證各 process 獨立運作 | 中 |
| 附件支援 | Discord 附件 → 下載 → 以文字/路徑形式附加到 stdin message | 中 |
| 對話歷程匯出 | Dashboard 一鍵匯出指定 bridge 的 turns.jsonl → 可讀 Markdown | 低 |
| rate limit 保護 | Discord edit 頻率上限（目前 800ms interval 應夠，但高密度 tool_call 場景可能需調整） | 低 |
