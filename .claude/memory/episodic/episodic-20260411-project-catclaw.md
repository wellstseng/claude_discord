# Session: 2026-04-11 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: .catclaw, abortturn, access, append, attachment, attachments, bridge, bridges, bridges.json, bridget, bridge不知道, catclaw
- Last-used: 2026-04-11
- Created: 2026-04-11
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-05

## 摘要

General-focused session (20 prompts). <channel source="plugin:discord:discord" chat_id="1485277764205547630" message_id="1492206898060197938" user="wellstseng" user_id="480042204346449920" ts="2026-04-10T16:57:28.361Z" attachment_count="1

## 知識

- [臨] 工作區域: project-catclaw (11 files), .catclaw-catclaw.json (2 files), .catclaw-cli-bridges.json (1 files)
- [臨] 修改 14 個檔案
- [臨] 引用 atoms: nodejs-ecosystem, toolchain, workflow-svn, workflow-rules, preferences, collab-experiment, decisions, decisions-architecture, reference-claudecode
- [臨] CLI Bridge idle timeout 預設 300 秒，位於 bridge.ts:37，用 `turnTimeoutMs` 參數控制
- [臨] `turnTimeoutMs` 應設於 `~/.catclaw/cli-bridges.json`，非 `catclaw.json`
- [臨] `cli-bridges.json` 變更會觸發 hot-reload，自動重建 bridge
- [臨] CLI 的 idle 警告觸發條件是連續 5 分鐘無事件，非 turn 開始後固定計時
- [臨] bridge.ts:514 的 guard 透過設定 turnTimeoutMs: 0 短路計時器建立流程
- [臨] abortTurn 只清除 listener 不會 clearTimeout，可能導致 orphan timer
- [臨] Claude CLI 需透過 --append-system-prompt 注入 bridge 身份資訊，內容模板含 Label/ChannelID/Worki
- [臨] Judy CLI Bridge 使用專屬 bot token，但 Discord plugin 呼叫時使用全域 Claude Code 的 bot token，
- [臨] CLI Bridge 部署脈絡需注入：Bridge Label、Discord Channel ID、Sender Mode、Session ID 等參數，來自
- [臨] bridge.ts spawn claude 時需多加 --append-system-prompt 參數，內容由 bridgeConfig + channel
- [臨] CLI Bridge 用 <cli_bridge> tag 包裝 user text，含 source/channel_id/user/ts 等 runtime
- [臨] CATCLAW_BRIDGE_LABEL 等 env var 用於部署資訊查證，搭配 ~/.catclaw/runtime/bridges/{label}.js
- [臨] system prompt 注入固定部署資訊 + 雙身份警示，搭配 per-turn tag 注入 runtime 資訊，組合防壓縮策略
- [臨] 閱讀 14 個檔案
- [臨] 閱讀區域: project-catclaw (9), channels (2), .catclaw-catclaw.json (1), .catclaw-cli-bridges.json (1), .mcp.json (1)
- [臨] 版控查詢 8 次
- [臨] 覆轍信號: same_file_3x:bridge.ts, same_file_3x:process.ts, retry_escalation

## 關聯

- 意圖分布: general (15), debug (3), build (2)
- Referenced atoms: nodejs-ecosystem, toolchain, workflow-svn, workflow-rules, preferences, collab-experiment, decisions, decisions-architecture, reference-claudecode

## 閱讀軌跡

- 讀 14 檔: src/cli-bridge (5), discord/inbox (2), wellstseng/.catclaw (2), catclaw/src (2), wellstseng/.claude (1)
- 版控查詢 8 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-11 | 自動建立 episodic atom (v2.2) | session:64b31e00 |
