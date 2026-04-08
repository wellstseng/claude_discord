# CatClaw Wiki

CatClaw 是一個以 Discord 為前端的多人 AI 開發平台，提供等同 Claude Code 的完整開發能力。

## 核心機制

| 頁面 | 說明 |
| ---- | ---- |
| [[Architecture]] | 整體架構、資料流、初始化流程 |
| [[Agent-Loop]] | Multi-turn 推理迴圈、tool 執行、safety 機制 |
| [[Message-Pipeline]] | 訊息處理管線：Memory Recall → Intent → Prompt Assembly |
| [[Memory-Engine]] | 三層記憶引擎：Recall / Extract / Consolidate |
| [[Context-Engine]] | Context 壓縮策略：Compaction → Budget Guard → Sliding Window → Overflow |
| [[Provider-System]] | Multi-Provider Failover + Circuit Breaker |
| [[Tools-and-Skills]] | Tool & Skill Registry、builtin 清單 |
| [[Session-Management]] | Per-channel 佇列、持久化、TTL、crash recovery |
| [[Discord-Integration]] | 訊息過濾、串流回覆、debounce、thread、附件處理 |
| [[Accounts-and-Permissions]] | 帳號、角色、identity linking、權限閘門 |

## 快速連結

- [README](../README.md)
- [設定參考](../_AIDocs/02-CONFIG-REFERENCE.md)
