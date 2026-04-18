# CatClaw Wiki

CatClaw 是以 Discord 為介面的 AI Agent 運行平台。透過 multi-turn agent loop 驅動 LLM，讓你在 Discord 上部署自己的 AI agent。

## 目標與願景

| 階段 | 定位 | 狀態 |
| ---- | ---- | ---- |
| **Phase 1** | AI 秘書運行平台 — 訊息處理、任務追蹤、排程提醒、知識管理 | **現階段** |
| **Phase 2** | AI 辦公室 — 整合各家 AI，per-channel/session 指定模型；agent 自治開發 | 進行中 |
| **Phase 3** | 多 Agent 平台 — 多 agent 實例、角色化部署 | 規劃中 |

## 核心機制

| 頁面 | 說明 |
| ---- | ---- |
| [[Architecture]] | 整體架構、資料流、初始化流程 |
| [[Agent-Loop]] | Multi-turn 推理迴圈、tool 執行、safety 機制 |
| [[Message-Pipeline]] | 訊息處理管線：Memory Recall → Intent → Prompt Assembly |
| [[Memory-Engine]] | 三層記憶引擎：Recall / Extract / Consolidate |
| [[Context-Engine]] | Context 策略：Decay（漸進衰減+外部化）→ Compaction（結構化摘要+意圖錨點）→ Overflow Hard Stop |
| [[Provider-System]] | Multi-Provider Failover + Circuit Breaker |
| [[Tools-and-Skills]] | Tool & Skill Registry、builtin 清單 |
| [[Session-Management]] | Per-channel 佇列、持久化、TTL、crash recovery |
| [[Discord-Integration]] | 訊息過濾、串流回覆、debounce、thread、附件處理 |
| [[Accounts-and-Permissions]] | 帳號、角色、identity linking、權限閘門 |

## 快速連結

- [README](../README.md)
- [設定參考](../_AIDocs/02-CONFIG-REFERENCE.md)
