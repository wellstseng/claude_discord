# modules/cron — 排程服務

> 檔案：`src/cron.ts`

## 職責

定時排程執行任務（發送訊息、呼叫 Claude、或執行 shell 指令），支援三種排程模式。
Job 定義 + 執行狀態統一存在 `data/cron-jobs.json`，支援 hot-reload。
每個 job 可帶 `agentId` 欄位做 agent 隔離（skill 建立時自動帶入當前 agent ID）。
`config.json` 控制 `cron.enabled`、`maxConcurrentRuns`、`defaultAccountId`、`defaultProvider`。

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
| `claude-acp` | 透過 ACP（Claude CLI spawn）執行 turn，將回覆送到指定頻道 | ✅ |
| `exec` | 執行 shell 指令（`sh -c`），可選回報頻道 | ❌ |
| `subagent` | 透過新平台 agentLoop 執行任務，完成後通知頻道 | ✅ |
| `cli-bridge` | 把 task 注入指定 CLI Bridge 的 stdin，由該 bridge 對應的長駐 CLI session 接手 | ✅（吃該 bridge 的 session token） |

### cli-bridge 欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `label` | string | — | Bridge label（建議；穩定） |
| `channelId` | string | — | 或用 channelId 取對應 bridge（label 與 channelId 至少要有一個） |
| `task` | string | — | 注入給 CLI 的 user message |
| `awaitResult` | boolean | `false` | `true` 才等 turn 完成；預設 fire-and-forget |
| `timeoutMs` | number | `1800000` | `awaitResult=true` 時的 timeout（30 分） |

cli-bridge 不會新建 bridge，只認已在 `~/.catclaw/cli-bridges.json` 註冊且被 `startAllBridges()` 載入的 bridge。找不到會 throw `找不到 CLI Bridge`。執行流程：取 bridge → `ensureAlive()` 確認 CLI process 還活著 → `bridge.send(task, "cron", { user: "system-cron" })`。

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
  → runJob()               ← execMessage/execCommand/execClaude/execSubagent/execCliBridge + 更新狀態 + saveStore()
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
    "maxConcurrentRuns": 1,
    "defaultAccountId": "...",
    "defaultProvider": "..."
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

> **預設關閉**（2026-04-29 起）：`config.hotReload.cron` 預設 `false`。原因：cron-jobs.json 由 `saveStore` 自寫回（更新 `nextRunAtMs` 等），即便有 `selfWriting` flag 仍偶爾撞 race。改靠 `/cron` skill / Dashboard `/api/cron` 動態 CRUD（已實作）即可。要重新開啟把 `catclaw.json` 加 `"hotReload": { "cron": true }` 即可。

## 公開 CRUD API

供 `/cron` skill 在執行期動態管理排程，不需手動編輯 cron-jobs.json。

| 函式 | 說明 |
|------|------|
| `addCronJob(entry)` | 新增排程，回傳自動產生的 ID（`name-slug + randomUUID 前 6 碼`）。自動計算 `nextRunAtMs`，寫入 store |
| `removeCronJob(id)` | 依 ID 刪除排程，回傳是否成功 |
| `listCronJobs(agentId?)` | 回傳排程列表；指定 agentId 時只回傳該 agent 的 job |
| `updateCronJob(id, patch)` | 部分更新（enabled/name/schedule/action/deleteAfterRun/maxRetries），schedule 變更時自動重算 nextRunAtMs |

`addCronJob` 接受 `CronJobEntry` 中的定義欄位（name、enabled、agentId、schedule、action、deleteAfterRun、maxRetries），不需傳入運行狀態欄位（nextRunAtMs、lastRunAtMs 等由系統自動補齊）。

## 與其他模組的關係

- **config.ts**：`CronSchedule`、`CronAction` 型別定義；`CronConfig` 含 `enabled`、`maxConcurrentRuns`、`defaultAccountId?: string`、`defaultProvider?: string`
- **skills/builtin/remind.ts**：`/cron` skill 透過 `addCronJob()`/`removeCronJob()`/`listCronJobs()`/`updateCronJob()` 動態管理排程
- **acp.ts**：claude 類型動作呼叫 `runClaudeTurn()`，傳入 job 的 `channelId`
- **child_process**：exec 類型動作透過 shell 偵測機制執行（Windows: bash→powershell→cmd, Unix: sh→bash），job 可指定 shell，未指定則自動偵測
- **config hot-reload**：`cron.enabled` 變更即時生效

## 依賴

- `croner`（v10）：cron 表達式解析與排程
