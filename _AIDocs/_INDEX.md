# claude_discord _AIDocs 知識庫索引

> 建立日期：2026-03-18 | 最近更新：2026-03-19 | 專案：discord-claude-bridge

## 專案簡介

輕量獨立的 Discord → Claude Code CLI bridge。
Discord 收訊 → claude -p stream-json → 串流回覆 Discord。
不依賴 OpenClaw，僅使用 discord.js + claude CLI。

## 文件清單

| 文件 | 主題 | 更新日期 |
|------|------|---------|
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 整體架構 + 資料流 + 模組說明 + 陷阱速查 | 2026-03-19 |
| [PLAN.md](PLAN.md) | 初始實作計畫（已完成） | 2026-03-18 |
| [_CHANGELOG.md](_CHANGELOG.md) | 知識庫變更紀錄 | 2026-03-19 |

## 架構一句話摘要

Discord 訊息 → debounce → `claude -p --output-format stream-json --resume` → diff 串流 → 2000 字分段回覆 Discord
