# _CHANGELOG.md

> 知識庫變更紀錄（最新在上，超過 8 筆觸發滾動淘汰）

| 日期 | 變更 | 影響文件 |
|------|------|---------|
| 2026-03-22 | **fix(restart): 雙保險機制 + watch 關閉**：`/restart` slash command 改為 `rmSync` 舊檔後 `writeFileSync` 新檔，再 `setTimeout 300ms` 直接 `execSync("npx pm2 restart catclaw")`，不依賴 PM2 watch。`ecosystem.config.cjs` 的 `watch` 改為 `false`，消除 double-restart 問題。`catclaw.js restart` 改為直接 `pm2 restart`（不走 signal，無通知）。新增 `start -f` 強制 delete + re-register PM2。 | slash.ts, ecosystem.config.cjs, catclaw.js, modules/pm2.md |
| 2026-03-22 | **feat: timeout 預警 + 分級 timeout**：80% timeout 時送出 `⏳ 任務仍在進行中` 提示；偵測到 tool_call 自動延長 timeout 至 `turnTimeoutToolCallMs`（預設 turnTimeoutMs×1.6）。新增 AcpEvent `timeout_warning` 型別。 | acp.ts, config.ts, session.ts, reply.ts, discord.ts |
| 2026-03-22 | **fix(session): ACTIVE_TURNS_DIR 改用 resolveWorkspaceDir()**（6192b97）：crash recovery 路徑與 SESSION_FILE 統一，不再依賴 process.cwd()。09-PITFALLS §16 標記已修正。 | session.ts, 09-PITFALLS.md |
| 2026-03-22 | **docs: _AIDocs 全面校正**：§16 bug 標記為已修正（ACTIVE_TURNS_DIR 已改用 resolveWorkspaceDir）；專案結構圖更新為雙目錄架構（catclaw/ + ~/.catclaw/）；modules/session.md 路徑說明同步 | 09-PITFALLS.md, 00-OVERVIEW.md, 01-ARCHITECTURE.md, modules/session.md |
| 2026-03-22 | **feat(catclaw.js): reset-session 指令**：新增 `node catclaw.js reset-session [channelId]`，清除指定或全部 channel 的 session（sessions.json）。讀 CATCLAW_WORKSPACE 定位路徑，fallback 到 ~/.catclaw/workspace。 | catclaw.js, modules/pm2.md, 04-DEPLOY.md |
| 2026-03-22 | **refactor: 環境變數化路徑設定**：移除 config.json 的 claude.cwd / claude.command；改由 CATCLAW_CONFIG_DIR / CATCLAW_WORKSPACE / CATCLAW_CLAUDE_BIN 三個環境變數控制。turnTimeoutMs / sessionTtlHours 提升至 BridgeConfig 頂層。acp.ts 新增 AGENTS.md system prompt 支援。CLAUDE.md 改為 @import workspace/AGENTS.md。ecosystem.config.cjs 加入 env 預設值。 | config.ts, acp.ts, session.ts, cron.ts, discord.ts, ecosystem.config.cjs, CLAUDE.md, .env.example |
| 2026-03-22 | **docs: session 錯誤處理描述同步**：配合 17bff14 修改，將「resume 失敗→清除 session→重試」更新為「錯誤時保留 session，下次繼續 --resume」 | 00-OVERVIEW.md, 01-ARCHITECTURE.md, modules/session.md, session.ts（註解） |
| 2026-03-21 | **知識包 v1.0 匯入**：新增 00-OVERVIEW（架構全貌）、02-CONFIG-REFERENCE（設定參考）、04-DEPLOY（部署指南）；09-PITFALLS 新增 3 條陷阱（§13-15）+ 錯誤訊息對照表 | 00-OVERVIEW.md, 02-CONFIG-REFERENCE.md, 04-DEPLOY.md, 09-PITFALLS.md, _INDEX.md |
| 2026-03-20 | **fix: Discord 2000 字分段溢出**：flush 時 code fence 補開/補關導致超過 2000 字，改為預留 8 字元空間。error 訊息也加截斷保護 | reply.ts |
| 2026-03-20 | **refactor: cron job 定義移至 data/cron-jobs.json**：定義+狀態合併存放、config.json 只留全域開關、fs.watch() hot-reload（編輯存檔即生效）、selfWriting 防自觸發 | cron.ts, config.ts, config.example.json, data/cron-jobs.example.json |
| 2026-03-20 | **feat: signal file 重啟機制 + 重啟回報 + 錯誤分類**：PM2 監聽 signal/ 目錄，寫入 RESTART 觸發重啟。重啟後自動在觸發頻道回報。acp.ts 錯誤訊息區分 overloaded/502/rate limit/timeout 等。spawn 時傳 CATCLAW_CHANNEL_ID env var | ecosystem.config.cjs, acp.ts, session.ts, index.ts, cron.ts |
| 2026-03-20 | **feat: cron 排程模組**：croner 驅動，支援 cron/every/at 三種模式，config.json hot-reload 支援 | cron.ts, config.ts, config.example.json, package.json |
| 2026-03-19 | feat: session 磁碟持久化 — 重啟後自動 resume、TTL 過期機制（預設 7 天）、錯誤時保留 session、原子寫入 | session.ts, config.ts, index.ts, discord.ts, config.example.json, .gitignore |
| 2026-03-19 | feat: acp log 雜訊控制（ACP_TRACE 環境變數）+ prompt 加 displayName 識別多人對話 | acp.ts, discord.ts |
