/**
 * @file index.ts
 * @description 進入點：載入設定、建立 Discord bot、啟動 bot
 *
 * 流程：
 * 1. 從 config.ts 載入 config.json 設定
 * 2. 設定 log level
 * 3. 從 discord.ts 建立 Discord bot
 * 4. 用 token 登入
 * 5. 監聽 ready 事件，確認上線後印出 bot tag
 * 6. 監聽 process 結束信號，優雅關閉
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, watchConfig, resolveCatclawDir, resolveWorkspaceDirSafe } from "./core/config.js";
import { setLogLevel } from "./logger.js";
import { log } from "./logger.js";
import { createBot } from "./discord.js";
import { startCron, stopCron } from "./cron.js";
import { setupSlashCommands, registerSlashCommands } from "./slash.js";
import { initHistory } from "./history.js";
import { loadBuiltinSkills, loadPromptSkills, loadExternalSkills, loadExternalPromptSkills } from "./skills/registry.js";
import { initPlatform } from "./core/platform.js";
import type { BridgeConfig as CoreBridgeConfig } from "./core/config.js";
import { parseAgentArg, loadAgentBootConfig } from "./core/agent-loader.js";
import { startAllBridges, shutdownAllBridges } from "./cli-bridge/index.js";

// 在其他模組開始 log 前設定層級
setLogLevel(config.logLevel);
log.info(`[catclaw] 啟動`)

// ── Crash Log 路徑 ──────────────────────────────────────────────────────────
const _crashLogPath = join(
  process.env.CATCLAW_WORKSPACE ?? process.cwd(),
  "data",
  "last-crash.json"
);

// 捕捉未處理的 exception → 寫入 crash log，讓下次啟動時可讀取
process.on("uncaughtException", (err) => {
  log.error(`[bridge] uncaughtException: ${err.message}`);
  try {
    mkdirSync(dirname(_crashLogPath), { recursive: true });
    writeFileSync(_crashLogPath, JSON.stringify({
      time: new Date().toISOString(),
      message: err.message,
      stack: (err.stack ?? "").slice(0, 3000),
      type: "uncaughtException",
    }), "utf-8");
  } catch { /* 靜默 */ }
  process.exit(1);
});

// ── --agent 模式：若有指定 agent，載入合併後設定 ─────────────────────────────
const catclawDir = resolveCatclawDir();
const distDir = dirname(fileURLToPath(import.meta.url));
const agentId = parseAgentArg();
const platformConfig = agentId
  ? loadAgentBootConfig(config as unknown as CoreBridgeConfig, agentId)
  : config as unknown as CoreBridgeConfig;

if (agentId) log.info(`[bridge] Agent 模式：${agentId}`);

// ── 新平台子系統初始化（僅當 config.providers 有設定時啟用）──────────────────
const workspaceDir = resolveWorkspaceDirSafe();
await initPlatform(platformConfig, catclawDir, distDir, workspaceDir);

// 舊版 loadSessions() 已移除 — 新版 SessionManager 在 initPlatform() 內完成初始化

// 初始化訊息歷史 DB
initHistory();

// 載入內建 skill（Phase 0：Command-type Skill 攔截層）
void loadBuiltinSkills();

// 載入 Prompt-type skill（同步，注入 system prompt 用）
loadPromptSkills();

// 載入外部 skill 目錄（使用者自訂 skill，預設 ~/.catclaw/skills/）
{
  const catclawDir = resolveCatclawDir();
  const externalSkillsDir = join(catclawDir, "skills");
  void loadExternalSkills(externalSkillsDir);
  loadExternalPromptSkills(externalSkillsDir);
}

// ── 啟動 ─────────────────────────────────────────────────────────────────────

const bot = createBot();

// 啟動 config.json 監聽，變動時自動 hot-reload
watchConfig();

// Slash command 事件綁定（在 login 前綁，確保 ready 前就 listening）
setupSlashCommands(bot);

bot.once("clientReady", (c) => {
  log.info(`[bridge] Bot 上線：${c.user.tag}`);
  log.info(`  DM：${config.discord.dm.enabled ? "啟用" : "停用"}`);
  const guildCount = Object.keys(config.discord.guilds).length;
  log.info(`  Guild 設定：${guildCount > 0 ? `${guildCount} 個` : "全部允許"}`);
  log.info(`  工具訊息：${config.showToolCalls}`);
  log.info(`  Claude 工作目錄：${process.env.CATCLAW_WORKSPACE ?? "(未設定)"}`);
  log.info(`  管理員白名單：${config.admin.allowedUserIds.length > 0 ? config.admin.allowedUserIds.join(", ") : "（未設定，slash commands 無人可用）"}`);

  // Slash commands 部署到所有 guild（guild command 立即生效）
  void registerSlashCommands(bot);

  // Bot 上線後啟動排程服務（需要 bot 來發送訊息）
  startCron(bot);

  // ── CLI Bridge 啟動（持久 Claude CLI process）──────────────────────────────
  // ── CLI Bridge 啟動（讀取 ~/.catclaw/cli-bridges.json）──
  void startAllBridges(bot);

  // ── 重啟通知 ──
  const signalPath = resolve(process.cwd(), "signal", "RESTART");

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
        // NOTE: cache 在 ready 時可能尚未填充，用 fetch 確保取得頻道
        bot.channels.fetch(channelId).then(async (ch) => {
          if (ch?.isTextBased() && "send" in ch) {
            await ch.send(`[CatClaw] 已重啟（${restartTime}）`);
            log.info(`[bridge] 重啟通知已送出 channel=${channelId}`);
          }
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

  // ── 上次 crash 原因記錄 ────────────────────────────────────────────────────
  if (existsSync(_crashLogPath)) {
    try {
      const crash = JSON.parse(readFileSync(_crashLogPath, "utf-8")) as {
        time?: string; message?: string; stack?: string; type?: string;
      };
      log.warn(`[bridge] 上次因 crash 重啟 — ${crash.time ?? "?"} ${crash.message ?? ""}`);
      if (crash.stack) log.warn(`[bridge] crash stack: ${crash.stack.split("\n").slice(0, 3).join(" | ")}`);
      unlinkSync(_crashLogPath);
    } catch { /* 靜默 */ }
  }

  // V1 crash recovery（scanAndCleanActiveTurns）已移除 — V2 走 agentLoop，不寫 active-turns
});

// 優雅關閉：收到 SIGINT / SIGTERM 時先關閉所有 CLI bridge 再退出
let _shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (_shuttingDown) return; // 避免重複觸發
  _shuttingDown = true;
  log.info(`[bridge] 收到 ${signal}，關閉中...`);
  const dbg = (msg: string) => { try { writeFileSync("/tmp/catclaw-graceful.log", `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch {} };
  dbg(`${signal} received`);
  stopCron();
  try {
    dbg("shutdownAllBridges start");
    await shutdownAllBridges();
    dbg("shutdownAllBridges done");
    log.info("[bridge] 所有 CLI bridge 已關閉");
  } catch (err) {
    dbg(`shutdownAllBridges error: ${err instanceof Error ? err.message : String(err)}`);
    log.error(`[bridge] shutdownAllBridges 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  bot.destroy();
  dbg("exit");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 捕捉未處理的 Promise rejection（記錄但不 crash）
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error(`[bridge] unhandledRejection: ${msg}`);
});

// 登入 Discord
await bot.login(config.discord.token);
