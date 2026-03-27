# CatClaw V4 計畫書：Agent 能力強化

> 版本：V4.0（草案）
> 日期：2026-03-27
> 前置：V3 自律化 Agent 編排（platform-rebuild branch）完成

---

## V4 主題：可靠性 + 工具能力擴充

V4 目標：在 V3 子 agent 編排基礎上，強化執行可靠性（重試、failover）、提升工具表達力（llm-task、session 控制），並完善 context 防護機制。

---

## V4 功能列表

| # | 功能 | 說明 | 分類 |
|---|------|------|------|
| 1 | **重試 + backoff** | LLM 呼叫失敗重試，exponential backoff + jitter（現單次失敗即回傳 error） | 可靠性 |
| 2 | **Context overflow 三段 failover** | compact → truncate → 建議 reset（現只有 CE 壓縮，無 truncation fallback） | 可靠性 |
| 3 | **Thinking level failover** | 不支援 thinking 的 provider 自動降級，不中斷流程 | 可靠性 |
| 4 | **Tool result context guard** | per-tool 輸出大小上限，防單個超大 tool result 炸 context window | 可靠性 |
| 5 | **llm-task tool** | 單次 JSON-only LLM 呼叫，無 tools/multi-turn，適合結構化輸出子任務 | 工具能力 |
| 6 | **sessions_send 喚醒機制** | 主動向子 session 注入訊息並喚醒執行（現 steer 無喚醒） | 工具能力 |
| 7 | **session_status** | 查詢子 session 狀態（running/idle/error/turns） | 工具能力 |
| 8 | **allowNestedSpawn** | opt-in 開放子 agent 再 spawn（3 層架構） | Agent 編排 |
| 9 | **Subagent 間通訊** | 子 A 輸出直接作為子 B 輸入（pipeline 模式） | Agent 編排 |
| 10 | **Cron + subagent** | 排程自動 spawn 子 agent | Agent 編排 |
| 11 | **Subagent 結果寫入記憶** | 完成結果存入 MemoryEngine | 記憶整合 |
| 12 | **Vector search 啟用** | memory recall vectorSearch:true（Ollama 在線） | 記憶整合 |

---

## V3 Optional 功能（尚未決定是否納入 V4）

| 功能 | 說明 | 優先度 |
|------|------|--------|
| **Tool 8-layer policy pipeline** | 現有 2 層（permission gate + safety guard）擴充至按 profile/group/sandbox/depth 層層過濾 | 中 |
| **Auth profile 輪替** | 多 API key 輪替 + cooldown + failover，支援長時間高並行任務 | 中 |

---

## 前置依賴

- V3 完整實作（SUB-1 ~ SUB-6）
- platform-rebuild branch merge main（Wells 確認後執行）
