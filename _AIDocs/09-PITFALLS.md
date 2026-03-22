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

## 13. fileMode + MEDIA token 並存時 buffer 未重建

**現象**：同時有 fileMode 和 MEDIA token 時，回覆文字重複或遺漏。

**原因**：切換 mode 時未清空並重建 buffer。

**解法**：切換 mode 時明確清空並重建 buffer。（2026-03-19 修正）

## 14. signal file 重啟後需傳 CATCLAW_CHANNEL_ID

**現象**：寫入 signal file 觸發重啟後，bot 無法在正確頻道回報重啟訊息。

**解法**：spawn 時透過 `CATCLAW_CHANNEL_ID` env var 傳入當前頻道 ID。（2026-03-20 修正）

## 15. cron-jobs.json selfWriting 防自觸發

**現象**：cron job 寫入 cron-jobs.json 更新 nextRunAtMs 後，fs.watch 偵測變更觸發 reload。

**解法**：`selfWriting` flag + 延遲重置，bot 自己寫入時跳過 watch callback。（2026-03-20 修正）

## 16. ACTIVE_TURNS_DIR 曾用 process.cwd() 而非 CATCLAW_WORKSPACE（已修正）

**現象**：crash recovery 掃描 active-turns/ 時找不到檔案（或掃到錯誤位置）。

**原因**：`session.ts` 中 `ACTIVE_TURNS_DIR` 的路徑基準曾是 `process.cwd()`，而 `SESSION_FILE`（sessions.json）的基準是 `resolveWorkspaceDir()`（CATCLAW_WORKSPACE），兩者位置不一致。

**已修正**：`ACTIVE_TURNS_DIR` 已改為 `join(resolveWorkspaceDir(), "data", "active-turns")`，與 `SESSION_FILE` 使用相同的 workspace 路徑基準。

## 17. config.json 殘留廢棄的 claude.cwd / claude.command 欄位

**現象**：編輯 config.json 時看到 `claude.cwd` / `claude.command` 欄位，以為仍然有效。

**原因**：重構（5173e98）後這兩個欄位已從 `RawConfig` 移除，程式碼完全忽略。但現有的 `config.json` 未同步清除，欄位依然存在。

**影響**：無功能影響。但若在 config.json 中修改 `claude.cwd`，**不會生效**。cwd 由 `CATCLAW_WORKSPACE` 環境變數控制。

**解法**：直接從 config.json 刪除 `claude.cwd` / `claude.command` 欄位即可（或繼續忽略，無實質影響）。

---

## 常見錯誤訊息對照表

| 錯誤訊息 / 現象 | 對應陷阱 | 快速解法 |
|----------------|---------|---------|
| stdout 無輸出，process hang | §1 | `stdio: ["ignore", "pipe", "pipe"]` |
| `stream-json` 格式報錯 | §2 | 加 `--verbose` flag |
| DM 收不到 messageCreate | §3 | 加 `partials: [Partials.Channel]` |
| 環境變數必填（.env 存在仍報） | §4 | dotenv import 提到最前 |
| channels 白名單設好但訊息被過濾 | §5 | 確認是頻道 ID 而非伺服器 ID |
| `Property 'send' does not exist` | §6 | 改用 `SendableChannels` |
| 回覆內容重複 | §7 | `slice(lastTextLength)` 取 delta |
| Discord API 400 reject | §8 | flush 切割 + 預留 8 字元 |
| bot 自身迴圈 | §9 | `author.bot` 最先檢查 |
| 某 turn 錯後同 channel 後續全壞 | §10 | 每 turn 加 `.catch()` |
| ready 後 channel.cache 為空 | §11 | 改用 `channels.fetch()` |
| prompt 顯示帳號名非暱稱 | §12 | 用 `displayName` |
| fileMode + MEDIA 回覆異常 | §13 | 切換 mode 時重建 buffer |
| 重啟後回報頻道不對 | §14 | 傳 `CATCLAW_CHANNEL_ID` env |
| cron 寫檔觸發自己 reload | §15 | `selfWriting` flag |
| crash recovery 掃不到 active-turns/ | §16（已修正） | 已統一使用 CATCLAW_WORKSPACE |
| 修改 claude.cwd 但不生效 | §17 | 改設 `CATCLAW_WORKSPACE` 環境變數 |
