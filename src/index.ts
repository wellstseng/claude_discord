/**
 * @file index.ts
 * @description 進入點：載入設定、建立 Discord client、啟動 bot
 *
 * 流程：
 * 1. 從 config.ts 載入設定（失敗則印錯誤訊息並退出）
 * 2. 從 discord.ts 建立 Discord client
 * 3. 用 DISCORD_BOT_TOKEN 登入
 * 4. 監聽 ready 事件，確認上線後印出 bot tag
 * 5. 監聽 process 結束信號，優雅關閉
 */

// NOTE: dotenv 必須在 config.ts 之前載入，否則 process.env 尚未填充
import "dotenv/config";
import { config } from "./config.js";
import { createDiscordClient } from "./discord.js";

// ── 啟動 ─────────────────────────────────────────────────────────────────────

const client = createDiscordClient(config);

client.once("ready", (c) => {
  console.log(`[discord-claude-bridge] Bot 上線：${c.user.tag}`);
  console.log(`  觸發模式：${config.triggerMode}`);
  console.log(
    `  允許頻道：${
      config.allowedChannelIds.size > 0
        ? [...config.allowedChannelIds].join(", ")
        : "全部"
    }`
  );
  console.log(`  Claude 工作目錄：${config.claudeCwd}`);
});

// 優雅關閉：收到 SIGINT / SIGTERM 時先 destroy client 再退出
function shutdown(signal: string): void {
  console.log(`\n[discord-claude-bridge] 收到 ${signal}，關閉中...`);
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 捕捉未處理的 Promise rejection，避免 Node.js 靜默忽略
process.on("unhandledRejection", (reason) => {
  console.error("[discord-claude-bridge] unhandledRejection:", reason);
});

// 登入 Discord
await client.login(config.discordToken);
