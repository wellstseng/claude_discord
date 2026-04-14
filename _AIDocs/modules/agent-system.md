# Agent System — Multi-Agent 設定與型別

> 對應原始碼：`src/core/agent-loader.ts`、`src/core/agent-registry.ts`、`src/core/agent-types.ts`、`src/core/agent-skill-loader.ts`
> 更新日期：2026-04-14

## 概觀

CatClaw 支援多 bot 部署（`--agent <id>`），每個 agent 可覆寫頂層 config。
同時定義 Typed Agent（explore / plan / build / review）供 subagent spawn 使用。

## 三個檔案職責

| 檔案 | 職責 |
|------|------|
| `agent-loader.ts` | CLI `--agent` 解析 + config 深合併 + per-agent data 路徑 + loadAgentConfig/loadAgentPrompt |
| `agent-registry.ts` | `AgentRegistry` class + `deepMerge()` 工具函式 |
| `agent-types.ts` | `AgentTypeConfig` 介面 + 預定義 `AGENT_TYPES` |
| `agent-skill-loader.ts` | Agent Skills 掃描 + frontmatter 解析 + prompt 組裝 |

## agent-loader.ts

### 核心函式

| 函式 | 說明 |
|------|------|
| `parseAgentArg(argv?)` | 解析 `--agent <id>` 或 `--agent=<id>` |
| `setBootAgent(agentId, isAdmin)` | 設定 boot agent 身份單例（index.ts 啟動時呼叫） |
| `getBootAgentId()` | 取得 boot agent ID（主體 = `"default"`） |
| `getBootIsAdmin()` | boot agent 是否為 admin |
| `getBootAgentDataDir(catclawDir?)` | 取得 boot agent 的資料目錄 |
| `resolveAgentDataDir(agentId, catclawDir?)` | 回傳 `~/.catclaw/workspace/agents/{id}/`（`CATCLAW_WORKSPACE` 未設定時 fallback 到舊 `~/.catclaw/agents/{id}/`） |
| `loadAgentBootConfig(base, agentId)` | 從 `base.agents[agentId]` 深合併，自動設定 per-agent session/vectordb 路徑 |
| `loadAgentConfig(agentId)` | 讀取 `agents/{id}/config.json`（供 spawn_subagent 使用） |
| `loadAgentPrompt(agentId)` | 讀取 `agents/{id}/CATCLAW.md`（agent 專屬 system prompt） |

### Per-agent 路徑

2026-04-14 路徑統一：歷史上曾經分 `~/.catclaw/agents/{id}/`（data）與 `workspace/agents/{id}/`（docs），已合併為單一 workspace 路徑。

```
~/.catclaw/workspace/agents/{agentId}/
  ├── CATCLAW.md       # agent 專屬行為規則（可選）
  ├── BOOTSTRAP.md     # 首次啟動儀式（可選）
  ├── BOOT.md          # 每次啟動執行（可選）
  ├── config.json      # agent 設定（provider/model/admin flag）
  ├── memory/          # agent 專屬記憶（atom + MEMORY.md + 向量）
  ├── sessions/        # session 持久化
  ├── _vectordb/       # 向量資料庫
  └── skills/          # agent 專屬 skills
```

`resolveAgentWorkspaceDir` 為 `resolveAgentDataDir` 的 alias（deprecated，向後相容保留）。

## agent-registry.ts

### deepMerge 規則

- 純值 → agent 覆寫頂層
- Object → 遞迴合併（agent 優先）
- Array → agent 完全替換（不 concat）

### AgentRegistry class

| 方法 | 說明 |
|------|------|
| `list()` | 列出所有已設定 agent ID |
| `has(agentId)` | 確認是否存在 |
| `resolve(agentId, base)` | 深合併回傳完整 config |

全域單例：`initAgentRegistry(agents: AgentsConfig)` / `getAgentRegistry()` / `resetAgentRegistry()`

## agent-types.ts

### AgentTypeConfig 介面

```ts
interface AgentTypeConfig {
  label: string;
  allowedTools: string[] | null;  // null = 不限制
  systemPrompt: string;
  modelOverride?: string;
  defaultMaxTurns: number;
  defaultTimeoutMs: number;
}
```

### 預定義 AGENT_TYPES

| Type | Label | Tools | maxTurns | timeout |
|------|-------|-------|----------|---------|
| `default` | General Purpose | 全部 | 10 | 120s |
| `coding` | Coding | read/write/edit/run/glob/grep | 15 | 180s |
| `explore` | Explore | read/glob/grep | 8 | 60s |
| `plan` | Plan | read/glob/grep | 8 | 90s |
| `build` | Build | read/write/edit/run/glob/grep | 20 | 300s |
| `review` | Review | read/glob/grep/run | 10 | 120s |

### 工具函式

| 函式 | 說明 |
|------|------|
| `getAgentType(type)` | 取得 config（fallback to default） |
| `listAgentTypes()` | 列出所有可用 types（供 tool_search / system prompt） |

## agent-skill-loader.ts

### 概觀

掃描 `~/.catclaw/workspace/agents/{id}/skills/*.md`，解析 YAML frontmatter，組裝為 system prompt 區塊。
由 `spawn-subagent.ts` 在載入 agent config 後呼叫。

### AgentSkill 介面

```ts
interface AgentSkill {
  name: string;
  description?: string;
  userInvocable?: boolean;
  body: string;       // frontmatter 以外的 prompt 內容
  filePath: string;
}
```

### 核心函式

| 函式 | 說明 |
|------|------|
| `loadAgentSkills(agentId, filter?)` | 掃描 skills/ 目錄，filter 來自 config.json skills 欄位 |
| `buildSkillsPrompt(skills)` | 組裝為 `# Agent Skills` prompt 區塊 |
| `buildSkillCreationHint(agentId)` | 產生 skill 自建提示（告知 agent 如何用 write_file 建立新 skill） |

### Skill 檔案格式

```markdown
---
name: stock-analysis
description: 專業股票技術分析
userInvocable: true
---

# 股票技術分析 Skill
...
```

### AI 自建 Skill（Sprint 5）

Agent spawn 時自動注入 `buildSkillCreationHint`，告知 agent：
- skill 檔案位置：`~/.catclaw/workspace/agents/{agentId}/skills/{name}.md`
- 格式範例（frontmatter + body）
- 用 write_file 建立，下次 spawn 自動載入

Safety guard 已允許 non-admin agent 寫入 `agents/{self}/` 整個目錄（含 skills/）。
spawn 時自動建立 `skills/` 目錄（與 `memory/` 同時）。

### 載入策略

1. 掃描 `agents/{id}/skills/*.md`
2. 若 config.json 有 `skills` 欄位 → 只載入指定名稱
3. 若 `skills` 為空/未設 → 載入全部

## config.json 範例

```json
{
  "agents": {
    "support-bot": {
      "discord": { "token": "${SUPPORT_BOT_TOKEN}" },
      "providers": { "claude-api": { "model": "claude-haiku-4-5-20251001" } }
    },
    "dev-bot": {
      "discord": { "token": "${DEV_BOT_TOKEN}" }
    }
  }
}
```

## PM2 多 bot 部署

```js
// ecosystem.config.cjs
{ name: "catclaw-support", script: "dist/index.js", args: "--agent support-bot" }
{ name: "catclaw-dev",     script: "dist/index.js", args: "--agent dev-bot" }
```
