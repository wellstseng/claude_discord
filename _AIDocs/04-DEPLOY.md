# catclaw 部署指南

> 根據 `catclaw.js`、`ecosystem.config.cjs`、`package.json`、`_AIDocs/modules/pm2.md` 整理，2026-03-22

---

## 完整部署步驟（從 clone 到上線）

### 前置條件

- Node.js（支援 ESM）
- pnpm（套件管理）
- Claude Code CLI（`claude` 在 PATH 中可用）
- PM2（全域安裝，或使用 npx）

### 步驟

```bash
# 1. clone 專案
git clone <repo-url> catclaw
cd catclaw

# 2. 安裝依賴（pnpm）
pnpm install

# 3. 初始化環境（自動複製 catclaw.example.json → catclaw.json）
node catclaw.js init
# 編輯 $CATCLAW_CONFIG_DIR/catclaw.json：填入 discord.token，設定 guilds 權限

# 4. 建立 data/ 目錄（session 和 cron-jobs 儲存位置）
mkdir -p data signal

# 5. （選用）建立 cron-jobs.json
cp cron-jobs.example.json data/cron-jobs.json
# 編輯 data/cron-jobs.json：設定排程 job

# 6. 編譯 TypeScript
pnpm build
# 或：npx tsc

# 7. 啟動 bot（PM2 背景執行）
node catclaw.js start
```

### 驗證上線

```bash
# 查看 PM2 狀態
node catclaw.js status

# 查看即時 log
node catclaw.js logs
```

Bot 上線後會在 log 中顯示：
```
[bridge] 已上線：BotName#0000
```

---

## PM2 指令

### 透過 catclaw.js 管理腳本（推薦）

```bash
node catclaw.js start                     # tsc 編譯 + pm2 start（首次啟動）
node catclaw.js restart                   # tsc 編譯 + 寫 signal/RESTART + pm2 restart
node catclaw.js stop                      # pm2 stop catclaw
node catclaw.js logs                      # pm2 logs catclaw（即時串流）
node catclaw.js status                    # pm2 status（所有程序）
node catclaw.js reset-session             # 清除所有 channel 的 session
node catclaw.js reset-session <channelId> # 只清除指定 channel 的 session
```

> **reset-session**：讀取 `CATCLAW_WORKSPACE` 定位 `data/sessions.json`，清除後下次訊息自動開新 session（不需重啟 bot）。

### 透過 package.json scripts

```bash
pnpm pm2:start    # pm2 start dist/index.js --name catclaw
pnpm pm2:restart  # tsc && pm2 restart catclaw
pnpm pm2:stop     # pm2 stop catclaw
pnpm pm2:logs     # pm2 logs catclaw
pnpm pm2:status   # pm2 status
```

> 注意：`pnpm pm2:start` 不會讀 `ecosystem.config.cjs`，直接啟動 `dist/index.js`。
> 首次推薦用 `node catclaw.js start`，會載入 ecosystem 設定（watch signal/ 目錄）。

### 直接使用 pm2 指令

```bash
npx pm2 start ecosystem.config.cjs  # 首次，讀 ecosystem 設定
npx pm2 restart catclaw             # 重啟（不重新編譯）
npx pm2 stop catclaw                # 停止
npx pm2 delete catclaw              # 刪除（修改 ecosystem.config.cjs 後需此步）
npx pm2 logs catclaw                # 即時 log
npx pm2 status                      # 狀態
npx pm2 save                        # 儲存程序清單（開機自啟用）
npx pm2 startup                     # 設定開機自啟
```

---

## signal file 重啟機制

### 為什麼需要 signal file？

Signal file 用於傳遞 `channelId`，讓重啟後的 ready 事件知道要通知哪個 Discord 頻道。
PM2 設定 `watch: ["signal"]`，但 `catclaw.js restart` 同時呼叫 `pm2 restart`（雙保險）。
tsc 編譯不會觸發重啟（dist/ 不在 watch 範圍內），需明確觸發。

### 重啟流程

```
1. tsc 編譯  →  dist/ 更新（不觸發重啟）
                     ↓
   寫入 signal/RESTART（帶 channelId + time）
                     ↓
   pm2 restart catclaw（直接重啟）
                     ↓
   index.ts ready 事件讀 signal/RESTART
                     ↓
   向觸發頻道發送 "[CatClaw] 已重啟（時間）"
                     ↓
   unlinkSync 刪除 signal/RESTART（防重複通知）
```

### signal/RESTART 格式

```json
{ "channelId": "123456789012345678", "time": "2026-03-21T09:00:00+08:00" }
```

- `channelId`：重啟完成後通知的頻道 ID（來自 `CATCLAW_CHANNEL_ID` 環境變數）
- `time`：ISO 8601 時間字串（顯示用）

### 手動觸發重啟（Claude 指令）

Claude 在 Discord 頻道中執行重啟時，依序：

```bash
# 1. 編譯
npx tsc

# 2. 寫入 signal file（CATCLAW_CHANNEL_ID 由環境自動帶入）
echo '{"channelId":"'$CATCLAW_CHANNEL_ID'","time":"'$(date -Iseconds)'"}' > signal/RESTART
```

> **重要**：先編譯、確認使用者同意後再觸發重啟，不要未經確認就寫 signal file。

### 向下相容（舊格式）

signal/RESTART 若為純字串（非 JSON）→ 只 log，不發 Discord 通知。

---

## config/cron hot-reload 使用方式

### catclaw.json hot-reload

- 監聯機制：`fs.watch(catclaw.json, ...)` + 500ms debounce
- **不需重啟**即可生效的設定：所有欄位（discord 權限、claude 設定、showToolCalls、logLevel 等）
- **需要重啟**才生效：`discord.token`（Gateway 連線在啟動時建立，變更 token 只會 log warn）

```bash
# 修改 catclaw.json 後，等約 0.5s 即自動生效
# log 中會看到：[config] 設定已重新載入
```

### cron-jobs.json hot-reload

- 監聽機制：`fs.watch(data/cron-jobs.json, ...)` + 500ms debounce
- **不需重啟**即可生效：新增、修改、停用、刪除 job
- hot-reload 策略：保留執行中 job 的狀態（nextRunAtMs/retryCount 等），新定義覆蓋舊定義

```bash
# 修改 data/cron-jobs.json 後直接存檔即生效
# log 中會看到：[cron] 排程已重新載入，N 個 job
```

> 注意：cron.ts 自寫 data/cron-jobs.json 時會設 `selfWriting = true` 防止觸發自身的 reload。

---

## data/ 目錄結構

```
data/                           # 執行期資料（已 gitignore）
├── sessions.json               # channelId → sessionId 映射（磁碟持久化）
│                               #   格式：{ [channelId]: { sessionId, updatedAt } }
│                               #   原子寫入：sessions.json.tmp → rename
└── cron-jobs.json              # 排程 job 定義 + 執行狀態
                                #   格式：{ version: 1, jobs: { [jobId]: CronJobEntry } }
                                #   原子寫入：cron-jobs.json.tmp → rename
```

```
signal/                         # PM2 watch 目標（已 gitignore）
└── RESTART                     # 重啟信號檔（用完即刪）
```

> `data/` 和 `signal/` 首次啟動若不存在，程式會自動建立（`mkdirSync recursive`）。

---

## 健康檢查方式

### 1. PM2 狀態

```bash
node catclaw.js status
# 或
npx pm2 status
```

正常狀態：`status = online`、`restarts` 數量合理

### 2. 即時 log 確認

```bash
node catclaw.js logs
# 或
npx pm2 logs catclaw --lines 50
```

Bot 正常運作時，每次 Discord 訊息會有對應的 log 輸出。

### 3. Discord 測試訊息

在已設定的頻道發送 `@BotName ping`，確認 bot 回應。

### 4. Log level 調高除錯

修改 `catclaw.json` 中的 `logLevel` 為 `"debug"`，存檔後 hot-reload 自動生效，可看到詳細的訊息過濾流程。

### 5. ACP 串流除錯

若 Claude 沒有回應，開啟 ACP trace：

```bash
# 停止 pm2
node catclaw.js stop

# 前景執行並開啟 trace
ACP_TRACE=1 node dist/index.js
```

---

## 常見問題

### 修改了 ecosystem.config.cjs 後重啟不生效

PM2 `stop` + `start` 不會重讀 ecosystem config，需要：

```bash
npx pm2 delete catclaw
node catclaw.js start
```

### Bot 上線但不回應訊息

1. 確認 `catclaw.json` 的 `guilds` 設定中對應 guildId 的 `allow = true`
2. 確認頻道 ID 正確（或未設定 channels 讓其繼承 guild 預設）
3. 確認訊息有 @mention bot（若 `requireMention = true`）
4. 調高 `logLevel` 為 `"debug"` 查看過濾原因

### cron job 沒有執行

1. 確認 `catclaw.json` 的 `cron.enabled = true`
2. 確認 `data/cron-jobs.json` 的 job `enabled` 未設為 `false`
3. 確認 `schedule` 格式正確（`kind = "cron"` 的 expr 可用 crontab.guru 驗證）
4. 查看 log 中的 `[cron]` 相關輸出
