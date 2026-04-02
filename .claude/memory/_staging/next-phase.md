# Next Phase — Sprint 5（2026-04-02 後）

> 自主開發模式。本文件是接續 prompt，開新 session 時先讀這份。

## 自主開發規則（摘要）
- 每個目標：事前回報計畫 → 執行 → 事後 commit + Discord 回報
- Context 快壓縮 → 存記憶 → 更新此檔 → 開新 session
- 開新 session 前確認 autonomous-experiment-v1.md 有記錄自主開發指南
- 所有 Discord 回應走 mcp__plugin_discord_discord__reply（主頻道 1485277764205547630）
- catclaw 環境：~/.catclaw-test/，bot signal: signal/RESTART

## 背景
Sprint 3 已完成（providers mode, streaming reply, safety refactor）。
Sprint 4 已完成（Web Dashboard + 操作工具重構）。

## Sprint 4 完成紀錄（2026-04-02）

| 任務 | Commit | 說明 |
|------|--------|------|
| W1+W2+W3 | `5f300ab` | Sessions/日誌/操作多頁面（/api/sessions, /api/logs, /api/restart） |
| W4 | `cf143ad` | Config Editor CodeMirror + js-yaml YAML 輸入 |
| W5 | `1bfeb65` | Cron 管理 UI（列出/新增/刪除/觸發/toggle） |
| W6 | `1b279e0` | Subagent kill（/api/subagents/kill，cascade abort） |

## 待執行（Sprint 5 候選）

### 高優先
- Session abort：新增 `/api/sessions/:key/abort`（強制中止 SessionManager 中的 session）
- Dashboard 認證：加 basic auth 或 token，避免 localhost 外部存取
- Reload config button：熱載入 catclaw.json（不重啟），需在 discord.ts 加 hot-reload API

### 中優先
- Turn detail modal：點 Sessions 中的 turn 展開工具呼叫詳情（tool-logs/ 裡的 JSON）
- Memory 頁面：列出 ~/project/catclaw/.claude/memory/ 的 atoms，可檢視/刪除
- Workflow/cron 統計：Dashboard 加 cron job 執行歷史圖表

### 低優先
- 多環境切換：Dashboard 支援 catclaw-test 和 catclaw 兩個環境切換

## 架構說明
- dashboard.ts = 現為 ~750 行，內嵌 HTML（全部 TypeScript）
- 端點：GET /  GET /api/usage  GET /api/sessions  GET /api/status
         GET /api/logs  POST /api/restart  GET /api/subagents
         POST /api/subagents/kill  GET /api/config  POST /api/config
         GET /api/cron  POST /api/cron  POST /api/cron/delete
         POST /api/cron/trigger  POST /api/cron/toggle
- CDN 依賴：Chart.js, CodeMirror 5, js-yaml
- Port：8088

## 接續方式
開新 session 後：
1. 讀此檔確認進度
2. 讀 src/core/dashboard.ts 了解現況
3. 從「待執行」最高優先的未完成項目開始
4. 按三段式回報協議執行
