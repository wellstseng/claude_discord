/**
 * @file discord.ts
 * @description Discord client 建立、訊息事件處理、debounce 合併
 *
 * 流程：
 * 1. 建立 discord.js Client（含所有必要 Intents + Partials）
 * 2. messageCreate 事件：
 *    a. 忽略 bot 自身訊息
 *    b. 頻道白名單過濾
 *    c. 觸發模式判斷（mention / all / DM 永遠觸發）
 *    d. strip mention prefix
 *    e. debounce（同一人 500ms 內多則訊息合併）
 *    f. 觸發 session.enqueue → reply.createReplyHandler
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { BridgeConfig } from "./config.js";
import { enqueue } from "./session.js";
import { createReplyHandler } from "./reply.js";

// ── Debounce 內部狀態 ────────────────────────────────────────────────────────

/** debounce key → timer handle */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** debounce key → 累積中的訊息行 */
const debounceBuffers = new Map<string, string[]>();

/** debounce key → 觸發 debounce 的第一則訊息（用於 reply） */
const debounceMessages = new Map<string, Message>();

// ── Debounce 函式 ────────────────────────────────────────────────────────────

/**
 * Debounce：同一人在 debounceMs 內的多則訊息合併成一則
 *
 * @param message Discord 訊息物件
 * @param text strip 後的訊息文字
 * @param config 全域設定
 * @param onFire 合併完成後的回呼，接收合併後文字 + 第一則訊息
 */
function debounce(
  message: Message,
  text: string,
  config: BridgeConfig,
  onFire: (combinedText: string, firstMessage: Message) => void
): void {
  // key 以 channelId:authorId 區分，避免不同人的訊息互相干擾
  const key = `${message.channelId}:${message.author.id}`;

  // 清除上一個 timer，重新計時
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  // 累積訊息文字（多則用換行合併）
  const lines = debounceBuffers.get(key) ?? [];
  lines.push(text);
  debounceBuffers.set(key, lines);

  // 記錄第一則訊息（用於 reply）
  if (!debounceMessages.has(key)) {
    debounceMessages.set(key, message);
  }

  // 設定新 timer
  const timer = setTimeout(() => {
    const combinedText = (debounceBuffers.get(key) ?? []).join("\n");
    const firstMessage = debounceMessages.get(key) ?? message;

    // 清理狀態
    debounceTimers.delete(key);
    debounceBuffers.delete(key);
    debounceMessages.delete(key);

    onFire(combinedText, firstMessage);
  }, config.debounceMs);

  debounceTimers.set(key, timer);
}

// ── Discord Client 建立 ──────────────────────────────────────────────────────

/**
 * 建立並設定 Discord Client，綁定 messageCreate 事件
 * @param config 全域設定
 * @returns 已設定好的 Discord Client（尚未 login）
 */
export function createDiscordClient(config: BridgeConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // NOTE: DM 必須加 Partials.Channel，否則 discord.js 不會觸發 DM 的 messageCreate 事件
    partials: [Partials.Channel],
  });

  client.on("messageCreate", (message: Message) => {
    void handleMessage(message, config);
  });

  return client;
}

// ── 訊息處理 ────────────────────────────────────────────────────────────────

/**
 * 處理收到的 Discord 訊息
 * @param message Discord 訊息物件
 * @param config 全域設定
 */
async function handleMessage(
  message: Message,
  config: BridgeConfig
): Promise<void> {
  console.log(`[DEBUG] 收到訊息 from=${message.author.tag} channel=${message.channelId} guild=${message.guild?.id ?? "DM"} content="${message.content.slice(0, 50)}"`);

  // NOTE: bot 自身訊息必須在 debounce 前過濾，避免 bot 回覆佔用 debounce 容量
  if (message.author.bot) {
    console.log("[DEBUG] 忽略：bot 訊息");
    return;
  }

  const isDM = !message.guild;

  // 頻道白名單過濾（DM 不受白名單限制）
  if (
    !isDM &&
    config.allowedChannelIds.size > 0 &&
    !config.allowedChannelIds.has(message.channelId)
  ) {
    console.log(`[DEBUG] 忽略：頻道 ${message.channelId} 不在白名單`);
    return;
  }

  // 觸發模式判斷
  // - DM：永遠觸發，無視 TRIGGER_MODE
  // - mention 模式：訊息必須 @mention bot
  // - all 模式：白名單頻道內所有訊息
  let text: string;

  if (isDM) {
    text = message.content.trim();
  } else if (config.triggerMode === "mention") {
    // 確認是否有 mention bot
    const botUser = message.client.user;
    if (!botUser) {
      console.log("[DEBUG] 忽略：botUser 為 null");
      return;
    }
    if (!message.mentions.has(botUser)) {
      console.log("[DEBUG] 忽略：未 mention bot");
      return;
    }

    // 移除 mention prefix（<@botId> 或 <@!botId>），保留後續文字
    text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();
  } else {
    // all 模式：直接使用完整訊息
    text = message.content.trim();
  }

  // 訊息為空（只有 mention 沒有文字）→ 忽略
  if (!text) {
    console.log("[DEBUG] 忽略：文字為空");
    return;
  }

  console.log(`[DEBUG] 通過過濾，text="${text.slice(0, 80)}" → 進入 debounce`);

  // Debounce：合併短時間內同一人的多則訊息
  debounce(message, text, config, (combinedText, firstMessage) => {
    const onEvent = createReplyHandler(firstMessage);

    enqueue(firstMessage.channelId, combinedText, onEvent, {
      cwd: config.claudeCwd,
      claudeCmd: config.claudeCommand,
      turnTimeoutMs: config.turnTimeoutMs,
    });
  });
}
