# CatClaw _AIDocs 知識庫索引

> 建立日期：2026-03-18 | 最近更新：2026-04-14 | 專案：catclaw

## 專案簡介

CatClaw = Codex 版 Claude Code CLI + 多人 AI 開發平台。
以 Discord 為前端，提供等同 Claude Code 的完整開發能力：multi-turn agent loop、21 builtin tools、
33 builtin skills（30 TS + 3 prompt，來自 24 個 TS 檔案）、多 provider failover、四層記憶引擎、Context Engineering、subagent 編排、
帳號/角色/權限系統、Web Dashboard + Trace 追蹤。

## 架構一句話摘要

Discord → 身份解析 → 權限閘門 → prompt-assembler → agent loop（tool 迴圈）→ provider 抽象層 → streaming → reply-handler → Discord

## 核心子系統

| 子系統 | 原始碼 | 說明 |
|--------|--------|------|
| Agent Loop | `src/core/agent-loop.ts` | 主推理迴圈：multi-turn、tool 執行、output token recovery、auto-compact |
| Platform | `src/core/platform.ts` | 子系統初始化工廠（provider / memory / tools / hooks / workflow） |
| Prompt Assembler | `src/core/prompt-assembler.ts` | 模組化 system prompt 組裝 + context-aware intent detection |
| Context Engine | `src/core/context-engine.ts` | Strategy Pattern：compaction / budget-guard / sliding-window / overflow-hard-stop |
| Message Trace | `src/core/message-trace.ts` | 7 階段訊息全鏈路追蹤 + TraceStore 持久化 |
| Message Pipeline | `src/core/message-pipeline.ts` | 統一訊息管線：Memory Recall / Intent / Assembler / Trace / Inbound / SessionMemory |
| Dashboard | `src/core/dashboard.ts` | Web dashboard + REST API + trace 視覺化 + Web Chat（跨平台 session 共用） |
| Reply Handler | `src/core/reply-handler.ts` | Streaming 回覆：分段、code fence 平衡、typing indicator |
| Session | `src/core/session.ts` | SessionManager：per-channel 串行佇列、磁碟持久化、TTL |
| Event Bus | `src/core/event-bus.ts` | 強型別事件匯流排 |
| Memory Engine | `src/memory/engine.ts` | 記憶引擎（recall + extract + consolidate） |
| Memory Recall | `src/memory/recall.ts` | global+project+account+agent recall（向量+關鍵字） |
| Memory Context | `src/memory/context-builder.ts` | ACT-R 衰減 + budget + staleness check |
| Accounts | `src/accounts/` | 帳號 + 角色 + 權限 + identity linking |
| Providers | `src/providers/` | LLM Provider 抽象：claude-api / codex-oauth / cli-claude / cli-gemini / cli-codex / ollama / openai-compat + failover + circuit-breaker |
| Tools | `src/tools/` | Tool 註冊 + 21 builtin tools（read/write/edit/glob/grep/run/web/memory/subagent/task/atom_write/atom_delete...） |
| Skills | `src/skills/` | Skill registry + 33 builtin skills（30 TS + 3 prompt） |
| Hooks | `src/hooks/` | Hook 系統：registry + runner（tool 前後觸發） |
| Safety | `src/safety/` | 安全攔截：guard + collab-conflict |
| Workflow | `src/workflow/` | 工作流引擎：rut/oscillation/fix-escalation/sync/wisdom/failure-detector |
| Cron | `src/cron.ts` | 排程服務（cron/every/at），croner 驅動 |
| MCP | `src/mcp/` | MCP client + Discord MCP server |
| Vector | `src/vector/` | Ollama embedding + LanceDB 向量搜尋 |
| Discord Entry | `src/discord.ts` | Discord Client、訊息過濾、debounce、message-pipeline 呼叫、agent-loop 啟動 |
| History | `src/history.ts` | 訊息歷史記錄（NDJSON append-only） |
| Slash Commands | `src/slash.ts` | Discord Slash Commands 管理介面（管理員直接執行，繞過 AI） |

## 文件清單

### 頂層文件

| 文件 | 主題 | 更新日期 |
|------|------|---------|
| [WIKI.md](WIKI.md) | 使用者導向綜合指南：快速入門、架構、設定、功能、部署、陷阱、模組索引 | 2026-04-07 |
| [00-OVERVIEW.md](00-OVERVIEW.md) | 架構全貌：資料流圖、模組關係、常數速查、config 欄位一覽 | 2026-03-22 |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 整體架構 + 資料流 + 專案結構（含 Sprint 1-4 新子系統） | 2026-04-05 |
| [02-CONFIG-REFERENCE.md](02-CONFIG-REFERENCE.md) | config.json + cron-jobs.json 完整範例 + 環境變數 | 2026-03-21 |
| [04-DEPLOY.md](04-DEPLOY.md) | 部署流程、PM2 管理、hot-reload、健康檢查 | 2026-03-22 |
| [08-CLAUDE-CLI.md](08-CLAUDE-CLI.md) | Claude CLI 指令格式 + stream-json event 規格（舊版，acp.ts 參考用） | 2026-03-19 |
| [09-PITFALLS.md](09-PITFALLS.md) | 21 項陷阱速查 + 錯誤訊息對照表 | 2026-03-22 |
| [PLAN.md](PLAN.md) | 初始實作計畫（已完成） | 2026-03-18 |
| [PLAN-V3.md](PLAN-V3.md) | V3 計畫書：Subagent 編排 | 2026-03-27 |
| [PLAN-V4.md](PLAN-V4.md) | V4 計畫書：Agent 能力強化 | 2026-03-27 |
| [PLAN-V5.md](PLAN-V5.md) | V5 計畫書：CatClaw = Codex 版 Claude Code CLI | 2026-04-04 |
| [_CHANGELOG.md](_CHANGELOG.md) | 知識庫變更紀錄 | rolling |

### modules/ — 模組詳細說明

| 文件 | 對應原始碼 | 主題 | 更新日期 |
|------|-----------|------|---------|
| [modules/agent-loop.md](modules/agent-loop.md) | `src/core/agent-loop.ts` | 主推理迴圈 | 2026-04-05 |
| [modules/platform.md](modules/platform.md) | `src/core/platform.ts` | 子系統初始化工廠 | 2026-04-05 |
| [modules/context-engine.md](modules/context-engine.md) | `src/core/context-engine.ts` | Context 壓縮策略 | 2026-04-05 |
| [modules/prompt-assembler.md](modules/prompt-assembler.md) | `src/core/prompt-assembler.ts` | 模組化 system prompt 組裝 | 2026-04-05 |
| [modules/dashboard.md](modules/dashboard.md) | `src/core/dashboard.ts` | Web dashboard + REST API | 2026-04-13 |
| [modules/memory-engine.md](modules/memory-engine.md) | `src/memory/` | 四層記憶引擎 + episodic + session-memory | 2026-04-13 |
| [modules/tool-registry.md](modules/tool-registry.md) | `src/tools/` | Tool 註冊 + 21 builtin tools | 2026-04-14 |
| [modules/message-trace.md](modules/message-trace.md) | `src/core/message-trace.ts` | 7 階段訊息追蹤 + TraceStore + ContextStore | 2026-04-06 |
| [modules/config.md](modules/config.md) | `src/core/config.ts` | JSON 設定載入 | 2026-04-05 |
| [modules/discord.md](modules/discord.md) | `src/discord.ts` + `src/discord/` | Discord 入口 + Bot Circuit Breaker | 2026-04-13 |
| [modules/providers.md](modules/providers.md) | `src/providers/` | LLM Provider 系統 | 2026-04-05 |
| [modules/skills.md](modules/skills.md) | `src/skills/` | Skill 系統 | 2026-04-05 |
| [modules/session.md](modules/session.md) | `src/core/session.ts` | SessionManager | 2026-04-05 |
| [modules/reply.md](modules/reply.md) | `src/core/reply-handler.ts` | Streaming 回覆 | 2026-04-05 |
| [modules/accounts.md](modules/accounts.md) | `src/accounts/` | 帳號 + 角色 + 權限 + Identity Linking | 2026-04-05 |
| [modules/event-bus.md](modules/event-bus.md) | `src/core/event-bus.ts` | 強型別事件匯流排 | 2026-04-05 |
| [modules/hooks.md](modules/hooks.md) | `src/hooks/` | Hook 系統 | 2026-04-05 |
| [modules/safety.md](modules/safety.md) | `src/safety/` | 安全攔截 | 2026-04-05 |
| [modules/workflow.md](modules/workflow.md) | `src/workflow/` | 工作流引擎 | 2026-04-05 |
| [modules/acp.md](modules/acp.md) | `src/acp.ts` | Claude CLI spawn（Legacy，僅 cron.ts 使用） | 2026-04-13 |
| [modules/permission-gate.md](modules/permission-gate.md) | `src/accounts/permission-gate.ts` | 權限閘門（Tier + allow/deny） | 2026-04-06 |
| [modules/ollama-provider.md](modules/ollama-provider.md) | `src/providers/ollama.ts` | Ollama 本地 LLM Provider | 2026-04-06 |
| [modules/vector-service.md](modules/vector-service.md) | `src/vector/` | LanceDB 向量服務 + Embedding Provider 抽象層 | 2026-04-13 |
| [modules/task-store.md](modules/task-store.md) | `src/core/task-store.ts` | 任務 CRUD + per-session | 2026-04-06 |
| [modules/task-ui.md](modules/task-ui.md) | `src/core/task-ui.ts` | Discord 任務按鈕互動 | 2026-04-06 |
| [modules/mcp-client.md](modules/mcp-client.md) | `src/mcp/client.ts` | MCP server 連線 + tool 自動註冊 | 2026-04-06 |
| [modules/message-pipeline.md](modules/message-pipeline.md) | `src/core/message-pipeline.ts` | 統一訊息管線 | 2026-04-06 |
| [modules/agent-system.md](modules/agent-system.md) | `src/core/agent-loader.ts` + `agent-registry.ts` + `agent-types.ts` | Multi-Agent 設定與型別 | 2026-04-06 |
| [modules/subagent-system.md](modules/subagent-system.md) | `src/core/subagent-registry.ts` + `subagent-discord-bridge.ts` | Subagent 編排與追蹤 | 2026-04-06 |
| [modules/exec-approval.md](modules/exec-approval.md) | `src/core/exec-approval.ts` | 執行指令 DM 確認 | 2026-04-06 |
| [modules/mode.md](modules/mode.md) | `src/core/mode.ts` | Per-channel 模式管理 | 2026-04-06 |
| [modules/rate-limiter.md](modules/rate-limiter.md) | `src/core/rate-limiter.ts` | 請求速率限制器 | 2026-04-06 |
| [modules/session-snapshot.md](modules/session-snapshot.md) | `src/core/session-snapshot.ts` | Session 快照與回退 | 2026-04-06 |
| [modules/tool-log-store.md](modules/tool-log-store.md) | `src/core/tool-log-store.ts` | Tool log 持久化 | 2026-04-06 |
| [modules/inbound-history.md](modules/inbound-history.md) | `src/discord/inbound-history.ts` | 未處理訊息記錄 | 2026-04-06 |
| [modules/cron.md](modules/cron.md) | `src/cron.ts` | 排程服務 | 2026-03-22 |
| [modules/cli-bridge.md](modules/cli-bridge.md) | `src/cli-bridge/` | CLI Bridge 持久 process 模組 | 2026-04-09 |
| [modules/index.md](modules/index.md) | `src/index.ts` | 進入點 | 2026-03-22 |
| [modules/logger.md](modules/logger.md) | `src/logger.ts` | Log 系統 | 2026-03-22 |
| [modules/pm2.md](modules/pm2.md) | `catclaw.js` | PM2 進程管理 | 2026-03-22 |

## 重啟機制

**管理員（CLI）**：`node catclaw.js restart` → `pm2 restart catclaw`
**AI（Discord）**：`/restart` → signal file → `pm2 restart` → ready 回報
