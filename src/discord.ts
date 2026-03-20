/**
 * @file discord.ts
 * @description Discord client 建立、訊息事件處理、debounce 合併
 *
 * 流程：
 * 1. 建立 discord.js Client（含所有必要 Intents + Partials）
 * 2. messageCreate 事件：
 *    a. 忽略 bot 自身訊息（永遠不回覆自己）
 *    b. getChannelAccess() 查詢 per-channel 設定（allow / requireMention / allowBot / allowFrom）
 *       繼承鏈：Thread → Parent Channel → Guild 預設
 *    c. allowBot / allowFrom 過濾
 *    d. strip mention prefix
 *    e. debounce（同一人 500ms 內多則訊息合併）
 *    f. 觸發 session.enqueue → reply.createReplyHandler
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
} from "discord.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "./config.js";
import { config, getChannelAccess } from "./config.js";
import { enqueue } from "./session.js";
import { createReplyHandler } from "./reply.js";
import { log } from "./logger.js";

// ── 訊息去重 ─────────────────────────────────────────────────────────────────

/**
 * 已處理的 message ID 集合，防止 DM partial channel 導致重複觸發
 * 超過 1000 筆時整批清除（重複訊息不可能間隔這麼久）
 */
const processedMessages = new Set<string>();

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

// ── 附件下載 ─────────────────────────────────────────────────────────────────

/** 附件暫存根目錄 */
const UPLOAD_DIR = join(tmpdir(), "claude-discord-uploads");

/**
 * 下載 Discord 訊息中的附件到暫存目錄
 * @param message Discord 訊息物件
 * @returns 已下載檔案的本地路徑陣列（空陣列 = 無附件）
 */
async function downloadAttachments(message: Message): Promise<string[]> {
  if (message.attachments.size === 0) return [];

  // 每則訊息一個子目錄，避免檔名衝突
  const dir = join(UPLOAD_DIR, message.id);
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];
  for (const [, att] of message.attachments) {
    try {
      const res = await fetch(att.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const fileName = att.name ?? "file";
      const filePath = join(dir, fileName);
      await writeFile(filePath, buffer);
      paths.push(filePath);
      log.debug(`[discord] 附件下載：${fileName} (${buffer.length} bytes) → ${filePath}`);
    } catch (err) {
      log.warn(`[discord] 附件下載失敗：${att.name ?? att.url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return paths;
}

// ── Discord Client 建立 ──────────────────────────────────────────────────────

/**
 * 建立並設定 Discord Client，綁定 messageCreate 事件
 * NOTE: 不捕獲 config 在 closure 中，每次 messageCreate 都讀全域 config
 *       這樣 hot-reload config 後，新訊息就會用新設定
 * @returns 已設定好的 Discord Client（尚未 login）
 */
export function createDiscordClient(): Client {
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
    // 每次都讀最新的全域 config，支援 hot-reload
    void handleMessage(message, config);
  });

  return client;
}

// ── 訊息處理 ────────────────────────────────────────────────────────────────

/**
 * 取得 Thread 的父頻道 ID（非 Thread 回傳 null）
 */
function getParentId(message: Message): string | null {
  const ch = message.channel;
  if (
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  ) {
    return ch.parentId;
  }
  return null;
}

/**
 * 處理收到的 Discord 訊息
 * @param message Discord 訊息物件
 * @param config 全域設定
 */
async function handleMessage(
  message: Message,
  config: BridgeConfig
): Promise<void> {
  log.debug(`[discord] 收到訊息 from=${message.author.tag} channel=${message.channelId} guild=${message.guild?.id ?? "DM"} content="${message.content.slice(0, 50)}"`);

  // NOTE: bot 自身訊息永遠忽略（不論 allowBot 設定），避免自我迴圈
  if (message.author.id === message.client.user?.id) {
    log.debug("[discord] 忽略：bot 自身訊息");
    return;
  }

  // 去重：防止同一訊息被處理兩次（DM partial channel 已知問題）
  if (processedMessages.has(message.id)) {
    log.debug(`[discord] 忽略：重複訊息 ${message.id}`);
    return;
  }
  processedMessages.add(message.id);
  if (processedMessages.size > 1000) processedMessages.clear();

  // 查詢 per-channel 存取設定（含繼承鏈：Thread → Parent → Guild）
  const guildId = message.guild?.id ?? null;
  const parentId = getParentId(message);
  const access = getChannelAccess(guildId, message.channelId, parentId);

  if (!access.allowed) {
    log.debug(`[discord] 忽略：頻道 ${message.channelId} 不允許`);
    return;
  }

  // Bot 訊息過濾（自身已在上面擋掉，這裡處理其他 bot）
  if (message.author.bot) {
    if (!access.allowBot) {
      log.debug(`[discord] 忽略：bot 訊息（allowBot=false）`);
      return;
    }
    // allowBot=true 但有 allowFrom 限制 → 也要通過白名單
  }

  // allowFrom 白名單過濾：有設定（非空陣列）→ 只處理名單內的 user/bot
  if (access.allowFrom.length > 0 && !access.allowFrom.includes(message.author.id)) {
    log.debug(`[discord] 忽略：${message.author.tag} 不在 allowFrom 白名單中`);
    return;
  }

  // 觸發模式判斷
  let text: string;

  if (access.requireMention) {
    // 需要 @mention bot
    const botUser = message.client.user;
    if (!botUser) {
      log.debug("[discord] 忽略：botUser 為 null");
      return;
    }
    if (!message.mentions.has(botUser)) {
      log.debug("[discord] 忽略：未 mention bot");
      return;
    }

    // 移除 mention prefix（<@botId> 或 <@!botId>），保留後續文字
    text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();
  } else {
    // 不需 mention：直接使用完整訊息
    text = message.content.trim();
  }

  // 下載附件（圖片、檔案等），路徑嵌入 prompt 讓 Claude 可存取
  const attachmentPaths = await downloadAttachments(message);
  if (attachmentPaths.length > 0) {
    const fileList = attachmentPaths.map((p) => `- ${p}`).join("\n");
    text += `\n\n[使用者附件，請用 Read 工具讀取]\n${fileList}`;
  }

  // 訊息為空（只有 mention 沒有文字，且無附件）→ 忽略
  if (!text) {
    log.debug("[discord] 忽略：文字為空");
    return;
  }

  log.debug(`[discord] 通過過濾，text="${text.slice(0, 80)}" → 進入 debounce`);

  // Debounce：合併短時間內同一人的多則訊息
  debounce(message, text, config, (combinedText, firstMessage) => {
    const onEvent = createReplyHandler(firstMessage, config);

    // 多人頻道中讓 Claude 知道發言者身份
    const prompt = `${firstMessage.author.displayName}: ${combinedText}`;

    enqueue(firstMessage.channelId, prompt, onEvent, {
      cwd: config.claude.cwd,
      claudeCmd: config.claude.command,
      turnTimeoutMs: config.claude.turnTimeoutMs,
      sessionTtlMs: config.claude.sessionTtlHours * 3600_000,
    });
  });
}
