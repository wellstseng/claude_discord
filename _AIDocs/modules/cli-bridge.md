# CLI Bridge 模組

> 原始碼：`src/cli-bridge/` | 更新：2026-04-11

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

- **`rebuildBridgeForChannel(channelId, mutator)` 原子重建** — 單一入口執行「改設定 → 預更新 `_lastConfigJson` → 寫 `cli-bridges.json` → 關舊建新」，消除 `/cd`、`/session new/set` 過去「in-place 重啟 + hot-reload 重建」雙重啟導致 bridge 實例洩漏（同 botToken 雙 Discord Client、雙 CLI process、同一訊息被處理兩次）的 race condition
- **不排隊，直送 stdin** — CLI 自己管內部 queue，CatClaw 只管送和收
- **一 channel 一 process** — CLI session 是單對話，避免 context 混亂
- **指數退避自動重啟** — 1s, 2s, 4s, 8s, 16s, 30s
- **SIGINT 中斷** — 5s 超時 → 重啟 process
- **與 Agent Loop 完全獨立** — 不共享 Provider / Session / Memory
- **Session ID 保活** — `persistSessionId()` 寫入 `cli-bridges.json`，重啟後用 `--resume` 恢復對話
- **`--resume` 取代 `--session-id`** — `--session-id` 會因 `~/.claude/projects/<cwd>/<uuid>.jsonl` 存在報 "already in use"（local file check，非 server lock，無 TTL）；`--resume` 直接載入既有 session 不做此檢查
- **Hot-reload sessionId 排除** — `configSnapshotJson()` 比對設定時排除 sessionId，避免 `persistSessionId()` 觸發不必要的 bridge 重建
- **process.lastStderr** — `CliProcess` 記錄最後 stderr 輸出，供 bridge crash 偵測使用

## 整合點

- **discord.ts**：在 Subagent Thread 路由之後、Agent Loop 路由之前，動態 import `getCliBridge` 判斷
- **index.ts**：`clientReady` 時呼叫 `startAllBridges()`，shutdown 時 `shutdownAllBridges()`
- **config.ts**：`BridgeConfig.cliBridge?: CliBridgeConfig`

## 設定

`catclaw.json` 的 `cliBridge` 區塊，`channels` map 每個 channel ID 對應一個 bridge 實例。

## stdout 事件解析

沿用 `acp.ts` 的 diff 邏輯（累積文字比對取 delta），但改為 EventEmitter 模式。支援事件：`session_init` / `text_delta` / `thinking_delta` / `tool_call` / `tool_result` / `result` / `control_request` / `status`。

## 已實作擴充功能

| 功能 | 實作位置 | 說明 |
|------|---------|------|
| control_request | `reply.ts` `handleControlRequest()` + `bridge.ts` `sendControlResponse()` | CLI 權限請求 → Discord Approve/Deny 按鈕，60s 超時自動拒絕 |
| thinking 顯示 | `reply.ts` + `types.ts` `showThinking` | `cliBridge.showThinking: true` → thinking 以 Discord spoiler (`||..||`) 顯示 |
| 附件支援 | `reply.ts` `extractAttachmentText()` + `discord.ts` 路由 | Discord 附件 → 文字描述（名稱/類型/大小/URL）附加到 stdin |
| 對話歷程匯出 | `dashboard.ts` `GET /api/cli-bridge/:label/export` + UI 匯出按鈕 | 一鍵匯出 Markdown，含 user/assistant/tools |
| rate limit 保護 | `reply.ts` `editIntervalMs` + `lastEditTime` 計數器 | `cliBridge.editIntervalMs` 可設定（預設 800ms），防止 Discord API rate limit |
| Dashboard 監控 | `dashboard.ts` UI + `_cbAutoRefresh` | 10s 自動刷新狀態、SSE 即時串流、匯出按鈕、刷新按鈕 |
| `/cd` 工作目錄切換 | `slash.ts` `handleCd()` + `index.ts` `rebuildBridgeForChannel()` | Slash command 切換 bridge cwd，原子重建路徑統一關舊建新，持久化到 `cli-bridges.json` |
| `/session new/set` | `slash.ts` `handleSession()` + `index.ts` `rebuildBridgeForChannel()` | 改寫 channelConfig.sessionId 後走原子重建，讓新 process 以正確的 `--resume` 啟動 |
| 獨立 bot slash commands | `index.ts` + `discord-sender.ts` `getClient()` | 獨立 bot 啟動後自動 `registerSlashCommands`，讓沒有主 bot 的伺服器也能用管理指令 |
