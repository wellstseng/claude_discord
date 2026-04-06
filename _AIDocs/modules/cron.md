# modules/cron — 排程服務

> 檔案：`src/cron.ts`

## 職責

定時排程執行任務（發送訊息、呼叫 Claude、或執行 shell 指令），支援三種排程模式。
Job 定義 + 執行狀態統一存在 `data/cron-jobs.json`，支援 hot-reload。
`config.json` 只控制 `cron.enabled` 和 `maxConcurrentRuns`。

## 排程模式

| Kind | 說明 | 範例 |
|------|------|------|
| `cron` | 標準 cron 表達式，可指定時區 | `"0 9 * * *"`（每天 9 點） |
| `every` | 固定間隔（毫秒） | `3600000`（每小時） |
| `at` | 一次性 ISO 時間 | `"2026-04-01T09:00:00+08:00"` |

## 動作型別

| Type | 說明 | 吃 Token |
|------|------|---------|
| `message` | 直接向指定頻道發送文字（不經過 Claude） | ❌ |
| `claude` | 呼叫 Claude CLI，將回覆送到指定頻道 | ✅ |
| `exec` | 執行 shell 指令（`sh -c`），可選回報頻道 | ❌ |
| `subagent` | 透過新平台 agentLoop 執行任務，完成後通知頻道 | ✅ |

### subagent 欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `task` | string | — | 任務 prompt（必填） |
| `provider` | string | `cron.defaultProvider` | 指定 provider（alias 或 provider/model） |
| `timeoutMs` | number | `300000` | 逾時毫秒 |
| `notify` | string | — | 通知頻道（格式 `discord:ch:{channelId}`） |

subagent 使用 `_cron` 系統帳號（developer 角色），每次獨立 session，不共享歷史。

### exec 欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `command` | string | — | shell 指令 |
| `channelId` | string | — | 可選，stdout 送到頻道 |
| `silent` | boolean | `false` | `true` 時有 channelId 也不送 |
| `timeoutSec` | number | `120` | 逾時秒數，超過 SIGTERM |

## 生命週期

```
startCron(client)          ← client.ready 後呼叫
  → loadStore()            ← 讀 data/cron-jobs.json
  → initJobs()             ← 補齊狀態欄位、修正過期時間
  → watchCronJobs()        ← fs.watch() hot-reload
  → armTimer()             ← setTimeout loop 開始

onTimer()                  ← 到期觸發
  → collectRunnableJobs()  ← 找到期 job
  → worker pool            ← maxConcurrentRuns 併發限制
  → runJob()               ← execMessage/execCommand/execClaude + 更新狀態 + saveStore()
  → armTimer()             ← 重新排程

stopCron()                 ← SIGINT/SIGTERM 時呼叫
  → clearTimeout()
```

## 檔案格式

### config.json（全域開關）

```json
{
  "cron": {
    "enabled": true,
    "maxConcurrentRuns": 1
  }
}
```

### data/cron-jobs.json（job 定義 + 狀態合併）

```json
{
  "version": 1,
  "jobs": {
    "morning-greeting": {
      "name": "早安問候",
      "enabled": true,
      "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Taipei" },
      "action": { "type": "message", "channelId": "...", "text": "早安！" },
      "nextRunAtMs": 1710000000000,
      "lastRunAtMs": 1710000000000,
      "lastResult": "success",
      "retryCount": 0
    }
  }
}
```

手動編輯 cron-jobs.json 存檔即生效（hot-reload，500ms debounce）。
系統寫入時設 `selfWriting` flag 防止自己觸發 reload。

## 重試機制

失敗時指數退避，預設最多 3 次：

| 重試次數 | 等待時間 |
|---------|---------|
| 第 1 次 | 30s |
| 第 2 次 | 1 min |
| 第 3 次+ | 5 min |

超過上限：週期 job 跳到下次正常排程；一次性 job 移除。

## 併發控制

`maxConcurrentRuns` 限制同時執行的 job 數量（worker pool pattern）。

## Hot-Reload

`fs.watch()` 監聽 `data/cron-jobs.json`：
- 500ms debounce 防多次觸發
- `selfWriting` flag 過濾自己的寫入
- reload 時保留正在執行中的 job 狀態，用新的定義覆蓋

## 與其他模組的關係

- **config.ts**：`CronSchedule`、`CronAction` 型別定義；`CronConfig` 只含 `enabled` + `maxConcurrentRuns`
- **acp.ts**：claude 類型動作呼叫 `runClaudeTurn()`，傳入 job 的 `channelId`
- **child_process**：exec 類型動作用 `execFile("sh", ["-c", command])` 執行
- **config hot-reload**：`cron.enabled` 變更即時生效

## 依賴

- `croner`（v10）：cron 表達式解析與排程
