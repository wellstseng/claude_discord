# claude_discord — 專案指引

## 專案簡介

輕量 Discord → Claude CLI bridge。
不依賴 OpenClaw，使用 discord.js + Claude Code CLI（`claude -p --output-format stream-json`）。
設定檔：`config.json`（參考 `config.example.json`，已 gitignore）。

## 知識庫

開工前先讀 `_AIDocs/_INDEX.md`，架構細節在 `_AIDocs/01-ARCHITECTURE.md`。

## 重啟機制

你正在透過 CatClaw Discord bot 運行。重啟方式：

1. 編譯：`npx tsc`
2. 寫入 signal file 觸發 PM2 重啟：
   ```bash
   echo '{"channelId":"'$CATCLAW_CHANNEL_ID'","time":"'$(date -Iseconds)'"}' > signal/RESTART
   ```
3. PM2 偵測到 `signal/` 目錄變更 → 自動重啟
4. 重啟後 CatClaw 會在觸發頻道回報 `[CatClaw] 已重啟（時間）`

- `CATCLAW_CHANNEL_ID` 環境變數 = 當前 Discord 頻道 ID
- **先編譯、確認使用者同意後再觸發重啟**，不要未經確認就寫 signal file
- 詳細流程見 `_AIDocs/modules/pm2.md`

## 排程管理

排程 job 定義在 `data/cron-jobs.json`（格式見 `cron-jobs.example.json`）。
編輯存檔即生效（hot-reload），不需重啟。
`config.json` 的 `cron.enabled` 控制排程開關。

## Bot 對話規則（重要）

你可能會在 Discord 頻道裡與其他 bot（例如溫蒂）對話。請遵守以下規則：

1. **輪數上限：5 輪**
   - 與同一個 bot 來回對話，合計超過 5 輪就要停下來
   - 誰先到 5 輪，誰先停
2. **停下後 tag 課長**
   - 停止後 tag `<@480042204346449920>`（wellstseng），說明目前對話狀況，等待指示
3. **防無限循環**
   - 不要等對方先停，自己計數，到了就主動喊停

## 程式碼規範

### 註解要求（強制）

**所有生成的程式碼必須附帶完整註解：**

1. **檔頭必須包含：**
   ```typescript
   /**
    * @file <filename>
    * @description <這個檔案的用途與功能說明>
    *
    * <詳細說明：這個模組負責什麼、與其他模組的關係>
    */
   ```

2. **函式／方法必須有 JSDoc：**
   ```typescript
   /**
    * <函式說明>
    * @param <name> <說明>
    * @returns <說明>
    */
   ```

3. **複雜邏輯區塊必須有行內說明：**
   - 條件判斷的業務邏輯（為什麼這樣判斷）
   - 非直覺的數字常數（為什麼是這個值）
   - 非同步流程控制（例如 Promise chain 串行的原因）

4. **陷阱或邊界條件旁標記 `// NOTE:`：**
   ```typescript
   // NOTE: DM 必須加 Partials.Channel，否則 discord.js 不會觸發 DM 事件
   ```

### 語言

- 程式碼：TypeScript（ESM）
- 註解語言：中文（技術術語可英文）
- 變數/函式命名：英文 camelCase

### 其他

- 嚴格型別，不用 `any`
- 每個模組職責單一
- 不加不必要的 abstraction（YAGNI）
