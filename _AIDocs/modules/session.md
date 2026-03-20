# modules/session — Session 快取 + 串行佇列 + 磁碟持久化

> 檔案：`src/session.ts`

## 職責

1. 維護 `channelId → sessionId`（UUID）的快取
2. 以 Promise chain 實作 per-channel 串行佇列
3. 磁碟持久化：sessionCache 寫入 `data/sessions.json`，重啟不遺失
4. TTL 機制：超過 `sessionTtlHours` 的 session 自動開新
5. Resume 失敗處理：清除 session → 不帶 `--resume` 重試
6. 傳遞 `channelId` 給 `runClaudeTurn()`（用於 `CATCLAW_CHANNEL_ID` env var）
7. 對外暴露 `enqueue()` + `loadSessions()` + `getRecentChannelIds()`

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道共享對話 |
| DM | `channelId`（每人唯一） | per-user session |

- 首次對話：不帶 `--resume`，claude CLI 自動建立 session
- `session_init` event → 取得 UUID → 快取 + 持久化
- 後續：`--resume <UUID>` 延續上下文
- 超過 TTL → 不帶 `--resume`，開新 session

## 磁碟持久化

### 檔案位置

`data/sessions.json`（已加入 `.gitignore`）

### 檔案格式

```json
{
  "<channelId>": {
    "sessionId": "claude-session-uuid",
    "updatedAt": 1710000000000
  }
}
```

### I/O 時機

| 事件 | 動作 |
|------|------|
| 啟動時（`loadSessions()`） | 讀檔 → 填充 `sessionCache` + `sessionUpdatedAt` |
| `session_init` 攔截 | 記錄 session + 原子寫入磁碟 |
| turn 完成後 | 更新 `updatedAt` + 原子寫入磁碟 |

### 原子寫入

`writeFileSync` 寫 `sessions.json.tmp` → `renameSync` 覆蓋 `sessions.json`
避免寫入中途 crash 導致 JSON 損壞。

### 過期清理

`saveSessions()` 寫入時順便清理超過 TTL 的 session（從記憶體 + 檔案同時移除）。

## Resume 失敗處理

Claude CLI 本身的 session 有 TTL，可能 catclaw 這邊未過期但 Claude 那邊已清除。

處理流程：
1. 帶 `--resume` 執行 → 收到 error event
2. 清除該 channel 的 session（記憶體 + 磁碟）
3. 不帶 `--resume` 重試一次（自動開新 session）
4. 新 `session_init` 正常記錄

## Per-Channel 串行佇列

```
同一 channel：turn1 → turn2 → turn3（Promise chain 串行）
不同 channel：完全並行
```

實作：`queues: Map<channelId, Promise<void>>`

- 每個新 turn `.then()` 接在上一個 Promise 尾端
- 完成後 `.finally()` 清理 Map（避免記憶體洩漏）
- 錯誤不向上傳播（`.catch()` 攔截，避免 chain 中斷）

## API

### `loadSessions()`

啟動時呼叫，從 `data/sessions.json` 載入 session 快取。
檔案不存在或格式錯誤時靜默忽略。

### `enqueue(channelId, text, onEvent, opts)`

```typescript
interface EnqueueOptions {
  cwd: string;           // Claude session 工作目錄
  claudeCmd: string;     // CLI binary 路徑
  turnTimeoutMs: number; // 回應超時毫秒數
  sessionTtlMs: number;  // session 閒置超時毫秒數
}
```

**Turn Timeout**：

- `new AbortController()` + `setTimeout(turnTimeoutMs)`
- 超時 → `ac.abort()` → acp.ts 收到 signal → SIGTERM → SIGKILL
- 超時訊息：`回應超時（Ns），已取消`
- `.finally(() => clearTimeout(timer))` 正常完成時清除 timer

## session_init 攔截

`runTurn()` 攔截 `session_init` event → 存入 `sessionCache` + 持久化 → **不轉發**給 reply handler。
上層 reply.ts 永遠不會收到 `session_init`。
