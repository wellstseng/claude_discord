# modules/config — JSON 設定載入

> 檔案：`src/config.ts`

## 職責

從 `config.json` 載入設定，提供 per-channel 存取 helper + config hot-reload。
export 所有型別定義（包括 cron.ts 使用的 `CronSchedule` / `CronAction`）。

## 設定來源

- `config.json`（根目錄，已加入 `.gitignore`）
- 範本：`config.example.json`
- 格式：JSONC（支援 `//` 整行 + 行尾註解，strip 後 JSON.parse）

## 型別定義

### `BridgeConfig`（完整欄位）

| 欄位 | 型別 | 預設值 | 必填 | 說明 |
|------|------|--------|------|------|
| `discord.token` | `string` | — | ✓ | Discord Bot Token |
| `discord.dm.enabled` | `boolean` | `true` | — | 是否啟用 DM 回應 |
| `discord.guilds` | `Record<string, GuildConfig>` | `{}` | — | per-guild 設定，空物件=全部允許 |
| `claude.cwd` | `string` | `$HOME` | — | Claude CLI spawn 工作目錄（空字串 fallback `$HOME`） |
| `claude.command` | `string` | `"claude"` | — | claude CLI binary 路徑 |
| `claude.turnTimeoutMs` | `number` | `300000` | — | 回應超時毫秒（5 分鐘） |
| `claude.sessionTtlHours` | `number` | `168` | — | Session 閒置超時（7 天） |
| `showToolCalls` | `"all" \| "summary" \| "none"` | `"all"` | — | 工具呼叫顯示模式 |
| `showThinking` | `boolean` | `false` | — | 是否顯示 Claude 推理過程 |
| `debounceMs` | `number` | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | `number` | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `logLevel` | `LogLevel` | `"info"` | — | Log 層級 |
| `cron.enabled` | `boolean` | `false` | — | 是否啟用排程服務 |
| `cron.maxConcurrentRuns` | `number` | `1` | — | 同時執行的排程 job 上限 |

> `showToolCalls` 舊版支援 boolean：`true` → `"all"`，`false` → `"none"`。

> NOTE: 排程 job 定義不在 config.json，在 `data/cron-jobs.json`（參考 `cron-jobs.example.json`）。

### `GuildConfig` / `ChannelConfig`

```typescript
interface ChannelConfig {
  allow?: boolean;           // 是否允許回應此頻道
  requireMention?: boolean;  // 是否需要 @mention bot 才觸發
  allowBot?: boolean;        // 是否允許處理 bot 訊息
  allowFrom?: string[];      // 白名單 user/bot ID（空陣列 = 不限制）
}

interface GuildConfig {
  allow?: boolean;           // Guild 預設：是否允許，預設 false
  requireMention?: boolean;  // Guild 預設：是否需要 @mention，預設 true
  allowBot?: boolean;        // Guild 預設：是否處理 bot，預設 false
  allowFrom?: string[];      // Guild 預設：白名單，預設 []
  channels?: Record<string, ChannelConfig>;  // per-channel 覆寫
}
```

### Cron 共用型別（供 `cron.ts` 使用）

```typescript
export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }   // cron 表達式（如 "0 9 * * *"）
  | { kind: "every"; everyMs: number }              // 固定間隔（毫秒）
  | { kind: "at"; at: string };                     // 一次性 ISO 8601 時間

export type CronAction =
  | { type: "message"; channelId: string; text: string }    // 直接發訊息
  | { type: "claude"; channelId: string; prompt: string };  // 跑 Claude turn

export interface CronConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
}
```

### `ChannelAccess`（`getChannelAccess` 回傳值）

```typescript
export interface ChannelAccess {
  allowed: boolean;          // 是否允許回應
  requireMention: boolean;   // 是否需要 @mention bot
  allowBot: boolean;         // 是否允許處理 bot 訊息
  allowFrom: string[];       // 白名單（空陣列 = 不限制）
}
```

## Per-Channel 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

各欄位用 `??` 逐層 fallback，只有 `undefined` 才往下找（顯式設 `false` 不 fallback）。

### 存取規則四種情境

| 情境 | allowed | requireMention |
|------|---------|----------------|
| DM（guildId=null） | `dm.enabled` | 永遠 `false` |
| `guilds` 為空物件 `{}` | `true` | `true` |
| `guildId` 找不到 | `false` | `true` |
| 找到 guild → 繼承鏈查找 | 逐層 fallback | 逐層 fallback |

DM：永遠 `allowBot = false`（硬擋 bot 互敲）。

## Hot-Reload

```
watchConfig()
  → fs.watch(config.json)
  → 500ms debounce
  → reloadConfig()
      ├─ token 變更 → log.warn（需重啟，不套用）
      └─ 其他設定 → config = newConfig + setLogLevel
```

parse 失敗 → `log.warn` 維持舊設定，不 crash。

## 對外 API

### `getChannelAccess(guildId, channelId, parentId?): ChannelAccess`

查詢指定頻道的存取設定（含繼承鏈）。

```typescript
export function getChannelAccess(
  guildId: string | null,   // DM 時為 null
  channelId: string,        // Channel 或 Thread ID
  parentId?: string | null  // Thread 的父頻道 ID（非 Thread 時 null）
): ChannelAccess
```

### `export let config: BridgeConfig`

全域可替換物件（`let` 而非 `const`），hot-reload 時整個替換。

### `watchConfig(): void`

啟動 config.json 監聽，變動時自動重載（500ms debounce）。
