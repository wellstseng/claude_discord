---
name: catclaw-project-vision
description: catclaw 專案定位 — 獨立多人 AI 平台，一軌制 Agent Loop + HTTP API 直連 LLM
type: project
---

# catclaw 專案定位

catclaw 是 Wells 自主開發的**獨立多人 AI 平台**。

## 核心架構（2026-04-03 確認）

- **一軌制 Agent Loop**：CatClaw 自己控制所有 Tool，LLM 純思考
- **HTTP API 直連**：透過 pi-ai 的 `streamSimpleAnthropic` 連 Claude，不是 CLI spawn
- **Provider 抽象**：claude-api / ollama / openai-compat / codex-oauth，可熱切換
- **三層記憶**：全域 + 專案 + 個人（atom 記憶 + LanceDB 向量搜尋）
- **帳號權限**：5 級角色（guest→platform-owner）+ Tool Tier 物理移除

## 設計決策

- **Session 策略：per-channel**（非 per-user）— 專案知識是共享的，同頻道的人共享上下文
- **使用場景**：多人多頻道，團隊協作 + 個人秘書
- **技術棧**：discord.js + 自建 Agent Loop（TypeScript/Node.js/PM2）
- **舊 CLI 路徑**（`src/acp.ts`）僅做向下相容 / ACP runtime，非主要路徑
