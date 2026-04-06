# modules/index — 進入點

> 檔案：`src/index.ts`

## 職責

程式進入點：載入設定 → 設定 log level → 載入 session → 建立 Discord Client → 啟動排程 → 登入 → 重啟回報 → 優雅關閉。

## 啟動順序

```text
 1. import { config }               ← module eval 時執行 loadConfig()，讀 config.json
 2. setLogLevel(config.logLevel)     ← 在其他模組 log 前設定層級（module 頂層執行）
 3. parseAgentArg() + loadAgentConfig() ← --agent 模式：載入合併設定
 4. await initPlatform(config, ...)  ← 初始化所有平台子系統（12 步，見 platform.md）
 5. loadSessions()                   ← 從磁碟載入 session 快取
 6. initHistory()                    ← 初始化訊息歷史 DB
 7. loadBuiltinSkills() + loadPromptSkills() + loadExternalSkills() ← 載入 skills
 8. createBot()                      ← 建立 Client + 綁定 messageCreate
 9. watchConfig()                    ← 啟動 config.json hot-reload 監聽
10. setupSlashCommands(bot)          ← 綁定 slash command 事件
11. await bot.login()                ← 連線 Discord Gateway
12. bot.once("clientReady")          ← Bot 上線後執行：
    ├─ 印出上線資訊（DM/Guild/工具訊息/CATCLAW_WORKSPACE/管理員白名單）
    ├─ registerSlashCommands(bot)    ← 部署 slash commands
    ├─ startCron(bot)                ← 啟動排程服務
    ├─ 重啟回報                     ← 偵測 signal/RESTART 並發送通知
    └─ Crash Recovery                ← 掃描 active-turns，向使用者確認中斷 turn
```

## Ready 事件輸出

```
[bridge] Bot 上線：BotName#1234
  DM：啟用
  Guild 設定：2 個（或「全部允許」）
  工具訊息：summary
  Claude 工作目錄：/home/user/.catclaw/workspace
```

> 「Claude 工作目錄」顯示 `CATCLAW_WORKSPACE` 環境變數的值（未設定時顯示 `(未設定)`）。

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

## Crash Recovery

`ready` 事件中，在重啟回報之後，掃描 `data/active-turns/` 目錄偵測未正常結束的 turn：

```typescript
const interruptedTurns = scanAndCleanActiveTurns(10 * 60_000); // 10 分鐘內才算有效
for (const { channelId: chId, record } of interruptedTurns) {
  // 有意重啟觸發的 turn 不視為中斷（從 signal/RESTART 的 channelId 排除）
  if (intentionalChannelIds.has(chId)) continue;

  client.channels.fetch(chId).then((ch) => {
    if (ch?.isTextBased() && "send" in ch) {
      ch.send(
        `[CatClaw] 上一輪對話被意外中斷。\n中斷的指令：「${promptPreview}」\n要繼續嗎？`
      );
    }
  });
}
```

### 有意重啟 vs Crash 的區分

| 場景 | `signal/RESTART` | `active-turns/` | 結果 |
|------|-----------------|-----------------|------|
| 正常 `node catclaw.js restart` | 存在，含 channelId | 可能有殘留 | 重啟通知 + 跳過 active-turn（intentionalChannelIds） |
| Crash / OOM / SIGKILL | 不存在 | 有殘留 | 掃描 + 向使用者確認 |
| 正常 SIGTERM（stop） | 不存在 | 無殘留（turn 結束才 stop） | 無動作 |

`intentionalChannelIds`：從 `signal/RESTART` 的 `channelId` 建立 `Set<string>`，用於排除「有意重啟的頻道不當成 crash」。

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
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { config, watchConfig, resolveCatclawDir, resolveWorkspaceDirSafe } from "./core/config.js";
import { setLogLevel, log } from "./logger.js";
import { createBot } from "./discord.js";
import { loadSessions, scanAndCleanActiveTurns } from "./session.js";
import { startCron, stopCron } from "./cron.js";
import { setupSlashCommands, registerSlashCommands } from "./slash.js";
import { initHistory } from "./history.js";
import { loadBuiltinSkills, loadPromptSkills, loadExternalSkills, loadExternalPromptSkills } from "./skills/registry.js";
import { initPlatform } from "./core/platform.js";
import { parseAgentArg, loadAgentConfig } from "./core/agent-loader.js";
```
