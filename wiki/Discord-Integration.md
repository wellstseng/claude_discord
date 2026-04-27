# Discord Integration

`src/discord.ts` — Discord 訊息處理入口，含過濾、debounce、串流回覆、附件。

## 訊息處理流程

```text
Discord messageCreate
  │
  ├── 1. 過濾 bot 自身訊息
  ├── 2. Channel 權限檢查（getChannelAccess）
  │     └── Thread → Parent Channel → Guild Default（繼承鏈）
  ├── 3. 檢查 requireMention / allowBot / allowFrom
  ├── 4. Debounce（同作者 500ms 合併）
  ├── 5. Strip @mention 前綴
  ├── 6. 下載附件（圖片 base64 / 檔案暫存）
  └── 7. 排入 session.enqueueTurn()
```

## messageUpdate 處理（4-23）

使用者編輯訊息時感知並注入修正版本：

| 場景 | 處理方式 |
|------|---------|
| **Debounce 窗口內**（尚未 dispatch） | `debounceMessageIndex` Map 追蹤 `messageId → buffer 位置`，編輯時直接替換 buffer 內容，agent 拿到的是修正後版本 |
| **已 dispatch 到 agent**（CLI Bridge active） | 偵測 channel 是否有 active CLI Bridge（status=busy），透過 `bridge.send()` 注入 `[訊息編輯]` 通知，Claude Code 收到後自行調整回覆方向（利用既有插話機制中斷舊 turn） |

支援 `messageUpdate` event listener（含 partial fetch）。

## Channel 權限

三層繼承：Thread → Parent Channel → Guild Default

```jsonc
{
  "guilds": {
    "guild-id": {
      "allow": true,              // Guild 預設
      "requireMention": true,
      "channels": {
        "channel-id": {
          "allow": true,
          "requireMention": false  // 該頻道不需 mention
        }
      }
    }
  }
}
```

可設定：

| 欄位 | 說明 |
| ---- | ---- |
| `allow` | 是否允許 bot 回應 |
| `requireMention` | 是否需要 @mention 才觸發 |
| `allowBot` | 是否回應其他 bot |
| `allowFrom` | 限制可觸發的角色 |
| `autoThread` | 自動建立 thread 回覆 |

## Debounce

避免使用者快速連發多則訊息產生多個 turn：

- Key：`{channelId}:{authorId}`
- 視窗：500ms（可設定 `debounceMs`）
- 視窗內多則訊息合併為一則（文字用換行連接，圖片累加）
- 視窗結束後才發送合併後的請求

## 附件處理

| 類型 | 處理方式 |
| ---- | -------- |
| 圖片（PNG/JPEG/GIF/WebP） | 下載 → MIME 偵測 → base64 編碼 → vision block |
| 檔案 | 下載到暫存目錄 → 回傳檔案路徑供 tool 使用 |

## 串流回覆

Agent Loop 的 streaming 輸出即時回覆到 Discord：

- `text_delta` 事件 → 累積到 pending content
- 定期 update Discord message（控制頻率避免 rate limit）
- Tool call → 依 `showToolCalls` 設定顯示（off / summary / detail）
- Thinking → 依 `showThinking` 設定顯示

## 長回覆處理

Discord 訊息上限 2000 字元。超過時：

- 自動轉為 `.md` 檔案附件上傳
- 保留前段文字作為訊息內容

## Thread 支援

- `/spawn_subagent` 建立 Discord thread
- Subagent 執行結果在 thread 內回覆
- Parent agent 可透過 runId 監控 / 中止

## Bot Circuit Breaker

`bot-circuit-breaker.ts` — Bot-to-Bot 對話防呆機制。偵測同頻道 bot 互相回覆過度活躍，超過閾值暫停等人介入：

| 參數 | 預設 | 說明 |
| ---- | ---- | ---- |
| `enabled` | `true` | 預設啟用 |
| `maxRounds` | 10 輪 | 連續 bot 互動最大來回輪數 |
| `maxDurationMs` | 180,000 ms（3 分鐘）| 最大持續時間 |

開啟時超過 maxRounds 或 maxDurationMs，此 channel 的 bot-to-bot 對話自動停止，避免兩個 bot 互相觸發無限輪。設定路徑：`catclaw.json.botCircuitBreaker`。

## Discord 圖片下載與 magic bytes 偵測（4-19）

`extractAttachments()` 下載圖片附件後，**用 magic bytes 偵測真實格式**（PNG/JPEG/GIF/WebP），不信任 Discord 提供的 `contentType`。

**原因**：Discord API 常報 `image/webp` 但實際是 PNG（user 上傳壓縮過的圖），若直接用 contentType 送給 Anthropic Vision，API 回 400 reject。

## CLI Bridge 上線補處理 inbound history（4-21）

CLI Bridge `start()` 上線時除了 `sendStartupNotification`，還會 fire-and-forget 跑 `drainInboundHistoryOnStartup()`：

1. `consumeForInjection(channelId, ..., "bridge:{label}")` 拿 bridge scope 全部 entries
2. 加前綴後 `bridge.send()` 丟進 CLI 自動處理
3. 無 entries 時 noop；消費後 JSONL 自動清空避免重複處理

讓使用者離線期間累積到 inbound history 的訊息在上線時自動補處理，不需等下一則新訊息進來才被消費。

## Inbound History Store

`inbound-history.ts` — 記錄未進入 agent loop 的 Discord 訊息，提供對話脈絡。三 Bucket 處理：

- **Bucket A**（近期）→ 全量帶入
- **Bucket B**（中期）→ LLM 壓縮，受 token 上限限制
- **Bucket C**（遠期）→ 直接清除

消費後刪除（append-only JSONL 格式）。

## Pairing Code 機制

陌生人 DM bot 時，bot 回覆 6 碼配對碼，owner 透過 `/account approve <code>` 核准。配對碼 5 分鐘過期、single-use，錯誤 3 次鎖定 15 分鐘。詳見 [[Accounts-and-Permissions]]。

## Crash Recovery

- PM2 監控 process 狀態
- Signal-based restart（`signal/` 目錄）
- Config hot-reload（catclaw.json 變更自動重載）
