# claude_discord _AIDocs 知識庫索引

> 建立日期：2026-03-18 | 最近更新：2026-03-22 | 專案：catclaw | 知識包 v1.0 匯入

## 專案簡介

專案知識代理人 — 輕量 Discord bot，透過 Claude Code CLI 提供專案知識問答。
Discord 收訊 → claude -p stream-json → 串流回覆 Discord。
不依賴 OpenClaw，僅使用 discord.js + claude CLI。

## 文件清單

| 文件 | 主題 | 更新日期 |
|------|------|---------|
| [00-OVERVIEW.md](00-OVERVIEW.md) | 架構全貌：資料流圖、模組關係、常數速查、config 欄位一覽 | 2026-03-22 |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 整體架構 + 資料流 + 專案結構 | 2026-03-22 |
| [02-CONFIG-REFERENCE.md](02-CONFIG-REFERENCE.md) | config.json + cron-jobs.json 完整範例 + 環境變數 | 2026-03-21 |
| [04-DEPLOY.md](04-DEPLOY.md) | 部署流程、PM2 管理、hot-reload、健康檢查 | 2026-03-22 |
| [08-CLAUDE-CLI.md](08-CLAUDE-CLI.md) | Claude CLI 指令格式 + stream-json event 規格 | 2026-03-19 |
| [09-PITFALLS.md](09-PITFALLS.md) | 17 項陷阱速查 + 錯誤訊息對照表 | 2026-03-22 |
| [PLAN.md](PLAN.md) | 初始實作計畫（已完成） | 2026-03-18 |
| [_CHANGELOG.md](_CHANGELOG.md) | 知識庫變更紀錄 | 2026-03-21 |

### modules/ — 模組詳細說明

| 文件 | 對應原始碼 | 主題 |
|------|-----------|------|
| [modules/config.md](modules/config.md) | `src/config.ts` | JSON 設定載入、per-channel helper |
| [modules/acp.md](modules/acp.md) | `src/acp.ts` | Claude CLI spawn、串流 diff、AcpEvent 型別 |
| [modules/session.md](modules/session.md) | `src/session.ts` | Session 快取、磁碟持久化、TTL、per-channel 串行佇列 |
| [modules/reply.md](modules/reply.md) | `src/reply.ts` | Discord 回覆分段、code fence 平衡、typing |
| [modules/discord.md](modules/discord.md) | `src/discord.ts` | Discord Client、8步訊息過濾、debounce 3 Map | 2026-03-21 |
| [modules/logger.md](modules/logger.md) | `src/logger.ts` | Log level 控制、setLogLevel |
| [modules/index.md](modules/index.md) | `src/index.ts` | 進入點、啟動順序、優雅關閉、重啟回報 |
| [modules/cron.md](modules/cron.md) | `src/cron.ts` | 排程服務（cron/every/at）、croner 驅動 |
| [modules/pm2.md](modules/pm2.md) | `catclaw.js` + `ecosystem.config.cjs` | PM2 進程管理、signal file 重啟機制、reset-session 指令 |

## 架構一句話摘要

Discord 訊息 → debounce → displayName 前綴 → `claude -p stream-json [--resume]` → diff 串流 → 2000 字分段回覆 Discord

## 重啟機制

PM2 監聽 `signal/` 目錄。寫入 `signal/RESTART`（JSON: `{channelId, time}`）觸發重啟。
重啟後自動在觸發頻道發送 `[CatClaw] 已重啟（時間）`。
Claude CLI spawn 時帶 `CATCLAW_CHANNEL_ID` 環境變數，確保回報準確。
