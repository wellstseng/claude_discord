# 09 — 陷阱速查

> 開發與維護時容易踩到的坑，全部從實際除錯經驗總結。

## 1. stdin 必須 "ignore"

**現象**：spawn claude 後 stdout 完全無輸出，process 不結束。

**原因**：stdio stdin 設為 `"pipe"` 但未關閉，claude 等待 stdin 完成。

**解法**：`stdio: ["ignore", "pipe", "pipe"]`，prompt 透過 positional arg 傳入。

## 2. stream-json 必須搭配 --verbose

**現象**：`claude -p --output-format stream-json` 直接報錯。

**解法**：加上 `--verbose` flag。

## 3. DM 必須加 Partials.Channel

**現象**：bot 在 DM 中收不到 `messageCreate` 事件。

**原因**：discord.js 對 DM channel 預設不快取，需要 `Partials.Channel` 才會觸發事件。

**解法**：`partials: [Partials.Channel]`

## 4. dotenv 載入順序

**現象**：啟動時 `DISCORD_BOT_TOKEN 環境變數必填` 錯誤。

**原因**：`import { config }` 在 module evaluation 時就執行 `loadConfig()`，若 dotenv 尚未載入則 `process.env` 為空。

**解法**：`import "dotenv/config"` 必須在 `import { config }` 之前。

## 5. ALLOWED_CHANNEL_IDS 是頻道 ID 不是伺服器 ID

**現象**：訊息被白名單過濾，但以為已設定正確。

**原因**：誤填 Guild（伺服器）ID 而非 Channel ID。

**解法**：右鍵頻道 → 複製頻道 ID（非伺服器 ID）。

## 6. TextBasedChannel 的 TS 型別陷阱

**現象**：`Property 'send' does not exist on type 'TextBasedChannel'`

**原因**：`TextBasedChannel` 聯集包含 `PartialGroupDMChannel`，該型別沒有 `send()` 方法。

**解法**：使用 `SendableChannels` 型別替代。

## 7. assistant event 是累積文字不是 delta

**現象**：回覆內容重複（把累積文字當作 delta 直接使用）。

**原因**：`--include-partial-messages` 的 assistant event `text` 包含從頭到目前的完整文字。

**解法**：diff `lastTextLength`，`fullText.slice(lastTextLength)` 提取新增部分。

## 8. Discord 訊息 2000 字上限

**現象**：長回覆直接被 Discord API reject。

**解法**：buffer → `flush()` 在 2000 字時切割，跨 chunk 處理 code fence 平衡。

## 9. bot 訊息必須最先過濾

**現象**：bot 的回覆觸發自身的 debounce，累積到容量。

**解法**：`message.author.bot` 檢查必須在 debounce 之前。

## 10. Promise chain 錯誤不可向上傳播

**現象**：某個 turn 出錯後，同 channel 後續 turn 全部失敗。

**原因**：Promise chain 中某個 Promise reject 後，整條 chain 中斷。

**解法**：`.catch()` 攔截每個 turn 的錯誤，轉為 `error` event 回報，不讓 rejection 傳播。

## 11. `ready` 事件中頻道 cache 未填充

**現象**：`ready` 事件中用 `client.channels.cache.get(channelId)` 取得 `undefined`，重啟通知無法送出。

**原因**：`ready` 觸發時 discord.js 的 channel cache 可能尚未完全填充，只有 bot 曾互動過的頻道才會在 cache 中。

**解法**：改用 `client.channels.fetch(channelId)`，直接向 Discord API 查詢，不依賴 cache。

```typescript
// ✗ 不可靠
const ch = client.channels.cache.get(channelId);

// ✓ 正確
const ch = await client.channels.fetch(channelId);
```

## 12. `displayName` vs `username`

**現象**：prompt 顯示帳號名（英文 handle）而非使用者在伺服器設定的暱稱。

**原因**：`message.author.username` 是帳號名；`message.author.displayName` 才是伺服器暱稱。

**解法**：prompt 前綴使用 `firstMessage.author.displayName`（在 discord.ts debounce callback 中）。
