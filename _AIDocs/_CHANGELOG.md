# _CHANGELOG.md

> 知識庫變更紀錄（最新在上，超過 8 筆觸發滾動淘汰）

| 日期 | 變更 | 影響文件 |
| 2026-04-02 | **feat(Sprint 3): provider mode + modelId + 串流回覆改進** — ①provider `mode` 欄位（oauth/token/api）②`streamingReply` 設定 ③`autoThread` per-channel ④`/system` `/use` skill ⑤model alias（claude-haiku/sonnet/opus）⑥所有 provider 公開 `modelId` 供 /status /use 顯示 ⑦error 時 edit placeholder 取代發新訊息 | providers/base.ts, claude-api.ts, ollama.ts, openai-compat.ts, codex-oauth.ts, failover-provider.ts, core/config.ts, core/reply-handler.ts, skills/builtin/status.ts, skills/builtin/use.ts, skills/builtin/system.ts, 02-CONFIG-REFERENCE.md |
| 2026-04-02 | **fix(memory): Sprint 2 記憶管線修復** — ①接線 memory-extractor.ts（turn:after→extractPerTurn→writeAtom）②補 write-gate dedup+injection 保護 ③修正 llmSelect config 預設 false（opt-in）④修正 writeAtom vector namespace mismatch（project→project/id）⑤spawn-subagent namespace 同步修正 | memory-extractor.ts(new), atom.ts, config.ts, spawn-subagent.ts, workflow/bootstrap.ts |
| 2026-04-01 | **perf(memory): recall+context 省 token** — ACT-R 排序 overflow 填充、LLM select opt-in、CE compaction 保留工具上下文、交替工具迴圈偵測 | recall.ts, context-builder.ts, agent-loop.ts, context-engine.ts, extract.ts |
| 2026-03-28 | **feat: pi-ai OAuth provider + /configure skill** — claude-api.ts 全面改用 @mariozechner/pi-ai streamSimpleAnthropic（OAuth token 自動處理）；新增 auth-profile-store.ts（credentials/state 分離，路徑 agents/default/auth-profile.json）；移除 ProviderEntry.profiles[]；新增 /configure skill（model/provider 切換 hot-reload） | claude-api.ts, auth-profile-store.ts, config.ts, discord.ts, skills/configure.ts, modules/providers.md, modules/skills.md |
|------|------|---------|
| 2026-03-27 | **feat(v4-6): cron subagent action** — CronAction 新增 subagent type（task/provider/timeoutMs/notify），CronConfig 新增 defaultAccountId/defaultProvider，cron.ts 新增 execSubagent() | cron.ts, config.ts, core/config.ts |
| 2026-03-27 | **feat(v4-5): agentLoop memoryRecall opt** — AgentLoopOpts 新增 memoryRecall，deps 新增 optional memoryEngine，步驟 3b 在 LLM call 前注入 vector search 結果到 systemPrompt | core/agent-loop.ts |
| 2026-03-23 | **fix(cron): exec 三修**：①Windows 用 bash（Git Bash）+Unix 用 sh ②注入 PYTHONIOENCODING/PYTHONUTF8 解 cp950 亂碼 ③失敗時回報 Discord 頻道。新增 09-PITFALLS §18§20§21 | cron.ts, 09-PITFALLS.md |
| 2026-03-23 | **feat(cron): 新增 exec action type**：排程可直接執行 shell 指令，支援 `channelId` 回報、`silent` 靜默、`timeoutSec` 可調逾時（預設 120s）。timeout 時正確辨識 `err.killed` + `err.signal`。 | cron.ts, config.ts, 02-CONFIG-REFERENCE.md, modules/cron.md |
| 2026-03-22 | **fix(restart): 雙保險機制 + watch 關閉** | slash.ts, ecosystem.config.cjs, catclaw.js, modules/pm2.md |
| 2026-03-22 | **feat: timeout 預警 + 分級 timeout** | acp.ts, config.ts, session.ts, reply.ts, discord.ts |
| 2026-03-22 | **fix(session): ACTIVE_TURNS_DIR 改用 resolveWorkspaceDir()** | session.ts, 09-PITFALLS.md |
| 2026-03-22 | **docs: _AIDocs 全面校正** | 09-PITFALLS.md, 00-OVERVIEW.md, 01-ARCHITECTURE.md, modules/session.md |
| 2026-03-22 | **feat(catclaw.js): reset-session 指令** | catclaw.js, modules/pm2.md, 04-DEPLOY.md |
| 2026-03-22 | **refactor: 環境變數化路徑設定** | config.ts, acp.ts, session.ts, cron.ts, discord.ts, ecosystem.config.cjs, CLAUDE.md, .env.example |
