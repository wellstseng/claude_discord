# modules/session — Session 快取 + 串行佇列 + 磁碟持久化

> 檔案：`src/session.ts`

## 職責

1. 維護 `channelId → sessionId`（UUID）的快取
2. 以 Promise chain 實作 per-channel 串行佇列
3. 磁碟持久化：sessionCache 寫入 `data/sessions.json`，重啟不遺失
4. TTL 機制：超過 `sessionTtlHours` 的 session 自動開新（不帶 `--resume`）
5. Resume 失敗處理：清除 session → 不帶 `--resume` 重試一次
6. 傳遞 `channelId` 給 `runClaudeTurn()`（注入 `CATCLAW_CHANNEL_ID` env var）
7. 對外暴露 `enqueue()` + `loadSessions()` + `getRecentChannelIds()`

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道所有人共享對話 |
| DM | `channelId`（每人唯一） | per-user session |

- 首次對話：不帶 `--resume`，claude CLI 自動建立 session
- `session_init` event → 取得 UUID → 快取 + 持久化
- 後續：`--resume <UUID>` 延續上下文
- 超過 TTL → 不帶 `--resume`，開新 session

## 型別定義

```typescript
/** enqueue 的 event 回呼 */
export type OnEvent = (event: AcpEvent) => void | Promise<void>;

/** sessions.json 內每個 channel 的資料 */
interface SessionRecord {
  sessionId: string;
  updatedAt: number;  // Unix timestamp（毫秒）；每次 turn 完成都刷新，作為 TTL 基準
}

/** sessions.json 的完整結構 */
type SessionStore = Record<string, SessionRecord>;

/** enqueue() 的選項參數 */
export interface EnqueueOptions {
  cwd: string;           // Claude session 工作目錄（spawn cwd）
  claudeCmd: string;     // claude CLI binary 路徑
  turnTimeoutMs: number; // 回應超時毫秒數，超時自動 abort
  sessionTtlMs: number;  // session 閒置超時毫秒數
}
```

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
| `session_init` 攔截 | `recordSession()` → 更新快取 + 原子寫入磁碟 |
| turn 完成後 | `recordSession()` → 刷新 `updatedAt` + 原子寫入磁碟 |

### 原子寫入

```
writeFileSync(sessions.json.tmp) → renameSync(sessions.json)
```

避免寫入中途 crash 導致 JSON 損壞。

### 過期清理

`saveSessions(ttlMs)` 寫入時順便清理超過 TTL 的 session（從記憶體 + 磁碟同時移除）。

## Resume 失敗處理

Claude CLI 本身有 session TTL，可能 catclaw 這邊未過期但 Claude 端已清除。

**觸發條件**：`hasError && existingSessionId`（兩個條件都需成立）

- `hasError`：第一個 `for await` loop 中收到 `event.type === "error"` 時設為 `true`
- `existingSessionId`：此 turn 開始時確實帶了 `--resume`（若本來就是新 session 則不重試）

```
帶 --resume 執行 → 收到 error event（hasError=true）
  ↓ 條件：hasError && existingSessionId（不是新 session 的失敗）
  → sessionCache.delete(channelId)
  → sessionUpdatedAt.delete(channelId)
  → saveSessions(ttlMs)                ← 磁碟也同步清除
  → runClaudeTurn(null, ...)           ← 不帶 --resume 重試一次
      ├─ session_init → recordSession() 記錄新 session（不轉發）
      └─ 其他 event  → await onEvent() 正常轉發給 reply handler
  （無第二次重試：重試本身若失敗，error event 照常轉發）
```

**注意**：純新 session 失敗（`existingSessionId === null`）不觸發重試，error 直接由 `onEvent` 轉發。

## Per-Channel 串行佇列

```
同一 channel：turn1 → turn2 → turn3（Promise chain 串行）
不同 channel：完全並行
```

實作：`queues: Map<channelId, Promise<void>>`

### Chain 建立流程

```typescript
// 1. 取得現有 chain 尾端（無佇列時用 Promise.resolve() 作為起點）
const tail = queues.get(channelId) ?? Promise.resolve();

// 2. 建立帶 timeout 的 AbortController（每個 turn 獨立）
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), opts.turnTimeoutMs);

// 3. 接在尾端：tail 完成後才執行本 turn
const next = tail.then(() =>
  runTurn(channelId, text, onEvent, ..., ac.signal)
    .catch((err: unknown) => {
      // rejection 在此消化，chain 不中斷
      // 超時 vs 一般錯誤分流
      const message = ac.signal.aborted
        ? `回應超時（${Math.round(opts.turnTimeoutMs / 1000)}s），已取消`
        : err instanceof Error ? err.message : String(err);
      void onEvent({ type: "error", message });
    })
    .finally(() => clearTimeout(timer))   // 正常完成也清除 timer
);

// 4. 更新 queues（後續 turn 會以此為 tail）
queues.set(channelId, next);

// 5. chain 完成後清理 Map（避免記憶體洩漏）
//    identity check：若已有新 turn 接入（queues.get !== next），不刪
next.finally(() => {
  if (queues.get(channelId) === next) queues.delete(channelId);
});
```

**關鍵設計點**：
- `enqueue()` 回傳 `void`，fire-and-forget，呼叫方不等待結果
- `.catch()` 消化 rejection → chain 永遠不會因單一 turn 失敗而中斷
- identity check（`=== next`）防止後進 turn 誤刪其他人建立的 chain entry

## Turn Timeout

- `new AbortController()` + `setTimeout(turnTimeoutMs)` → `ac.abort()`
- acp.ts 收到 signal → SIGTERM → 250ms → SIGKILL
- 超時錯誤訊息：`` 回應超時（${N}s），已取消 ``
- `.finally(() => clearTimeout(timer))` 正常完成時清除 timer

## 對外 API

### `loadSessions()`

啟動時呼叫，從 `data/sessions.json` 載入 session 快取。
檔案不存在或格式錯誤時靜默忽略（視為首次啟動）。

### `getRecentChannelIds(ttlMs): string[]`

回傳 TTL 內最近活躍的 channel ID 列表。
用於需要通知多個頻道的場景（例如重啟廣播）。

### `enqueue(channelId, text, onEvent, opts)`

將一個 turn 加入指定 channel 的串行佇列。
同一 `channelId` 的呼叫依序執行，不同 `channelId` 完全並行。

## session_init 攔截

`runTurn()` 攔截 `session_init` event → 存入 `sessionCache` + 持久化 → **不轉發**給 reply handler。
上層 reply.ts 永遠不會收到 `session_init`。

## 內部函式

| 函式 | 說明 |
|------|------|
| `getValidSessionId(channelId, ttlMs)` | 取得有效 session ID，TTL 超過時清除並回傳 null |
| `recordSession(channelId, sessionId, ttlMs)` | 更新快取 + 刷新 updatedAt + 寫入磁碟 |
| `saveSessions(ttlMs)` | 原子寫入磁碟，同時清理過期 session |
| `runTurn(...)` | 執行單一 turn，攔截 session_init，處理 resume 失敗 |
