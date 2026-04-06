# skills — 內建 Skill 系統

> 更新日期：2026-04-05

## 檔案結構

```
src/skills/
  types.ts          — Skill, SkillContext, SkillResult 型別
  registry.ts       — loadBuiltinSkills(), loadPromptSkills(), matchSkill()
  builtin/          — TypeScript 執行型 skills（25 個）
  builtin-prompt/   — SKILL.md 格式 prompt-type skills（3 個）
```

## Skill 型別

```typescript
type SkillTier = "public" | "standard" | "elevated" | "admin" | "owner";

interface Skill {
  name: string;
  description: string;
  tier: SkillTier;
  trigger: string[];                          // 觸發字串（前綴匹配）

  /** 前置環境檢查（可選），失敗直接回傳錯誤 */
  preflight?(ctx: SkillContext): Promise<{ ok: boolean; reason?: string }>;

  execute(ctx: SkillContext): Promise<SkillResult>;
}
```

## SkillContext 型別

```typescript
interface SkillContext {
  /** trigger 後的剩餘文字（參數） */
  args: string;
  /** 原始 Discord 訊息物件 */
  message: Message;
  channelId: string;
  authorId: string;
  /** 平台帳號 ID（如 discord:{discordId}），平台就緒時有值 */
  accountId?: string;
  config: BridgeConfig;
}
```

## SkillResult 型別

```typescript
interface SkillResult {
  text: string;
  isError?: boolean;
}
```

## Registry

- `loadBuiltinSkills()` — 掃描 `dist/skills/builtin/*.js`，auto-import `export const skill` 或 `export const skills[]`
- `loadPromptSkills()` — 掃描 `dist/skills/builtin-prompt/**/SKILL.md`
- `matchSkill(text)` — 前綴匹配 trigger，回傳 `{ skill, args }`

## Builtin Skills（25 個）

### 單一 export（`export const skill`）

| 檔案 | name | 說明 |
|------|------|------|
| `account.ts` | account | 帳號管理 |
| `compact.ts` | compact | Session 壓縮 |
| `config-manage.ts` | config | 設定管理 |
| `configure.ts` | configure | Provider/model 設定 |
| `context.ts` | context | Context 檢視 |
| `help.ts` | help | 說明 |
| `migrate.ts` | migrate | 遷移工具 |
| `mode.ts` | mode | 模式切換 |
| `plan.ts` | plan | 計畫管理 |
| `project.ts` | project | 專案管理 |
| `register.ts` | register | 帳號註冊 |
| `restart.ts` | restart | 重啟（trigger: `重啟`、`重啟catclaw`、`重啟 catclaw`、`restart`、`restart catclaw`） |
| `session-manage.ts` | session | Session 管理 |
| `subagents.ts` | subagents | 子 agent 管理 |
| `system.ts` | system | System prompt 覆寫 |
| `think.ts` | think | Thinking 模式開關 |
| `turn-audit.ts` | turn-audit | Turn 審計 |
| `usage.ts` | usage | 用量統計 |
| `use.ts` | use | Provider 手動覆寫 |

### 多重 export（`export const skill` + `export const skills[]`）

| 檔案 | 主 skill | 額外 skills |
|------|----------|------------|
| `stop.ts` | stop | queue, rollback, clear |
| `status.ts` | status | memory |

## Prompt-Type Skills（builtin-prompt/）

以 `SKILL.md` 檔案定義，由 `loadPromptSkills()` 掃描載入。
不執行 TypeScript，而是將 SKILL.md 內容作為 prompt 注入 LLM。

| 目錄 | 說明 |
|------|------|
| `builtin-prompt/commit/SKILL.md` | /commit — Git commit prompt |
| `builtin-prompt/pr/SKILL.md` | /pr — Pull request prompt |
| `builtin-prompt/discord/SKILL.md` | /discord — Discord 相關 prompt |

## /configure skill

tier: admin | trigger: `/configure`

### 子命令

| 命令 | 說明 |
|------|------|
| `/configure` / `/configure show` | 顯示目前 provider/model 設定 |
| `/configure model <id> [--provider <id>]` | 更改指定 provider 的 model（寫入 catclaw.json，hot-reload 自動生效） |
| `/configure provider <id>` | 切換預設 provider |
| `/configure models` | 列出 pi-ai 支援的 Anthropic 模型清單 |

### 實作細節

直接讀寫 `$CATCLAW_CONFIG_DIR/catclaw.json`，config 的 hot-reload（fs.watch debounce 500ms）自動套用。
不需要重啟。

## /session skill

tier: standard | trigger: `/session`

### 子命令

| 命令 | 說明 |
|------|------|
| `/session` / `/session list` | 列出目前所有 session |
| `/session clear <key>` | 清空指定 session 的訊息（保留 session） |
| `/session compact <key>` | 強制觸發 CE 壓縮 |
| `/session purge` | 批次清除所有過期 session |
| `/session delete <key>` | 刪除指定 session |
