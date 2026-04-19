# CLI Bridge 模組

> 原始碼：`src/cli-bridge/` | 更新：2026-04-15

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
| `discord-sender.ts` | Discord 發送抽象層：IndependentBotSender / MainBotSender + `withChannel()` proxy |
| `reply.ts` | Discord 回覆處理：streaming edit + 重試 fallback + 送達狀態追蹤 |

## 關鍵設計

- **Lazy Start + Idle Suspend** — 所有 bridge 啟動時只建立 CliBridge 物件 + Discord sender（收訊息用），**不 spawn CLI process**。第一則訊息進來時 `ensureAlive()` 觸發 process spawn（含 `--resume` sessionId）。閒置超過 `idleSuspendMs`（預設 10 分鐘）自動 `suspend()`：關 process、保留 sender，下次訊息再喚醒。`rebuildBridgeForChannel`（`/cd`、`/session new/set`）除外，仍 eager start。
- **ensureAlive() mutex** — `_ensureAliveLock` Promise mutex 防止多訊息同時觸發雙 spawn。第二個 caller await 同一個 Promise。喚醒前先 `sendTyping()` 撐住 Discord。
- **BridgeStatus: "suspended"** — 新增狀態，表示 sender 存活但 CLI process 已卸載。`idle` / `busy` = process 活；`suspended` = process 關閉等喚醒；`dead` = 啟動失敗或 shutdown。
- **Idle Scanner** — `index.ts` 背景 interval（每 30s），掃描所有 status=idle 的 bridge，`Date.now() - lastUsedAt > idleSuspendMs` 時觸發 `suspend()`。
- **`rebuildBridgeForChannel(channelId, mutator)` 原子重建** — 單一入口執行「改設定 → 預更新 `_lastConfigJson` → 寫 `cli-bridges.json` → 關舊建新」，消除 `/cd`、`/session new/set` 過去「in-place 重啟 + hot-reload 重建」雙重啟導致 bridge 實例洩漏的 race condition
- **不排隊，直送 stdin** — CLI 自己管內部 queue，CatClaw 只管送和收
- **一 channel 一 process** — CLI session 是單對話，避免 context 混亂
- **指數退避自動重啟** — 1s, 2s, 4s, 8s, 16s, 30s
- **SIGINT 中斷** — 5s 超時 → 重啟 process
- **與 Agent Loop 完全獨立** — 不共享 Provider / Session / Memory
- **日誌清理（/clear-session）** — `clearSessionId()` 除了清 sessionId，同步呼叫 `stdoutLogger.truncateStdout()` 清空 `stdout.jsonl`，並 `compactTurns(60)` 把舊 turns 的 userInput / assistantReply / toolCalls.preview 置換為 `[已合併]`（只留 turnId / 時間 / tool 名稱 / durationMs 等統計欄位），超過 60 天 TTL 的整筆移除。stdout.jsonl 純觀測 log、turns.jsonl 歷程統計，**都不注入 CLI context**（context 由 Claude CLI 端 `--resume <sessionId>` 維護）
- **Session ID 保活** — `persistSessionId()` 寫入 `cli-bridges.json`，重啟後用 `--resume` 恢復對話
- **`--resume` 取代 `--session-id`** — `--session-id` 會因 `~/.claude/projects/<cwd>/<uuid>.jsonl` 存在報 "already in use"；`--resume` 直接載入既有 session 不做此檢查
- **Hot-reload sessionId 排除** — `configSnapshotJson()` 比對設定時排除 sessionId，避免 `persistSessionId()` 觸發不必要的 bridge 重建
- **process.lastStderr** — `CliProcess` 記錄最後 stderr 輸出，供 bridge crash 偵測使用
- **圖片附件（multimodal stdin）** — `reply.ts` `extractAttachments()` 下載支援的圖片（png/jpeg/gif/webp，≤5MB）並 base64 編碼成 `StdinImageBlock[]`；`bridge.send()` 有 `imageBlocks` 時改送 `content: [{type:"text"}, {type:"image", source:{type:"base64", ...}}]` 而非純字串。避免 Claude CLI 把 Discord CDN URL 當 image URL source 傳給 Anthropic API（CDN 權限/過期會導致 "Could not process image" 400）。下載失敗或超過大小限制時降級為 URL 文字描述。
- **權限審批（D3）** — `dangerouslySkipPermissions` **預設 false**（fail-safe）。`process.ts` spawn 時走互斥分支：
  - `true` → 加 `--dangerously-skip-permissions`，**不**加 `--permission-prompt-tool`（信任模式，沿用舊行為），同時 log warn
  - `false`（預設）→ 加 `--permission-prompt-tool mcp__catclaw-bridge-discord__request_permission`，**不**加 dangerous flag
  CLI 任何權限請求（含 `ExitPlanMode` / `AskUserQuestion`）會呼叫 MCP server 的 `request_permission` tool；`discord-server.ts` 開自己的 discord.js Gateway Client（用 bridge bot token），在 `DISCORD_CHANNEL_ID`（由 process.ts 注入）顯示按鈕：`ExitPlanMode` 顯示 plan 預覽 + Approve/Reject、`AskUserQuestion` 渲染 StringSelectMenu 收集答案塞回 `updatedInput.answers`、其他 tool 顯示 `tool_name + input JSON` + Approve/Deny。60s 內無回應 → `{behavior:"deny", interrupt:true}` 中斷整個 turn。stdin close 時 `client.destroy()` 收尾

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
| control_request | `reply.ts` `handleControlRequest()` + `bridge.ts` `sendControlResponse()` | CLI 權限請求 → Discord Approve/Deny 按鈕，60s 超時自動拒絕（舊版 fallback；`dangerouslySkipPermissions=false` 時主路徑為 D3） |
| 權限審批（D3） | `mcp/discord-server.ts` `request_permission` + `process.ts` spawn 互斥分支 + `bridge.ts:517` 預設 false | Claude CLI `--permission-prompt-tool mcp__catclaw-bridge-discord__request_permission` → MCP server 啟自己的 Gateway Client → 綁定頻道顯示 Approve/Deny / Reject / SelectMenu。`ExitPlanMode` 顯示 plan、`AskUserQuestion` 渲染 select menu 把答案塞回 `updatedInput.answers`、其他 tool 顯示 JSON 預覽。60s timeout = `{behavior:"deny", interrupt:true}` |
| thinking 顯示 | `reply.ts` + `types.ts` `showThinking` | `cliBridge.showThinking: true` → thinking 以 Discord spoiler (`||..||`) 顯示 |
| 附件支援 | `reply.ts` `extractAttachments()` + `discord.ts` / `cli-bridge/index.ts` 路由 | 圖片下載後轉 base64 inline（stdin content 變 array），其他檔案仍以 URL 文字描述附加 |
| 對話歷程匯出 | `dashboard.ts` `GET /api/cli-bridge/:label/export` + UI 匯出按鈕 | 一鍵匯出 Markdown，含 user/assistant/tools |
| 中間推理文字格式化 | `reply.ts` `flushIntermediateBuffer()` + `types.ts` `showIntermediateText` | tool_call 前的中間推理文字依設定格式化：`"quote"`（引用區塊，預設）/ `"spoiler"`（摺疊）/ `"none"`（不顯示）/ `"normal"`（原樣）。quote/spoiler 模式下所有中間文字累積 edit 同一條訊息（超過 2000 字才開新訊息），最終回覆用新訊息發送 |
| 外部 bot mention 過濾 | `index.ts` `handleIndependentBotMessage()` | mention 非 CatClaw 註冊的外部 bot 時不回覆（檢查 Discord user.bot flag + allRegisteredBotIds） |
| 跨頻道 mention 回應 | `index.ts` + `discord-sender.ts` `withChannel()` + `reply.ts` `senderOverride` + `bridge.ts` `wrapWithChannelTag` | CLI Bridge bot 被 mention 時不限於綁定頻道，可在任意頻道/thread/guild 回應。`withChannel()` 建立 proxy sender 指向來源頻道；stdin channel tag 跨頻道時 `chat_id` 改為來源頻道、新增 `home_channel` 屬性標記綁定頻道、hint 提示跨頻道操作方式。MCP Discord tool 不限頻道（`DISCORD_ALLOWED_CHANNELS` 已移除），存取範圍由 bot token 的 Discord 權限決定 |
| 跨頻道上下文注入 | `index.ts` `handleIndependentBotMessage()` + `consumeBridgeInboundHistory(bridge, channelId)` | 跨頻道 mention 時消費來源頻道的 inbound history（scope=`bridge:{label}`），統一走 inbound 機制而非 Discord API fetch。消費即清除，不重複注入 |
| rate limit 保護 | `reply.ts` `editIntervalMs` + `lastEditTime` 計數器 | `cliBridge.editIntervalMs` 可設定（預設 800ms），防止 Discord API rate limit |
| 長訊息分段 | `reply.ts` `splitForDiscord()` | 串流溢出 / 最終 flush 超過 Discord 2000 字上限時自動切段（優先換行切、跨段 fence 補 open/close），避免 `.slice(0, TEXT_LIMIT)` 靜默截斷 |
| result fallback 文字 | `reply.ts` result handler | buffer 為空但 `result.text` 有值時送出該文字（常見於 permission deny 後 CLI 直接結束 turn）；`is_error` 且無文字時送 `⚠️ turn 結束（無回應文字）` |
| 上線通知 | `bridge.ts` `sendStartupNotification()` | Bridge start 完成後通知綁定頻道，附帶該 session 未完成任務摘要 |
| Dashboard 監控 | `dashboard.ts` UI + `_cbAutoRefresh` | 10s 自動刷新狀態、SSE 即時串流、匯出按鈕、刷新按鈕 |
| `/cd` 工作目錄切換 | `slash.ts` `handleCd()` + `index.ts` `rebuildBridgeForChannel()` | Slash command 切換 bridge cwd，原子重建路徑統一關舊建新，持久化到 `cli-bridges.json` |
| `/session new/set` | `slash.ts` `handleSession()` + `index.ts` `rebuildBridgeForChannel()` | 改寫 channelConfig.sessionId 後走原子重建，讓新 process 以正確的 `--resume` 啟動 |
| 獨立 bot slash commands | `index.ts` + `discord-sender.ts` `getClient()` | 獨立 bot 啟動後自動 `registerSlashCommands`，讓沒有主 bot 的伺服器也能用管理指令 |
