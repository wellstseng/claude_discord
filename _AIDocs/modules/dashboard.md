# modules/dashboard — Web Dashboard + REST API

> 檔案：`src/core/dashboard.ts` (~5700 行)
> 更新日期：2026-04-21

## 職責

內建 Web Dashboard：多分頁監控面板 + REST API + 內嵌 HTML/CSS/JS（單檔）。

## 啟動

```typescript
initDashboard(port = 8088, token?: string): DashboardServer
```

在 `platform.ts` 步驟 9.8 初始化。`config.dashboard.enabled` 控制。

## 認證

Bearer token 認證（可選）：
- `config.dashboard.token` 設定 → 所有 API 需帶 `?token=xxx` 或 `Authorization: Bearer xxx`
- 未設定 → 無認證（本地開發用）

## 分頁

| 分頁 | 說明 |
|------|------|
| 概覽 | 狀態總覽、provider 狀態、uptime |
| Sessions | Session 列表 + 操作（Clear/Compact/Delete/Purge） |
| Traces | Message Lifecycle Trace 列表 + 詳情（支援 agentId 篩選、Err 欄位顯示 tool/trace 錯誤、Trace ID 雙擊複製、單筆匯出 Markdown） |
| Subagents | 子 agent 列表 + Kill（含 agentId badge） |
| Tasks | 任務管理面板 |
| Cron | 排程 job 管理 |
| Config | catclaw.json 線上編輯（含 FileWatcher 目錄監聽設定、MCP Servers 模組化設定 + env map 編輯 + 一鍵預設；內建 4 個 preset：catclaw-discord / computer-use / playwright / **unity-mcp**） |
| Memory | Atom Browser（排序/篩選/刪除）+ Recall Tester + Stats Panel |
| Pipeline | 管線設定總覽 + Embedding/Extract Model 切換 + Ollama 模型管理 + Vector Resync |
| CLI Bridge | 持久 CLI Bridge 控制台（狀態、即時日誌、turn 歷程、Console 輸入、控制按鈕、idleSuspendMs 設定） |
| Logs | PM2 日誌 tail + SSE 即時串流 |

## REST API 端點

### 核心

| 端點 | 方法 | 說明 |
|------|------|------|
| `/` | GET | Dashboard HTML |
| `/api/status` | GET | 系統狀態 |
| `/api/usage` | GET | Token 使用統計 |

### Sessions

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/sessions` | GET | Session 列表 |
| `/api/sessions/clear` | POST | 清空訊息 `{ sessionKey }` |
| `/api/sessions/delete` | POST | 刪除 session `{ sessionKey }` |
| `/api/sessions/compact` | POST | 強制 CE 壓縮 `{ sessionKey }` |
| `/api/sessions/purge-expired` | POST | 清除過期 sessions |

### Traces

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/traces` | GET | Trace 列表（`?limit=N&sessionKey=xxx`） |
| `/api/traces/:id` | GET | 單筆 trace 詳情 |
| `/api/traces/:id/export` | GET | 匯出單筆 trace 為 Markdown（Content-Disposition: attachment） |
| `/api/traces/:id/context` | GET | Context snapshot（lazy-load） |

### Inbound History

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/inbound-history` | GET | 頻道歷史 `?channelId=xxx` |
| `/api/inbound-history/clear` | POST | 清除歷史 `{ channelId }` |

### Subagents

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/subagents` | GET | 子 agent 列表 |
| `/api/subagents/kill` | POST | 終止子 agent `{ runId }` |

### Tasks

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/tasks` | GET | 任務列表 `?sessionKey=xxx` |

### Cron

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/cron` | GET | 排程 job 列表 |
| `/api/cron` | POST | 新增 job |
| `/api/cron/delete` | POST | 刪除 job |
| `/api/cron/trigger` | POST | 手動觸發 |
| `/api/cron/toggle` | POST | 啟用/停用 |

### Config

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/config` | GET | 取得設定（敏感欄位遮罩 `***`） |
| `/api/config` | POST | 更新設定（自動備份 + 敏感欄位還原 + S17 守門：拒絕寫入 `safety.enabled=false` / `safety.selfProtect=false`） |
| `/api/models-json` | GET | models.json 內容 |
| `/api/models-config` | GET/POST | models-config.json 讀寫 |

### Auth Profiles

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/auth-profiles` | GET | 憑證列表 |
| `/api/auth-profiles` | POST | 新增/更新憑證 |
| `/api/auth-profiles/clear-cooldown` | POST | 清除 cooldown |

### Codex OAuth

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/codex-oauth-start` | POST | 啟動 OAuth flow |
| `/api/codex-oauth-status` | GET | OAuth 狀態查詢 |
| `/api/codex-oauth-callback` | POST | 手動 callback |

### Trigger（遠端觸發）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/trigger` | POST | 遠端觸發 agent loop `{ channelId, prompt }` |
| `/api/trigger/:runId` | GET | 查詢觸發結果 |

### Chat

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/chat` | POST | Dashboard 內嵌對話（SSE streaming） |
| `/api/chat/history` | GET | Session 對話歷史 `?sessionKey=xxx`（過濾 tool blocks，只回傳 user/assistant 文字） |

### Agents

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/agents` | GET | 列出所有 agent（id, hasMemory, isBoot） |

### Memory

所有 Memory 端點支援 `?agent=<agentId>` 查詢參數，切換查看不同 agent 的記憶。未指定時使用啟動 agent。

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/memory/atoms` | GET | 列出所有 atom（name, confidence, confirmations, lastUsed, triggers） |
| `/api/memory/atoms/:name` | GET | 單一 atom 完整內容 |
| `/api/memory/atoms/:name` | DELETE | 刪除 atom |
| `/api/memory/recall-test` | POST | 測試 recall（skipCache），body: `{ prompt, accountId? }` |
| `/api/memory/stats` | GET | 統計：by confidence、confirmation 分布、top/bottom atoms |
| `/api/memory/vector/stats` | GET | LanceDB table count + sizes |
| `/api/memory/pipeline` | GET | 記憶管線設定（embedding/extraction/reranker + vector stats） |
| `/api/memory/pipeline` | PUT | 更新管線設定（embedding/extraction），寫入 catclaw.json |
| `/api/memory/resync` | POST | 觸發全層 vector resync |

### CLI Bridge

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/cli-bridge/list` | GET | 列出所有 bridge（label, channelId, status, sessionId） |
| `/api/cli-bridge/:label/status` | GET | 單一 bridge 狀態 |
| `/api/cli-bridge/:label/turns` | GET | Turn 歷程 `?limit=50` |
| `/api/cli-bridge/:label/logs` | GET | 近期 stdout 事件 `?limit=100` |
| `/api/cli-bridge/:label/send` | POST | Dashboard 直接送訊息 `{ text }` → 回傳 turnId |
| `/api/cli-bridge/:label/interrupt` | POST | 中斷當前 turn（SIGINT） |
| `/api/cli-bridge/:label/restart` | POST | 重啟 bridge process |
| `/api/cli-bridge/:label/resend/:turnId` | POST | 重送失敗的 turn（用原始 userInput） |
| `/api/cli-bridge/:label/stream` | GET | SSE 即時串流（init 送最近 50 筆，後續即時推送） |
| `/api/cli-bridge/:label/export` | GET | 匯出 turn 歷程為 Markdown（Content-Disposition: attachment） |
| `/api/cli-bridge/:label` | DELETE | 關閉 bridge 並從 cli-bridges.json 移除設定 |

### Logs

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/logs` | GET | PM2 日誌 tail `?lines=N` |
| `/api/logs/stream` | GET | SSE 即時日誌串流 |
| `/api/restart` | POST | PM2 重啟 |

## Web Chat

Dashboard 內嵌互動式對話介面，支援：

- Session 選擇器下拉選單（`refreshChatSessions()`）
- 切換 session 時自動載入歷史訊息（`loadChatHistory()` → `/api/chat/history`）
- SSE streaming 即時回覆
- `clearChatSession()` 清空 session 訊息（不清除 traces）

## Config 安全

- GET 時敏感欄位（token/apiKey/api_key/password/credential）遮罩為 `***`
- POST 時 `***` 自動還原為原始值（`restoreMasked`）
- 每次寫入前自動備份（保留最近 5 份 `.bak.{timestamp}`）
- Safety → Protected Paths 欄位從 `guard.ts` 匯入 `PROTECTED_WRITE_PATHS_DEFAULT`，以唯讀 hint 顯示 hardcoded 預設保護路徑（`~/.claude/`、`~/.ssh/` 等），使用者看得到但改不掉
