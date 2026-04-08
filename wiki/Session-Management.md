# Session Management

`src/core/session.ts` — Per-channel 會話管理，含佇列、持久化與 crash recovery。

## Session 模型

每個 Discord channel（或 API/cron 來源）對應一個獨立 session：

```text
Session Key 格式：{platform}:ch:{channelId}
範例：discord:ch:1234567890
```

每個 session 包含：
- 訊息歷史（`Message[]`）
- Turn 佇列（FIFO）
- 持久化檔案路徑
- TTL 時間戳

## Per-Channel Turn Queue

確保同一 channel 的訊息串行處理，避免歷史訊息交錯：

| 參數 | 值 |
| ---- | -- |
| 最大佇列深度 | 5（超過直接拒絕） |
| 單 turn 超時 | 120s（或 config `turnTimeoutMs`） |

```text
User A 發訊息 → 排入佇列 → 立即執行
User B 發訊息 → 排入佇列 → 等待 A 完成
User C 發訊息 → 排入佇列 → 等待 B 完成
```

## 持久化

### 寫入策略

- 路徑：`{persistPath}/{sessionKey}.json`
- **Atomic Write**：先寫 `.tmp` 檔，成功後 rename → 確保 crash-safe
- CE（Context Engine）壓縮後備份：`_ce_backups/{key}_{timestamp}.json`，保留最近 3 份

### 載入策略

- `SessionManager.init()` 掃描 persistDir，重新載入所有 `.json` 檔
- 訊息歷史完整保留，跨重啟不遺失

## TTL 與清理

| 機制 | 說明 |
| ---- | ---- |
| TTL | 預設 168 小時（7 天），超過自動清除 |
| `cleanExpired()` | 初始化時執行，清除過期 session |
| `purgeExpired()` | 可手動或 cron 觸發 |

## Crash Recovery

```text
1. PM2 偵測 process crash → 自動重啟
2. platform.ts initPlatform() 重新初始化所有子系統
3. SessionManager.init() 從磁碟載入 session 檔案
4. active-turns/ 目錄追蹤中斷的 turn
5. 使用者下一則訊息正常排入佇列
```

## Message Compact

手動或自動觸發的訊息裁切：

- 保留最近 N 個 turn（預設 50）
- 從訊息尾端往前保留
- 配合 Context Engine 的壓縮策略使用
