/**
 * @file index.ts
 * @description 進入點：載入設定、建立 Discord client、啟動 bot
 *
 * 流程：
 * 1. 從 config.ts 載入 config.json 設定
 * 2. 設定 log level
 * 3. 從 discord.ts 建立 Discord client
 * 4. 用 token 登入
 * 5. 監聽 ready 事件，確認上線後印出 bot tag
 * 6. 監聽 process 結束信號，優雅關閉
 */

import { config, watchConfig } from "./config.js";
import { setLogLevel } from "./logger.js";
import { log } from "./logger.js";
import { createDiscordClient } from "./discord.js";
import { loadSessions } from "./session.js";

// 在其他模組開始 log 前設定層級
setLogLevel(config.logLevel);

// 從磁碟載入上次的 session 快取（重啟後延續對話上下文）
loadSessions();

// ── 啟動 ─────────────────────────────────────────────────────────────────────

const client = createDiscordClient();

// 啟動 config.json 監聽，變動時自動 hot-reload
watchConfig();

client.once("ready", (c) => {
  log.info(`[bridge] Bot 上線：${c.user.tag}`);
  log.info(`  DM：${config.discord.dm.enabled ? "啟用" : "停用"}`);
  const guildCount = Object.keys(config.discord.guilds).length;
  log.info(`  Guild 設定：${guildCount > 0 ? `${guildCount} 個` : "全部允許"}`);
  log.info(`  工具訊息：${config.showToolCalls}`);
  log.info(`  Claude 工作目錄：${config.claude.cwd}`);
});

// 優雅關閉：收到 SIGINT / SIGTERM 時先 destroy client 再退出
function shutdown(signal: string): void {
  log.info(`\n[bridge] 收到 ${signal}，關閉中...`);
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 捕捉未處理的 Promise rejection，避免 Node.js 靜默忽略
process.on("unhandledRejection", (reason) => {
  log.error("[bridge] unhandledRejection:", reason);
});

// 登入 Discord
await client.login(config.discord.token);
