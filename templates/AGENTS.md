# AGENTS.md — Agent 架構與註冊表

## 架構概念

CatClaw 採用**平級多 Agent** 架構——沒有主/從之分，每個 Agent 都是獨立個體。

**載入順序：**
1. `CATCLAW.md`（全域行為規則，所有 Agent 共享）
2. `agents/{agentId}/CATCLAW.md`（Agent 專屬規則，有則載入）
3. `TOOLS.md`、`USER.md`、`BOOT.md`（共用知識）

## 已註冊 Agent

| Agent ID | 名稱 | Provider | 用途 | 專屬 CATCLAW.md |
|----------|------|----------|------|-----------------|
| `default` | 預設 Agent | claude-oauth | 通用對話、開發輔助 | ✅ |

### default

通用 Agent，載入全域規則 + 預設 agent 專屬 CATCLAW.md。
設定檔：`agents/default/CATCLAW.md`、`agents/default/config.json`、`agents/default/auth-profile.json`

## 新增 Agent

1. 建立目錄：`agents/{agentId}/`
2. （選用）建立 `CATCLAW.md` 定義身份與行為規則
3. （選用）建立 `config.json` 設定 provider、model 等
4. 在 `catclaw.json` 的 `agents` 區塊新增對應設定
5. 更新本檔 Agent 註冊表

## Agent 間協作

- Agent 之間透過 `spawn_subagent` 啟動平行任務
- Bot 對 Bot 對話上限：5 輪（詳見 `CATCLAW.md`）
