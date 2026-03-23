# _CHANGELOG.md

> 知識庫變更紀錄（最新在上，超過 8 筆觸發滾動淘汰）

| 日期 | 變更 | 影響文件 |
|------|------|---------|
| 2026-03-23 | **fix(cron): exec 三修**：①Windows 用 bash（Git Bash）+Unix 用 sh ②注入 PYTHONIOENCODING/PYTHONUTF8 解 cp950 亂碼 ③失敗時回報 Discord 頻道。新增 09-PITFALLS §18§20§21 | cron.ts, 09-PITFALLS.md |
| 2026-03-23 | **feat(cron): 新增 exec action type**：排程可直接執行 shell 指令，支援 `channelId` 回報、`silent` 靜默、`timeoutSec` 可調逾時（預設 120s）。timeout 時正確辨識 `err.killed` + `err.signal`。 | cron.ts, config.ts, 02-CONFIG-REFERENCE.md, modules/cron.md |
| 2026-03-22 | **fix(restart): 雙保險機制 + watch 關閉** | slash.ts, ecosystem.config.cjs, catclaw.js, modules/pm2.md |
| 2026-03-22 | **feat: timeout 預警 + 分級 timeout** | acp.ts, config.ts, session.ts, reply.ts, discord.ts |
| 2026-03-22 | **fix(session): ACTIVE_TURNS_DIR 改用 resolveWorkspaceDir()** | session.ts, 09-PITFALLS.md |
| 2026-03-22 | **docs: _AIDocs 全面校正** | 09-PITFALLS.md, 00-OVERVIEW.md, 01-ARCHITECTURE.md, modules/session.md |
| 2026-03-22 | **feat(catclaw.js): reset-session 指令** | catclaw.js, modules/pm2.md, 04-DEPLOY.md |
| 2026-03-22 | **refactor: 環境變數化路徑設定** | config.ts, acp.ts, session.ts, cron.ts, discord.ts, ecosystem.config.cjs, CLAUDE.md, .env.example |
