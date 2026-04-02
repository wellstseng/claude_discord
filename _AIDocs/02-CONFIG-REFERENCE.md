# catclaw 設定參考

> 根據 `config.example.json`、`cron-jobs.example.json`、`src/config.ts` 整理，2026-03-22

---

## catclaw.json 完整範例

格式：JSONC（支援 `//` 整行 + 行尾註解）。
位置：`$CATCLAW_CONFIG_DIR/catclaw.json`（預設 `~/.catclaw/catclaw.json`，已 gitignore）。

> **重構變更（2026-03-22）**：config 檔改名為 `catclaw.json`，`claude.cwd` / `claude.command` 已移除，改由環境變數控制。`turnTimeoutMs` / `sessionTtlHours` 提升至頂層。

```jsonc
// catclaw 設定檔（JSONC 格式，支援 // 註解）
{
  // ── Discord 連線與權限 ─────────────────────────────────────────
  "discord": {
    // Discord Bot Token（從 Developer Portal 取得）
    "token": "your_discord_bot_token_here",

    // DM 私訊設定
    // 注意：bot 間的 DM 永遠禁止（硬擋，防止 bot 互敲迴圈）
    "dm": {
      "enabled": true          // 是否回應 DM 私訊，預設 true
    },

    // Per-guild 權限設定
    // 未設定 guilds（空物件）時：全部頻道允許，requireMention = true
    // 設定了 guilds 但 guildId 找不到：一律 allow = false
    "guilds": {
      "123456789012345678": {   // Guild ID（Discord 開發者模式右鍵複製）

        // ── Guild 預設值（未列在 channels 中的頻道繼承這組）──
        "allow": true,           // 是否允許回應（false = 整個 guild 靜默）
        "requireMention": true,  // 是否需要 @bot 才觸發，預設 true
        "allowBot": false,       // 是否處理其他 bot 的訊息，預設 false
        "allowFrom": [],         // 白名單 user/bot ID（空陣列 = 不限制任何人）

        // ── Per-channel 覆寫（只需列出要覆寫的欄位）──
        // 繼承鏈：Thread → channels[threadId] → channels[parentId] → Guild 預設
        "channels": {
          // 情境 A：自動觸發頻道（不需 @mention）
          "111111111111111111": {
            "allow": true,
            "requireMention": false, // 覆寫：不需 mention
            "autoThread": true       // 每則訊息自動建立 Thread（對話隔離，預設 false）
            // 其餘繼承 guild 預設（allowBot/allowFrom 同 guild 設定）
          },

          // 情境 B：白名單頻道（只處理指定 bot/user，且允許 bot 訊息）
          "222222222222222222": {
            "allow": true,
            "requireMention": true,
            "allowBot": true,                        // 允許 bot 訊息
            "allowFrom": ["333333333333333333"]      // 只處理此 ID 的訊息
          },

          // 情境 C：靜默頻道（覆寫 guild allow = true）
          "444444444444444444": {
            "allow": false           // 此頻道不回應
          }
        }
      }
    }
  },

  // ── 全域設定（原 claude.* 的欄位已提升至頂層）────────────────────
  "turnTimeoutMs": 300000,       // 基礎回應超時（毫秒），預設 5 分鐘（300000）
  "turnTimeoutToolCallMs": 480000, // tool_call 延長超時（毫秒），預設 turnTimeoutMs×1.6
  "sessionTtlHours": 168,       // Session 閒置 TTL（小時），預設 7 天（168）
  "showToolCalls": "summary",   // 工具呼叫顯示模式：
                                 //   "all"     → 顯示完整工具呼叫內容
                                 //   "summary" → 只顯示 ⏳ 處理中...
                                 //   "none"    → 完全隱藏
  "showThinking": false,         // 是否顯示 Claude 推理過程（thinking block）
                                 //   true → 以 > 💭 引用格式漸進顯示
  "streamingReply": true,        // 串流即時編輯模式（預設 true）
                                 //   true → 先發 💭 占位訊息，token 到來時即時 edit
                                 //   false → 累積後分段發送（舊模式）
  "debounceMs": 500,             // 同一人多則訊息合併延遲（毫秒），預設 500
  "fileUploadThreshold": 4000,   // 回覆超過此字數時改上傳 .md 檔（0 = 停用），預設 4000
  "logLevel": "info",            // 日誌層級：debug / info / warn / error / silent

  // ── Provider 設定 ─────────────────────────────────────────────────
  // 若完全不填：有 ANTHROPIC_TOKEN 環境變數 → 自動建立 claude-oauth provider
  //            否則 → 自動建立 ollama-local provider
  "provider": "claude",          // 預設使用的 provider ID
  "providers": {
    "claude": {
      "type": "claude",          // 型別：claude / openai / openai-compat / ollama / codex-oauth
                                 //   "claude" 是 "claude-oauth" 的短名稱別名
      "mode": "oauth",           // Claude 認證模式（選填，僅 type=claude 有效）
                                 //   "oauth"  → 使用 auth-profile.json（Claude.ai OAuth）
                                 //   "token" / "api" → 使用 token 欄位（Anthropic API key）
                                 //   不填 → 自動偵測（有 auth-profile.json → oauth；否則 token）
      "model": "claude-sonnet-4-6"  // 完整 model ID 或短名稱別名：
                                    //   "claude-haiku" → "claude-haiku-4-5"
                                    //   "claude-sonnet" → "claude-sonnet-4-6"
                                    //   "claude-opus" → "claude-opus-4-6"
    },
    "ollama-local": {
      "type": "ollama",
      "host": "http://localhost:11434",
      "model": "qwen3:14b"
    }
  },
  "providerRouting": {
    "roles": { "default": "claude" }
  },

  // ── 排程（job 定義在 data/cron-jobs.json）──────────────────────
  "cron": {
    "enabled": false,            // 是否啟用排程服務，預設 false
    "maxConcurrentRuns": 1       // 同時執行的 job 數量上限，預設 1
  }
}
```

### 所有欄位預設值一覽

| 欄位 | 預設值 | 說明 |
|------|--------|------|
| `discord.dm.enabled` | `true` | DM 預設啟用 |
| `turnTimeoutMs` | `300000` | 基礎 5 分鐘（頂層，非 claude.* 下） |
| `turnTimeoutToolCallMs` | `turnTimeoutMs×1.6` | tool_call 延長（預設 8 分鐘） |
| `sessionTtlHours` | `168` | 7 天（頂層，非 claude.* 下） |
| `showToolCalls` | `"all"` | 完整顯示（config.example 預設 "summary"） |
| `showThinking` | `false` | 不顯示推理 |
| `streamingReply` | `true` | 串流即時編輯模式 |
| `debounceMs` | `500` | 0.5 秒 |
| `fileUploadThreshold` | `4000` | 4000 字 |
| `logLevel` | `"info"` | |
| `cron.enabled` | `false` | 排程預設停用 |
| `cron.maxConcurrentRuns` | `1` | 單併發 |
| guild `allow` | `false` | Guild 預設不允許 |
| guild `requireMention` | `true` | 需要 @mention |
| guild `allowBot` | `false` | 不允許 bot |
| guild `allowFrom` | `[]` | 不限制 |
| channel `autoThread` | `false` | 每則訊息建 Thread |
| provider `mode` | auto | claude 認證模式：oauth/token/api |

---

## cron-jobs.json 完整範例

位置：`data/cron-jobs.json`（執行期資料，已 gitignore）。
格式：標準 JSON（不支援 JSONC 註解）。
Hot-reload：存檔後 500ms 內自動生效，不需重啟。

```json
{
  "version": 1,
  "jobs": {
    "morning-greeting": {
      "name": "早安問候",
      "enabled": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 9 * * *",
        "tz": "Asia/Taipei"
      },
      "action": {
        "type": "message",
        "channelId": "你的頻道ID",
        "text": "早安！今天也要加油"
      }
    },

    "hourly-claude": {
      "name": "每小時 Claude 摘要",
      "enabled": false,
      "schedule": {
        "kind": "every",
        "everyMs": 3600000
      },
      "action": {
        "type": "claude",
        "channelId": "你的頻道ID",
        "prompt": "請摘要最近的工作進度"
      },
      "maxRetries": 3
    },

    "one-shot-remind": {
      "name": "指定時間一次性提醒",
      "enabled": true,
      "schedule": {
        "kind": "at",
        "at": "2026-04-01T09:00:00+08:00"
      },
      "action": {
        "type": "message",
        "channelId": "你的頻道ID",
        "text": "提醒：今天有重要會議"
      },
      "deleteAfterRun": true
    },

    "atom-sync": {
      "name": "原子記憶同步",
      "enabled": true,
      "schedule": {
        "kind": "every",
        "everyMs": 300000
      },
      "action": {
        "type": "exec",
        "command": "python _tools/atom-sync.py sync",
        "silent": true,
        "timeoutSec": 300
      }
    }
  }
}
```

### CronSchedule 三種格式

| kind | 必填欄位 | 選填 | 說明 |
|------|---------|------|------|
| `"cron"` | `expr`（cron 表達式） | `tz`（時區字串，如 `"Asia/Taipei"`） | 定期執行，標準 5-field cron |
| `"every"` | `everyMs`（毫秒） | — | 固定間隔，從啟動時起算 |
| `"at"` | `at`（ISO 8601 字串） | — | 一次性，時間到即執行 |

### CronAction 三種格式

| type | 必填欄位 | 選填欄位 | 說明 |
|------|---------|---------|------|
| `"message"` | `channelId`, `text` | — | 直接發送純文字訊息 |
| `"claude"` | `channelId`, `prompt` | — | spawn Claude turn（每次獨立 session，不 resume） |
| `"exec"` | `command` | `channelId`, `silent`, `timeoutSec` | 執行 shell 指令（`sh -c`），cwd 為 CATCLAW_WORKSPACE |

#### exec action 欄位說明

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `command` | string | — | shell 指令（透過 `sh -c` 執行） |
| `channelId` | string | — | 可選，設了會把 stdout 送到 Discord 頻道 |
| `silent` | boolean | `false` | `true` 時有 channelId 也不送訊息（只在 log） |
| `timeoutSec` | number | `120` | 逾時秒數，超過後 SIGTERM 終止 |

### CronJobEntry 所有欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `name` | string | — | 顯示名稱（log 用） |
| `enabled` | boolean | `true` | 未設定視為啟用 |
| `schedule` | CronSchedule | — | 排程設定 |
| `action` | CronAction | — | 執行動作 |
| `deleteAfterRun` | boolean | `false` | 執行後從 store 刪除（一次性 job） |
| `maxRetries` | number | `3` | 失敗重試上限 |

### 重試退避策略

| 重試次數 | 等待時間 |
|----------|---------|
| 第 1 次 | 30 秒 |
| 第 2 次 | 1 分鐘 |
| 第 3 次 | 5 分鐘 |
| 超出上限 | `kind = "at"` 刪除；其他 job 重新計算下次時間 |

---

## 環境變數說明

### 必填環境變數（路徑控制）

| 變數名 | 設定位置 | 預設值 | 說明 |
|--------|---------|--------|------|
| `CATCLAW_CONFIG_DIR` | ecosystem.config.cjs / shell | `~/.catclaw` | `catclaw.json` 所在目錄。未設定時 throw 錯誤（不猜路徑） |
| `CATCLAW_WORKSPACE` | ecosystem.config.cjs / shell | `~/.catclaw/workspace` | Claude CLI agent 工作目錄 + `data/` 存放位置。未設定時 throw 錯誤 |

### 可選環境變數

| 變數名 | 設定位置 | 預設值 | 說明 |
|--------|---------|--------|------|
| `CATCLAW_CLAUDE_BIN` | ecosystem.config.cjs / shell | `"claude"` | Claude CLI binary 路徑。未設定時依賴 PATH 中的 `claude` |
| `ACP_TRACE` | shell 或啟動腳本 | — | 設為 `1` 開啟 ACP 串流除錯 log，輸出 stdout chunk 和 stderr（前 200 字元） |
| `CATCLAW_CHANNEL_ID` | 由 `acp.ts` 自動注入 | — | Claude spawn 時帶入當前 Discord 頻道 ID，供重啟回報機制使用 |

### ecosystem.config.cjs 中的預設值

```javascript
env: {
  CATCLAW_CONFIG_DIR: process.env.CATCLAW_CONFIG_DIR || `${require('os').homedir()}/.catclaw`,
  CATCLAW_WORKSPACE: process.env.CATCLAW_WORKSPACE || `${require('os').homedir()}/.catclaw/workspace`,
}
```

> 用 `require('os').homedir()` 取代 `process.env.HOME`，避免 PM2 環境中 HOME 未定義。

### 使用方式

```bash
# 開啟 ACP 除錯模式（臨時）
ACP_TRACE=1 node dist/index.js

# 自訂路徑啟動
CATCLAW_CONFIG_DIR=/opt/catclaw CATCLAW_WORKSPACE=/opt/catclaw/workspace node catclaw.js start
```

> `CATCLAW_CHANNEL_ID` 不需手動設定，由程式自動注入到 Claude 子程序環境。

---

## Per-channel 存取規則 4 種情境

### 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

各欄位用 `??` 逐層 fallback，只有 `undefined` 才往下找（顯式設 `false` 不 fallback）。

---

### 情境一：DM 私訊

| 欄位 | 值 | 說明 |
|------|-----|------|
| `allowed` | `dm.enabled` | 由 config 控制 |
| `requireMention` | 永遠 `false` | DM 不需 mention |
| `allowBot` | 永遠 `false` | 硬擋 bot 互敲，不可覆寫 |
| `allowFrom` | 不套用 | DM 已是點對點 |

---

### 情境二：Guild 未設定（guilds 為空物件 `{}`）

- 全部頻道允許（`allowed = true`）
- `requireMention = true`（預設需要 @mention）
- `allowBot = false`、`allowFrom = []`

---

### 情境三：Guild 設定了但找不到 guildId

- `allowed = false`（一律拒絕，不看頻道）

---

### 情境四：Guild 找到，套用繼承鏈

```
allowed        = channels[channelId]?.allow
              ?? channels[parentId]?.allow
              ?? guild.allow
              ?? false

requireMention = channels[channelId]?.requireMention
              ?? channels[parentId]?.requireMention
              ?? guild.requireMention
              ?? true

allowBot       = channels[channelId]?.allowBot
              ?? channels[parentId]?.allowBot
              ?? guild.allowBot
              ?? false

allowFrom      = channels[channelId]?.allowFrom
              ?? channels[parentId]?.allowFrom
              ?? guild.allowFrom
              ?? []
```

`allowFrom` 非空時：訊息 author.id 必須在白名單內，否則拒絕。
