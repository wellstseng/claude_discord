# modules/session — SessionManager（`src/core/session.ts`）

> Session = 一個頻道/帳號的對話上下文（messages history + provider binding）。
> 全域唯一 session 系統，舊版 `src/session.ts` 已於 2026-04-09 移除。

## 設計要點

- Session key 格式：`{platform}:ch:{channelId}`（群組）或 `{platform}:dm:{accountId}:{channelId}`（DM）
- 持久化：atomic write（先寫 `.tmp` 再 `rename`），含 SHA-256 checksum 驗證
- TTL 清理：啟動時 `cleanExpired()` 掃描刪除過期 session
- Turn Queue：per-session FIFO 佇列，max depth 5，排隊超時自動移出
- 全域單例模式：`initSessionManager()` / `getSessionManager()`

## 型別定義

```typescript
export interface Session {
  sessionKey: string;
  accountId: string;
  channelId: string;
  providerId: string;
  messages: Message[];       // 對話歷史（provider base.ts 的 Message 型別）
  createdAt: number;         // timestamp ms
  lastActiveAt: number;
  turnCount: number;
}

export interface TurnRequest {
  sessionKey: string;
  accountId: string;
  prompt: string;
  signal?: AbortSignal;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
}
```

## SessionManager API

| 方法 | 說明 |
|------|------|
| `init()` | 初始化：建立 persistDir、清除過期、載入所有 session |
| `getOrCreate(sessionKey, accountId, channelId, providerId)` | 取得或建立 session |
| `get(sessionKey)` | 取得 session（不存在回傳 undefined） |
| `addMessages(sessionKey, messages)` | 新增訊息（user + assistant），觸發 compact + persist |
| `getHistory(sessionKey)` | 取得對話歷史 `Message[]` |
| `replaceMessages(sessionKey, messages)` | CE 壓縮後寫回精簡版 messages（備份原始至 `_ce_backups/`，保留最近 3 份） |
| `clearMessages(sessionKey)` | 清空訊息（保留 session 殼），回傳被清除數 |
| `delete(sessionKey)` | 刪除 session（記憶體 + 磁碟），觸發 `session:end` event |
| `purgeExpired()` | 批次清除過期 session（含磁碟孤兒檔案），回傳清除數 |
| `list()` | 回傳所有 session 陣列 |

## Turn Queue API

| 方法 | 說明 |
|------|------|
| `enqueueTurn(request)` | 排入 turn queue，回傳 Promise（可開始執行時 resolve）。depth >= 5 → reject |
| `dequeueTurn(sessionKey)` | 前一個 turn 完成，讓下一個開始 |
| `getQueueDepth(sessionKey)` | 取得目前佇列深度 |
| `clearQueue(sessionKey)` | 清除等待佇列（保留正在執行的 position=0），回傳被取消數 |

## Turn Queue 設計

- Max depth: 5（超過 reject `BUSY`）
- 排隊超時：`Math.max(config.turnTimeoutMs, 120s)`（取自全域 config.turnTimeoutMs），超時自動 reject `TIMEOUT`
- 第一個進入 queue 的 turn 立即 resolve（不排隊）
- `dequeueTurn()` 由 caller 在 turn 完成後主動呼叫

## 持久化

- 路徑：`{SessionConfig.persistPath}/{safe_key}.json`（一 session 一檔）
- Atomic write：`writeFileSync(tmp)` → `renameSync()`
- SHA-256 checksum 寫入 `_checksum` 欄位，載入時驗證（失敗 → 備份 `.bak` 跳過）
- 舊格式（無 `_checksum`）向下相容

## Compact 機制

`addMessages()` 時自動觸發：messages 超過 `maxHistoryTurns × 2` 時 slice 保留最近 N 輪。

## 清除行為

| 操作 | 方法 | 效果 |
|------|------|------|
| LLM tool `clear_session` | `clearMessages()` | 清空 messages + 重置 turnCount，session 殼保留 |
| Slash command `/reset-session` | `delete()` | 完整刪除 session（記憶體 + JSON 檔） |
| Dashboard Clear 按鈕 | `clearMessages()` | 同 LLM tool |
| Dashboard Delete 按鈕 | `delete()` | 同 slash command |

## Dashboard API 端點

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/sessions` | GET | 列出所有 session |
| `/api/sessions/clear` | POST | 清空指定 session 訊息（body: `{ sessionKey }`) |
| `/api/sessions/delete` | POST | 刪除指定 session（body: `{ sessionKey }`) |
| `/api/sessions/compact` | POST | 強制觸發 CE 壓縮（body: `{ sessionKey }`) |
| `/api/sessions/purge-expired` | POST | 批次清除所有過期 session |

## 工具函式

```typescript
export function makeSessionKey(channelId, accountId, isDm, platform?): string;
export function initSessionManager(cfg: SessionConfig, eventBus?): SessionManager;
export function getSessionManager(): SessionManager;
export function resetSessionManager(): void;
```

## 已移除（V1 遺留）

以下功能隨 `src/session.ts` 刪除（2026-04-09）：

- `sessionCache`（channelId → Claude CLI UUID）+ `--resume` 機制
- `data/sessions.json` 單檔持久化
- `enqueue()` → `runTurn()` → `runClaudeTurn()`（V1 ACP turn 執行引擎）
- `active-turns/` crash recovery（`markTurnActive/Done` + `scanAndCleanActiveTurns`）
