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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config, watchConfig } from "./config.js";
import { setLogLevel } from "./logger.js";
import { log } from "./logger.js";
import { createDiscordClient } from "./discord.js";
import { loadSessions, scanAndCleanActiveTurns } from "./session.js";
import { startCron, stopCron } from "./cron.js";
import { setupSlashCommands, registerSlashCommands } from "./slash.js";

// 在其他模組開始 log 前設定層級
setLogLevel(config.logLevel);

// 從磁碟載入上次的 session 快取（重啟後延續對話上下文）
loadSessions();

// ── 啟動 ─────────────────────────────────────────────────────────────────────

const client = createDiscordClient();

// 啟動 config.json 監聽，變動時自動 hot-reload
watchConfig();

// Slash command 事件綁定（在 login 前綁，確保 ready 前就 listening）
setupSlashCommands(client);

client.once("ready", (c) => {
  log.info(`[bridge] Bot 上線：${c.user.tag}`);
  log.info(`  DM：${config.discord.dm.enabled ? "啟用" : "停用"}`);
  const guildCount = Object.keys(config.discord.guilds).length;
  log.info(`  Guild 設定：${guildCount > 0 ? `${guildCount} 個` : "全部允許"}`);
  log.info(`  工具訊息：${config.showToolCalls}`);
  log.info(`  Claude 工作目錄：${process.env.CATCLAW_WORKSPACE ?? "(未設定)"}`);
  log.info(`  管理員白名單：${config.admin.allowedUserIds.length > 0 ? config.admin.allowedUserIds.join(", ") : "（未設定，slash commands 無人可用）"}`);

  // Slash commands 部署到所有 guild（guild command 立即生效）
  void registerSlashCommands(client);

  // Bot 上線後啟動排程服務（需要 client 來發送訊息）
  startCron(client);

  // ── 重啟通知 + Crash recovery ──
  // 有意重啟（signal/RESTART）的 channelId 要排除在 crash recovery 之外，
  // 因為觸發重啟的那個 turn 本身就是「有意結束」，不是中斷。
  const signalPath = resolve(process.cwd(), "signal", "RESTART");
  const intentionalChannelIds = new Set<string>();

  if (existsSync(signalPath)) {
    try {
      const raw = readFileSync(signalPath, "utf-8").trim();
      unlinkSync(signalPath);

      // signal file 格式：JSON { channelId, time } 或純時間字串（向下相容）
      let channelId: string | undefined;
      let restartTime: string;
      try {
        const parsed = JSON.parse(raw) as { channelId?: string; time?: string };
        channelId = parsed.channelId;
        restartTime = parsed.time ?? raw;
      } catch {
        restartTime = raw;
      }

      if (channelId) {
        intentionalChannelIds.add(channelId);
        // NOTE: cache 在 ready 時可能尚未填充，用 fetch 確保取得頻道
        client.channels.fetch(channelId).then((ch) => {
          if (ch?.isTextBased() && "send" in ch) {
            ch.send(`[CatClaw] 已重啟（${restartTime}）`);
          }
          log.info(`[bridge] 重啟通知已送出 channel=${channelId}`);
        }).catch((err: unknown) => {
          log.warn(`[bridge] 重啟通知失敗 channel=${channelId}: ${err}`);
        });
      } else {
        log.info(`[bridge] 重啟偵測到但無 channelId，跳過通知`);
      }
    } catch (err) {
      log.warn(`[bridge] 重啟通知處理失敗: ${err}`);
    }
  }

  // ── Crash recovery：掃描被中斷的 turn，排除有意重啟的頻道 ──
  const interruptedTurns = scanAndCleanActiveTurns(10 * 60_000); // 10 分鐘內的才接續
  for (const { channelId: chId, record } of interruptedTurns) {
    // 有意重啟觸發的 turn 不視為中斷
    if (intentionalChannelIds.has(chId)) {
      log.info(`[bridge] 跳過有意重啟的 active-turn channel=${chId}`);
      continue;
    }

    client.channels.fetch(chId).then((ch) => {
      if (ch?.isTextBased() && "send" in ch) {
        const promptPreview = record.prompt.length > 100
          ? record.prompt.slice(0, 100) + "…"
          : record.prompt;
        ch.send(
          `[CatClaw] 上一輪對話被意外中斷。\n中斷的指令：「${promptPreview}」\n要繼續嗎？`
        );
      }
      log.info(`[bridge] crash recovery 確認訊息已送出 channel=${chId}`);
    }).catch((err: unknown) => {
      log.warn(`[bridge] crash recovery 確認訊息失敗 channel=${chId}: ${err}`);
    });
  }
});

// 優雅關閉：收到 SIGINT / SIGTERM 時先 destroy client 再退出
function shutdown(signal: string): void {
  log.info(`\n[bridge] 收到 ${signal}，關閉中...`);
  stopCron();
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
