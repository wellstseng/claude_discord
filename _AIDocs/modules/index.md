# modules/index — 進入點

> 檔案：`src/index.ts`

## 職責

程式進入點：載入設定 → 設定 log level → 載入 session → 建立 Discord Client → 啟動排程 → 登入 → 重啟回報 → 優雅關閉。

## 啟動順序

```text
1. import { config }             ← module eval 時執行 loadConfig()，讀 config.json
2. setLogLevel(config.logLevel)  ← 在其他模組 log 前設定層級（module 頂層執行）
3. loadSessions()                ← 從磁碟載入 session 快取（重啟後延續對話上下文）
4. createDiscordClient()         ← 建立 Client + 綁定 messageCreate（不傳 config）
5. watchConfig()                 ← 啟動 config.json hot-reload 監聽
6. await client.login()          ← 連線 Discord Gateway
7. client.once("ready")          ← Bot 上線後執行：
   ├─ 印出上線資訊
   ├─ startCron(client)          ← 啟動排程服務（需要 client 傳送訊息）
   └─ 重啟回報                   ← 偵測 signal/RESTART 並發送通知
```

## Ready 事件輸出

```
[bridge] Bot 上線：BotName#1234
  DM：啟用
  Guild 設定：2 個（或「全部允許」）
  工具訊息：summary
  Claude 工作目錄：/home/user
```

## 重啟回報

`ready` 事件中偵測 `signal/RESTART` signal file，向觸發重啟的頻道回報已上線：

```typescript
const signalPath = resolve(process.cwd(), "signal", "RESTART");
if (existsSync(signalPath)) {
  try {
    const raw = readFileSync(signalPath, "utf-8").trim();
    unlinkSync(signalPath);  // 先刪除，防止重複通知

    // signal file 格式：JSON { channelId?, time? } 或純時間字串（向下相容舊版）
    let channelId: string | undefined;
    let restartTime: string;
    try {
      const parsed = JSON.parse(raw) as { channelId?: string; time?: string };
      channelId = parsed.channelId;
      restartTime = parsed.time ?? raw;
    } catch {
      restartTime = raw;  // JSON parse 失敗 → 整段視為時間字串
    }

    if (channelId) {
      // NOTE: ready 時 cache 可能尚未填充，用 fetch() 確保取得頻道
      client.channels.fetch(channelId)
        .then((ch) => {
          if (ch?.isTextBased() && "send" in ch) {
            ch.send(`[CatClaw] 已重啟（${restartTime}）`);
          }
          log.info(`[bridge] 重啟通知已送出 channel=${channelId}`);
        })
        .catch((err) => log.warn(`[bridge] 重啟通知失敗 channel=${channelId}: ${err}`));
    } else {
      log.info("[bridge] 重啟偵測到但無 channelId，跳過通知");
    }
  } catch (err) {
    log.warn(`[bridge] 重啟通知處理失敗: ${err}`);
  }
}
```

### Signal File 偵測與解析邏輯

| 步驟 | 說明 |
|------|------|
| `existsSync(signalPath)` | 偵測 `signal/RESTART` 是否存在 |
| `readFileSync` + `unlinkSync` | 讀取後立即刪除，防止重啟後重複觸發 |
| 外層 `try/catch` | 整個流程出錯只 warn，不影響 bot 啟動 |
| 內層 JSON parse + `catch` | 失敗 → 整段字串視為 `restartTime`（向下相容舊格式） |
| `channelId` 為 undefined | 跳過通知，只記 info log（signal 無頻道資訊） |
| `ch?.isTextBased() && "send" in ch` | 型別守衛，確認頻道可發訊息再發 |
| `client.channels.fetch()` | 不用 cache，確保 ready 時能取得頻道物件 |
| `.catch()` | fetch 或 send 失敗 → warn log，不 crash |

**Signal file 格式**（由 PM2 watch 觸發前寫入）：

```json
{ "channelId": "1234567890", "time": "2026-03-21T10:00:00+08:00" }
```

舊版（純時間字串，仍相容）：

```
2026-03-21T10:00:00+08:00
```

## 優雅關閉

```
SIGINT / SIGTERM
  → stopCron()        ← 停止排程服務（clearTimeout）
  → client.destroy()  ← 斷開 Discord Gateway
  → process.exit(0)
```

## 全域錯誤捕捉

```typescript
process.on("unhandledRejection", (reason) => {
  log.error("[bridge] unhandledRejection:", reason);
});
```

避免 Node.js 靜默忽略未處理的 Promise rejection（例如 Discord API 呼叫失敗）。

## 模組匯入順序

```typescript
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config, watchConfig } from "./config.js";     // ← module eval 時載入設定
import { setLogLevel, log } from "./logger.js";
import { createDiscordClient } from "./discord.js";
import { loadSessions } from "./session.js";
import { startCron, stopCron } from "./cron.js";
```
