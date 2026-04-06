# PM2 進程管理 + 重啟機制

> 檔案：`catclaw.js`、`ecosystem.config.cjs`

## 概述

CatClaw 使用 PM2 做進程管理。**管理員操作**（CLI）與 **AI 操作**（Discord `/restart`）走不同路徑，職責分離。

## 檔案

| 檔案 | 用途 |
|------|------|
| `catclaw.js` | 跨平台管理腳本（start/stop/restart/logs/status） |
| `ecosystem.config.cjs` | PM2 設定（watch: false，不依賴 watch 觸發重啟） |
| `signal/RESTART` | 重啟信號檔（JSON: `{channelId, time}`），傳遞 channelId 給 ready 事件 |

## 管理員指令（CLI）

```bash
node catclaw.js start                     # tsc 編譯 + pm2 start ecosystem.config.cjs
node catclaw.js start -f                  # 強制 delete + re-register PM2（重構後或換環境後使用）
node catclaw.js stop                      # pm2 stop catclaw
node catclaw.js restart                   # tsc 編譯 + pm2 restart catclaw（直接重啟，無通知）
node catclaw.js logs                      # pm2 logs catclaw
node catclaw.js status                    # pm2 status
node catclaw.js reset-session             # 清除所有 channel 的 session
node catclaw.js reset-session <channelId> # 只清除指定 channel 的 session
```

### `start -f` 使用時機

- 重構後（cwd 可能跑掉）
- 跨環境部署（新機器）
- `/restart` 沒反應、PM2 無法偵測 signal

執行：`pm2 delete catclaw` → `pm2 start ecosystem.config.cjs`，確保 PM2 用當前目錄重新登錄。

### reset-session 細節

- 讀取 `CATCLAW_WORKSPACE` 環境變數定位 `sessions.json`（未設定則 fallback 到 `~/.catclaw/workspace`）
- 路徑：`<CATCLAW_WORKSPACE>/data/sessions.json`
- 指定 channelId：只刪除對應 key，其他 session 保留
- 不指定：覆寫整個 sessions.json 為 `{}`
- bot 不需重啟即可生效（下次訊息自動開新 session）

## 職責分離：管理員 vs AI

| 操作者 | 指令 | 機制 | 通知 |
|--------|------|------|------|
| 管理員（CLI） | `node catclaw.js restart` | 直接 `pm2 restart catclaw` | 無 |
| AI（茱蒂） | Discord `/restart` | 寫 signal + `pm2 restart catclaw` | 重啟後回報頻道 |

AI 走 signal 是為了傳遞 `channelId`，讓 ready 事件知道要通知哪個頻道。

## Discord `/restart` 重啟流程

```
使用者下 /restart
    ↓
slash.ts handleRestart()
    ↓
rmSync(舊 RESTART)  ← 確保是新建檔案
    ↓
writeFileSync(signal/RESTART, {channelId, time})
    ↓
回覆「🔄 重啟信號已送出...」
    ↓
setTimeout 300ms → execSync("npx pm2 restart catclaw")  ← 直接觸發
    ↓
index.ts ready 事件讀 signal/RESTART
    ↓
在觸發頻道發送 [CatClaw] 已重啟（時間）
    ↓
unlinkSync(signal/RESTART)
```

> **為何用 300ms delay？** 讓 `interaction.reply()` 先完成（Discord ACK），再 kill 進程。

## ecosystem.config.cjs

```javascript
module.exports = {
  apps: [{
    name: "catclaw",
    script: "dist/index.js",
    watch: ["signal"],  // 監聽 signal/ 目錄變更觸發重啟
    watch_delay: 1000,
    autorestart: true,
    merge_logs: true,
    env: { CATCLAW_CONFIG_DIR, CATCLAW_WORKSPACE }  // 從 .env 讀取
  }]
};
```

> **watch 機制**：PM2 監聽 `signal/` 目錄，`catclaw.js restart` 同時寫 signal file + 呼叫 `pm2 restart`（雙保險）。`/restart` skill 透過 signal file + `pm2 restart` 觸發。

## 首次部署

```bash
node catclaw.js start       # 首次啟動
node catclaw.js start -f    # 重構後或換環境後強制重新註冊
```

若修改了 `ecosystem.config.cjs`，必須用 `start -f` 讓 PM2 重讀設定。
