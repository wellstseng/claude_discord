# modules/cron — 排程服務

> 檔案：`src/cron.ts`

## 職責

定時排程執行任務（發送訊息或呼叫 Claude），支援三種排程模式。由 `config.json` 的 `cron` 區塊設定。

## 排程模式

| Kind | 說明 | 範例 |
|------|------|------|
| `cron` | 標準 cron 表達式，可指定時區 | `"0 9 * * *"`（每天 9 點） |
| `every` | 固定間隔（毫秒） | `3600000`（每小時） |
| `at` | 一次性 ISO 時間 | `"2026-04-01T09:00:00+08:00"` |

## 動作型別

| Type | 說明 |
|------|------|
| `message` | 直接向指定頻道發送文字 |
| `claude` | 呼叫 Claude CLI，將回覆送到指定頻道 |

## 生命週期

```
startCron(client)          ← client.ready 後呼叫
  → 遍歷 config.cron.jobs
  → 為每個 enabled job 建立 croner 實例
  → croner 到點觸發 → executeJob()

stopCron()                 ← SIGINT/SIGTERM 時呼叫
  → 停止所有 croner 實例
```

## Config 格式

```json
{
  "cron": {
    "enabled": false,
    "maxConcurrentRuns": 1,
    "jobs": [
      {
        "id": "morning-greeting",
        "name": "早安問候",
        "enabled": true,
        "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Taipei" },
        "action": { "type": "message", "channelId": "...", "text": "早安！" }
      }
    ]
  }
}
```

## 與其他模組的關係

- **config.ts**：`CronConfig`、`CronJobDef`、`CronSchedule`、`CronAction` 型別定義
- **acp.ts**：claude 類型動作呼叫 `runClaudeTurn()`，傳入 job 的 `channelId`
- **config hot-reload**：`cron.enabled` 和 job 設定可即時變更

## 依賴

- `croner`（v10）：cron 表達式解析與排程
