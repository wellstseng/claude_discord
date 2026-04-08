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

## Crash Recovery

- PM2 監控 process 狀態
- Signal-based restart（`signal/` 目錄）
- Config hot-reload（catclaw.json 變更自動重載）
