/**
 * @file slash.ts
 * @description Discord Slash Commands 管理介面
 *
 * 提供管理員專用指令，完全繞過 Claude AI，由 catclaw 直接執行：
 *   /restart              → 寫 signal/RESTART 觸發 PM2 重啟
 *   /reset-session        → 清除指定或全部頻道的 session
 *   /status               → 回報 bot 版本、uptime、session 數量
 *
 * 權限：config.admin.allowedUserIds 白名單，空陣列 = 拒絕所有人
 */

import {
  type Client,
  type ChatInputCommandInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  ApplicationCommandOptionType,
} from "discord.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./core/config.js";
import { log } from "./logger.js";
import { getSessionManager } from "./core/session.js";
import { getContextEngine, estimateTokens } from "./core/context-engine.js";
import { getRateLimiter } from "./core/rate-limiter.js";
import { getAccountRegistry } from "./core/platform.js";
import { getCliBridge, loadAllCliBridgeConfigs, saveCliBridgeConfigs } from "./cli-bridge/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Slash Command 定義 ───────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("重啟 CatClaw bot（寫入 signal/RESTART）"),

  new SlashCommandBuilder()
    .setName("reset-session")
    .setDescription("清除 Claude session")
    .addStringOption((opt) =>
      opt
        .setName("channel_id")
        .setDescription("指定頻道 ID（留空 = 清除全部）")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("查看 bot 狀態（uptime、session 數量）"),

  new SlashCommandBuilder()
    .setName("cd")
    .setDescription("切換 CLI Bridge 的工作目錄")
    .addStringOption((opt) =>
      opt
        .setName("path")
        .setDescription("目標目錄的絕對路徑")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("context")
    .setDescription("查看當前頻道的 context window 使用量與壓縮距離"),
];

// ── 部署 Slash Commands 到 Discord ──────────────────────────────────────────

/**
 * 向 Discord 註冊 slash commands（bot 上線後呼叫一次）
 * 使用 guild-specific 部署（即時生效），不用 global（需等 1 小時）
 */
export async function registerSlashCommands(client: Client): Promise<void> {
  const token = client.token ?? config.discord.token;
  const appId = client.user?.id;
  if (!appId) {
    log.warn("[slash] 無法取得 application ID，跳過 slash command 註冊");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = commands.map((c) => c.toJSON());

  // 取得所有 guild，對每個 guild 部署（guild command 立即生效）
  const guildIds = client.guilds.cache.map((g) => g.id);
  if (guildIds.length === 0) {
    log.warn("[slash] bot 尚未加入任何 guild，跳過 slash command 註冊");
    return;
  }

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
      log.info(`[slash] Slash commands 已部署到 guild ${guildId}`);
    } catch (err) {
      log.warn(`[slash] 部署 guild ${guildId} 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── 權限檢查 ────────────────────────────────────────────────────────────────

function isAdmin(userId: string): boolean {
  const { allowedUserIds } = config.admin;
  if (allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(userId);
}

// ── 指令處理 ────────────────────────────────────────────────────────────────

async function handleRestart(interaction: ChatInputCommandInteraction): Promise<void> {
  const signalDir = resolve(__dirname, "..", "signal");
  mkdirSync(signalDir, { recursive: true });
  const signalPath = join(signalDir, "RESTART");

  // 先刪除舊檔案，確保 PM2 watch 能偵測到 create 事件（覆寫同一檔案可能不觸發）
  if (existsSync(signalPath)) {
    rmSync(signalPath);
  }

  writeFileSync(signalPath, JSON.stringify({
    channelId: interaction.channelId,
    time: new Date().toISOString(),
  }), "utf-8");

  await interaction.reply("🔄 重啟信號已送出，幾秒後 bot 會重新上線並在此頻道回報。");
  log.info(`[slash] /restart 觸發，channel=${interaction.channelId} by=${interaction.user.tag}`);
}

async function handleResetSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.options.getString("channel_id") ?? null;
  const sm = getSessionManager();

  if (channelId) {
    // 搜尋 sessionKey 包含此 channelId 的 session
    const session = sm.list().find(s => s.channelId === channelId);
    if (session) {
      sm.delete(session.sessionKey);
      await interaction.reply(`✅ 已刪除 channel \`${channelId}\` 的 session（${session.sessionKey}）`);
    } else {
      await interaction.reply(`ℹ️ 找不到 channel \`${channelId}\` 的 session`);
    }
    log.info(`[slash] /reset-session channel=${channelId} by=${interaction.user.tag}`);
  } else {
    const sessions = sm.list();
    const count = sessions.length;
    for (const s of sessions) sm.delete(s.sessionKey);
    await interaction.reply(`✅ 已清除全部 ${count} 個 session`);
    log.info(`[slash] /reset-session all (${count} sessions) by=${interaction.user.tag}`);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const uptimeSec = Math.floor(process.uptime());
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  const sessionCount = getSessionManager().list().length;
  const tag = interaction.client.user?.tag ?? "unknown";

  await interaction.reply(
    `**CatClaw Status**\n` +
    `• Bot：${tag}\n` +
    `• Uptime：${uptimeStr}\n` +
    `• 活躍 sessions：${sessionCount} 個`
  );
}

async function handleCd(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetPath = interaction.options.getString("path", true);
  const channelId = interaction.channelId;

  // 找到此頻道的 bridge
  const bridge = getCliBridge(channelId);
  if (!bridge) {
    await interaction.reply({ content: "❌ 此頻道沒有綁定 CLI Bridge", ephemeral: true });
    return;
  }

  // ~ 展開 + 絕對化
  const expanded = targetPath.startsWith("~/")
    ? join(process.env.HOME ?? "/", targetPath.slice(2))
    : targetPath;
  const absPath = resolve(expanded);
  if (!existsSync(absPath)) {
    await interaction.reply({ content: `❌ 目錄不存在：\`${absPath}\``, ephemeral: true });
    return;
  }

  const oldDir = bridge.workingDir;
  await interaction.deferReply();

  try {
    // 1. 更新 runtime
    await bridge.setWorkingDir(absPath);

    // 2. 持久化到 cli-bridges.json
    const allConfigs = loadAllCliBridgeConfigs();
    const cfg = allConfigs.find(c => c.label === bridge.label);
    if (cfg) {
      cfg.workingDir = absPath;
      saveCliBridgeConfigs(allConfigs);
    }

    await interaction.editReply(
      `✅ **工作目錄已切換**\n` +
      `• Bridge：${bridge.label}\n` +
      `• 舊目錄：\`${oldDir}\`\n` +
      `• 新目錄：\`${absPath}\`\n` +
      `• 狀態：${bridge.status}（process 已重啟）`
    );
    log.info(`[slash] /cd ${absPath} by=${interaction.user.tag} bridge=${bridge.label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`❌ 切換失敗：${msg}`);
    log.error(`[slash] /cd 失敗：${msg}`);
  }
}

async function handleContext(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const sm = getSessionManager();
  const session = sm.list().find(s => s.channelId === channelId);

  if (!session) {
    await interaction.reply({ content: "ℹ️ 此頻道尚無 session", ephemeral: true });
    return;
  }

  const messages = session.messages;
  const tokens = estimateTokens(messages);

  const ce = getContextEngine();
  const contextWindow = ce?.getContextWindowTokens() ?? 100_000;
  const utilization = tokens / contextWindow;

  // CE thresholds
  const compactionTrigger = (ce?.getStrategy("compaction") as any)?.cfg?.triggerTokens ?? 4000;
  const bgCfg = (ce?.getStrategy("budget-guard") as any)?.cfg;
  const bgTrigger = Math.floor((bgCfg?.contextWindowTokens ?? contextWindow) * (bgCfg?.maxUtilization ?? 0.8));
  const ohCfg = (ce?.getStrategy("overflow-hard-stop") as any)?.cfg;
  const ohTrigger = Math.floor((ohCfg?.contextWindowTokens ?? contextWindow) * (ohCfg?.hardLimitUtilization ?? 0.95));

  // Rate limit
  let rlLine = "";
  try {
    const limiter = getRateLimiter();
    const accountReg = getAccountRegistry();
    const accountId = accountReg.resolveIdentity("discord", interaction.user.id);
    const account = accountId ? accountReg.get(accountId) : null;
    const role = account?.role ?? "member";
    const rl = limiter.check(interaction.user.id, role);
    rlLine = `• Rate Limit（${role}）：${rl.remaining === -1 ? "無限制" : `剩餘 ${rl.remaining} 次/分`}`;
    if (!rl.allowed) rlLine += `（${Math.ceil(rl.retryAfterMs / 1000)}s 後重置）`;
  } catch {
    rlLine = "• Rate Limit：不可用";
  }

  const bar = (current: number, total: number) => {
    const pct = Math.min(current / total, 1);
    const filled = Math.round(pct * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  await interaction.reply(
    `**Context Window 狀態**\n` +
    `• Session：\`${session.sessionKey}\`\n` +
    `• Turns：${session.turnCount}（${messages.length} messages）\n` +
    `• Token 估算：**${tokens.toLocaleString()}** / ${contextWindow.toLocaleString()}（${(utilization * 100).toFixed(1)}%）\n` +
    `• ${bar(tokens, contextWindow)}\n\n` +
    `**CE Thresholds**\n` +
    `• Compaction（${compactionTrigger.toLocaleString()}）：${tokens > compactionTrigger ? "⚠️ EXCEEDED" : `✅ 距離 ${(compactionTrigger - tokens).toLocaleString()}`}\n` +
    `• BudgetGuard（${bgTrigger.toLocaleString()}）：${tokens > bgTrigger ? "⚠️ EXCEEDED" : `✅ 距離 ${(bgTrigger - tokens).toLocaleString()}`}\n` +
    `• OverflowHardStop（${ohTrigger.toLocaleString()}）：${tokens > ohTrigger ? "🔴 EXCEEDED" : `✅ 距離 ${(ohTrigger - tokens).toLocaleString()}`}\n\n` +
    rlLine
  );
}

// ── 主要入口：綁定 interactionCreate 事件 ───────────────────────────────────

/**
 * 綁定 slash command 事件到 Discord client
 * @param client Discord Client（已登入）
 */
export function setupSlashCommands(client: Client): void {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;

    // 管理員白名單驗證
    if (!isAdmin(user.id)) {
      await interaction.reply({
        content: "❌ 你沒有執行此指令的權限",
        ephemeral: true,
      });
      log.warn(`[slash] 拒絕：${user.tag} (${user.id}) 嘗試執行 /${commandName}`);
      return;
    }

    log.info(`[slash] 執行：/${commandName} by ${user.tag} (${user.id})`);

    try {
      switch (commandName) {
        case "restart":
          await handleRestart(interaction);
          break;
        case "reset-session":
          await handleResetSession(interaction);
          break;
        case "status":
          await handleStatus(interaction);
          break;
        case "cd":
          await handleCd(interaction);
          break;
        case "context":
          await handleContext(interaction);
          break;
        default:
          await interaction.reply({ content: "未知指令", ephemeral: true });
      }
    } catch (err) {
      log.error(`[slash] /${commandName} 執行失敗：${err}`);
      const msg = err instanceof Error ? err.message : String(err);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: `❌ 執行失敗：${msg}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `❌ 執行失敗：${msg}`, ephemeral: true });
      }
    }
  });
}
