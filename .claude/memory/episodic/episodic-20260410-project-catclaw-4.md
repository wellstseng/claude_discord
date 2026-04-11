# Session: 2026-04-10 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: agent, agentloopevent, already, bridge, bridges, bridge壞了, bridge的session都不固定, bridge的工作目錄就會被重置, catclaw, channel, channelconfig, chat
- Last-used: 2026-04-10
- Created: 2026-04-10
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-04

## 摘要

General-focused session (18 prompts). <channel source="plugin:discord:discord" chat_id="1485277764205547630" message_id="1492050675008536667" user="wellstseng" user_id="480042204346449920" ts="2026-04-10T06:36:41.883Z">
再檢查一次目前catclaw 的gi

## 知識

- [臨] 工作區域: project-catclaw (23 files)
- [臨] 修改 23 個檔案
- [臨] 引用 atoms: nodejs-ecosystem, toolchain, collab-anchor, preferences, decisions, collab-experiment, workflow-svn, workflow-rules, toolchain-ollama, workflow-icld, decisions-architecture
- [臨] catclaw 的 dist/slash.js 編譯產物曾缺少 /context 命令，需手動重啟服務才能更新 Discord slash command
- [臨] PM2 透過 signal 檔觸發 catclaw 重啟，重啟後 uptime 約 1 秒
- [臨] LLMProvider.maxContextTokens 用來取得 LLM model 的 context window 大小
- [臨] 新增 context_warning AgentLoopEvent 類型至 AgentLoopEvent
- [臨] agent-loop 需 import estimateTokens 來計算 token 使用量
- [臨] /cd 命令修改 workingDir 時，因 bridge.label('judy-cli') 與 allConfigs.label('judy') 不匹配，
- [臨] CE 策略觸發時僅記錄 log/trace，**不會在 Discord 發送通知**，但可於 agent-loop 中 yield ce_applied 事件讓
- [臨] cli-bridges.json 的 workingDir 欄位值為 /Users/wellstseng/.catclaw/workspace，但 /cd 命令
- [臨] CLI Bridge 重啟時需從 Claude CLI 的 `result` 事件（非 `session_init`）擷取 `session_id`，因 `-p
- [臨] `cli-bridges.json` 的 `channelConfig.sessionId` 需預設固定值，避免 CatClaw 重啟時新建 session
- [臨] `persistSessionId` 方法直接讀寫 `cli-bridges.json`，避免橋接模組與配置模組的環狀依賴
- [臨] sessionId 手動設值後重啟不會被覆蓋，因 persistSessionId 有判斷 if (chCfg.sessionId === sid) retur
- [臨] /session new 需調用 clearSessionId 才能清除 runtime sessionId，否則 spawnProcess 會沿用舊值
- [臨] setWorkingDir 重啟 process 時未清除 sessionId，可能導致狀態殘留
- [臨] Claude CLI 接受不存在的 UUID 當作新 session，不會報錯也不會覆寫原 JSON
- [臨] 使用手動指定的 fake-id 會導致 persistSessionId 判斷失敗，需加防呆機制避免載入錯誤歷史
- [臨] /persistSessionId 機制僅在 session ID 不同時才會觸發覆寫行為
- [臨] 检测到 'already in use' 错误时，需清除 sessionId 并重试，此逻辑应添加至 bridge.ts 的 handleCrash 函数
- [臨] CliProcess 需新增 lastStderr 属性以存储最近的 stderr 内容供 bridge.ts 检查
- [臨] spawnProcess 函数需捕获 stderr 中的 'already in use' 错误并触发重试机制
- [臨] /data/bridge.json 存储了 sessionId，需在 clearSessionId 时同步清除该文件
- [臨] handleCrash 必须同时清除 runtime 和 json 中的 sessionId 值
- [臨] PM2 watch 重启时旧 error log 会残留，需手动重启确保新代码生效
- [臨] 閱讀 13 個檔案
- [臨] 閱讀區域: project-catclaw (12), channels (1)
- [臨] 版控查詢 3 次
- [臨] 覆轍信號: same_file_3x:agent-loop.ts, same_file_3x:slash.ts, same_file_3x:bridge.ts, retry_escalation

## 關聯

- 意圖分布: general (12), build (3), debug (3)
- Referenced atoms: nodejs-ecosystem, toolchain, collab-anchor, preferences, decisions, collab-experiment, workflow-svn, workflow-rules, toolchain-ollama, workflow-icld, decisions-architecture

## 閱讀軌跡

- 讀 13 檔: src/cli-bridge (4), src/core (4), catclaw/src (3), src/providers (1), discord/inbox (1)
- 版控查詢 3 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-10 | 自動建立 episodic atom (v2.2) | session:a2d25e69 |
