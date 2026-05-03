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
 *    f. 觸發 agentLoop → handleAgentLoopReply
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
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./core/config.js";
import { config, getChannelAccess } from "./core/config.js";
import { matchSkill } from "./skills/registry.js";
import { recordUserMessage } from "./history.js";
import { log } from "./logger.js";
import {
  isPlatformReady,
  resolveDiscordIdentity,
  ensureGuestAccount,
  getAccountRegistry,
  getPlatformSessionManager,
  getPlatformPermissionGate,
  getPlatformToolRegistry,
  getPlatformSafetyGuard,
  getPlatformProjectManager,
  getPlatformRateLimiter,
} from "./core/platform.js";
import { getInboundHistoryStore, type InboundEntry } from "./discord/inbound-history.js";
import { checkBotMessage, resetOnHumanMessage } from "./discord/bot-circuit-breaker.js";
import { resolveProvider, getChannelAccess as getCoreChannelAccess } from "./core/config.js";
import { getProviderRegistry } from "./providers/registry.js";
import { agentLoop } from "./core/agent-loop.js";
import { getChannelThinking } from "./skills/builtin/think.js";
import { getChannelMode, getChannelModePreset, getModeThinking } from "./core/mode.js";
import { getChannelProviderOverride } from "./skills/builtin/use.js";
import { getChannelSystemOverride } from "./skills/builtin/system.js";
import { eventBus } from "./core/event-bus.js";
import { handleAgentLoopReply } from "./core/reply-handler.js";
import { runMessagePipeline } from "./core/message-pipeline.js";
import { setDiscordClient, getSubagentThreadBinding } from "./core/subagent-discord-bridge.js";
import { parseApprovalReply, parseApprovalButtonId, resolveApproval, setApprovalDiscordClient } from "./core/exec-approval.js";
import { abortRunningTurn } from "./skills/builtin/stop.js";
import { MessageTrace, getTraceStore } from "./core/message-trace.js";
import { setTaskUiDiscordClient, registerTaskUiListener, handleTaskButtonInteraction } from "./core/task-ui.js";

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

/** debounce key → 累積中的圖片附件 */
const debounceImages = new Map<string, Array<{ data: string; mimeType: string; name: string }>>();

/** debounce key → 觸發 debounce 的第一則訊息（用於 reply） */
const debounceMessages = new Map<string, Message>();

/** message ID → { debounceKey, index } 用於 messageUpdate 時替換 debounce buffer 內容 */
const debounceMessageIndex = new Map<string, { key: string; idx: number }>();

// ── Debounce 函式 ────────────────────────────────────────────────────────────

/**
 * Debounce：同一人在 debounceMs 內的多則訊息合併成一則
 *
 * @param message Discord 訊息物件
 * @param text strip 後的訊息文字
 * @param images 此訊息的圖片附件
 * @param config 全域設定
 * @param onFire 合併完成後的回呼，接收合併後文字 + 圖片 + 第一則訊息
 */
function debounce(
  message: Message,
  text: string,
  images: Array<{ data: string; mimeType: string; name: string }>,
  config: BridgeConfig,
  onFire: (combinedText: string, firstMessage: Message, allImages: typeof images) => void
): void {
  // key 以 channelId:authorId 區分，避免不同人的訊息互相干擾
  const key = `${message.channelId}:${message.author.id}`;

  // 清除上一個 timer，重新計時
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  // 累積訊息文字（多則用換行合併）
  const lines = debounceBuffers.get(key) ?? [];
  debounceMessageIndex.set(message.id, { key, idx: lines.length });
  lines.push(text);
  debounceBuffers.set(key, lines);

  // 累積圖片附件
  const imgs = debounceImages.get(key) ?? [];
  imgs.push(...images);
  debounceImages.set(key, imgs);

  // 記錄第一則訊息（用於 reply）
  if (!debounceMessages.has(key)) {
    debounceMessages.set(key, message);
  }

  // 設定新 timer
  const timer = setTimeout(() => {
    const combinedText = (debounceBuffers.get(key) ?? []).join("\n");
    const firstMessage = debounceMessages.get(key) ?? message;
    const allImages = debounceImages.get(key) ?? [];

    // 清理狀態
    debounceTimers.delete(key);
    debounceBuffers.delete(key);
    debounceImages.delete(key);
    debounceMessages.delete(key);
    // 清理 messageId → debounce index 映射
    for (const [mid, ref] of debounceMessageIndex) {
      if (ref.key === key) debounceMessageIndex.delete(mid);
    }

    onFire(combinedText, firstMessage, allImages);
  }, config.debounceMs);

  debounceTimers.set(key, timer);
}

// ── 訊息編輯處理 ─────────────────────────────────────────────────────────────

/**
 * 處理 Discord messageUpdate 事件
 * A. 若訊息還在 debounce buffer 內 → 直接替換內容
 * B. 若已離開 debounce（已 dispatch）→ 透過 CLI Bridge 注入編輯通知
 *
 * 過濾規則（避免誤打斷正在進行中的 turn）：
 * - 主 bot 自身編輯 → skip（Discord 自己的修飾，例如 placeholder→full）
 * - 任何已註冊的 CLI bridge 獨立 bot 編輯 → skip（避免 bridge bot streaming edit 觸發自我中斷迴圈）
 * - 使用者編輯距原訊息 < EDIT_TYPO_WINDOW_MS → skip（視為 typo 修正）
 */
const EDIT_TYPO_WINDOW_MS = 30_000;

async function handleMessageEdit(message: Message, config: BridgeConfig): Promise<void> {
  // 忽略主 bot 自身
  if (message.author.id === message.client.user?.id) return;

  // 忽略所有已註冊的 CLI bridge 獨立 bot（茱蒂#3861 等）
  // 這些 bot 在 streaming 過程會編輯自己的訊息（placeholder → 完整內容），
  // 若不過濾會被當成新使用者輸入 → 注入新 turn → abort 自己當前的 turn
  if (message.author.bot) {
    try {
      const { getCliBridgeBotUserIds } = await import("./cli-bridge/index.js");
      if (getCliBridgeBotUserIds().has(message.author.id)) return;
    } catch { /* CLI Bridge 模組未載入 → 走原邏輯 */ }
  }

  const newContent = message.content?.trim();
  if (!newContent) return;

  // A. Debounce 窗口內：替換 buffer 內容
  const ref = debounceMessageIndex.get(message.id);
  if (ref) {
    const lines = debounceBuffers.get(ref.key);
    if (lines && ref.idx < lines.length) {
      const oldText = lines[ref.idx];
      // strip mention prefix（同 handleMessage 邏輯）
      const botId = message.client.user?.id;
      const stripped = botId ? newContent.replace(new RegExp(`<@!?${botId}>\\s*`, "g"), "").trim() : newContent;
      lines[ref.idx] = stripped;
      log.info(`[discord] messageUpdate：debounce 內替換 msgId=${message.id} old="${oldText?.slice(0, 40)}" → new="${stripped.slice(0, 40)}"`);
      return;
    }
  }

  // 使用者短時間內編輯（< EDIT_TYPO_WINDOW_MS）→ 視為 typo 修正，silent skip
  // 不打斷 bridge 當前 turn；bridge 下一輪自然會看到使用者的後續訊息
  const editedAt = message.editedAt ?? new Date();
  const ageMs = editedAt.getTime() - message.createdAt.getTime();
  if (ageMs >= 0 && ageMs < EDIT_TYPO_WINDOW_MS) {
    log.info(`[discord] messageUpdate：typo-window skip msgId=${message.id} age=${ageMs}ms`);
    return;
  }

  // B. 已離開 debounce → 嘗試 soft-inject 到 active agentLoop turn
  try {
    const { pushInterruptMessage } = await import("./core/agent-loop.js");
    const sessionKey = `discord:ch:${message.channelId}`;
    const editNotice = `[訊息編輯] ${message.author.displayName ?? message.author.username} 將訊息修改為：\n${newContent}`;
    if (pushInterruptMessage(sessionKey, editNotice)) {
      log.info(`[discord] messageUpdate：soft-inject 到 active agentLoop turn msgId=${message.id} age=${ageMs}ms`);
      try { await message.react("✏️"); } catch { /* ignore */ }
      return;
    }
  } catch { /* agent-loop import 失敗 → 不擋，繼續 fallback */ }

  // C. fallback：注入編輯通知到 CLI Bridge（judy-cli 等子代理）
  try {
    const { getCliBridge } = await import("./cli-bridge/index.js");
    const cliBridge = getCliBridge(message.channelId);
    if (cliBridge && cliBridge.status === "busy") {
      const editNotice = `[訊息編輯] ${message.author.displayName ?? message.author.username} 將訊息修改為：\n${newContent}`;
      cliBridge.send(editNotice, "discord", { user: message.author.tag, sourceChannelId: message.channelId });
      log.info(`[discord] messageUpdate：注入編輯通知到 CLI Bridge ${cliBridge.label} msgId=${message.id} age=${ageMs}ms`);
      return;
    }
  } catch { /* CLI Bridge 未初始化 → 忽略 */ }

  log.debug(`[discord] messageUpdate：msgId=${message.id} 無對應 debounce 或 active turn/bridge，忽略`);
}

// ── 附件下載 ─────────────────────────────────────────────────────────────────

/** 附件暫存根目錄 */
const UPLOAD_DIR = join(tmpdir(), "claude-discord-uploads");

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function guessImageMime(name: string): string | null {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  return map[ext] ?? null;
}

interface AttachmentResult {
  /** 非圖片附件的本地路徑 */
  filePaths: string[];
  /** 圖片附件（base64 + mimeType）*/
  images: Array<{ data: string; mimeType: string; name: string }>;
}

/**
 * 下載 Discord 訊息中的附件到暫存目錄；圖片以 base64 形式返回供直接傳入 LLM。
 */
async function downloadAttachments(message: Message): Promise<AttachmentResult> {
  if (message.attachments.size === 0) return { filePaths: [], images: [] };

  const dir = join(UPLOAD_DIR, message.id);
  await mkdir(dir, { recursive: true });

  const filePaths: string[] = [];
  const images: AttachmentResult["images"] = [];

  for (const [, att] of message.attachments) {
    try {
      const res = await fetch(att.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const fileName = att.name ?? "file";

      // 判斷是否為圖片
      const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const isImage = IMAGE_MIME_TYPES.has(contentType)
        || IMAGE_EXTS.has(fileName.slice(fileName.lastIndexOf(".")).toLowerCase());
      const mimeType = IMAGE_MIME_TYPES.has(contentType) ? contentType : (guessImageMime(fileName) ?? contentType);

      if (isImage && mimeType) {
        images.push({ data: buffer.toString("base64"), mimeType, name: fileName });
        log.debug(`[discord] 圖片附件（vision）：${fileName} (${buffer.length} bytes)`);
      } else {
        const filePath = join(dir, fileName);
        await writeFile(filePath, buffer);
        filePaths.push(filePath);
        log.debug(`[discord] 附件下載：${fileName} (${buffer.length} bytes) → ${filePath}`);
      }
    } catch (err) {
      log.warn(`[discord] 附件下載失敗：${att.name ?? att.url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { filePaths, images };
}

// ── Discord Client 建立 ──────────────────────────────────────────────────────

/**
 * 建立並設定 Discord Client，綁定 messageCreate 事件
 * NOTE: 不捕獲 config 在 closure 中，每次 messageCreate 都讀全域 config
 *       這樣 hot-reload config 後，新訊息就會用新設定
 * @returns 已設定好的 Discord Client（尚未 login）
 */
export function createBot(): Client {
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

  client.on("messageUpdate", (_oldMessage, newMessage) => {
    // partial message → 需要 fetch 完整內容
    if (newMessage.partial) {
      newMessage.fetch().then(full => void handleMessageEdit(full, config)).catch(() => {});
    } else {
      void handleMessageEdit(newMessage as Message, config);
    }
  });

  // SUB-5：持久子 agent Discord 通知 + thread 建立用
  client.once("clientReady", () => {
    setDiscordClient(client);
    setApprovalDiscordClient(client);
    // Task UI：Discord Components v2
    setTaskUiDiscordClient(client);
    registerTaskUiListener((channelId) => `discord:ch:${channelId}`);

    // ── 重啟上線通知 ──
    void sendRestartNotification(client);
  });

  // 按鈕互動處理（exec-approval + task UI）
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isButton()) return;
    // Task UI buttons
    void handleTaskButtonInteraction(interaction).then(handled => {
      if (handled) return;
      // Exec-approval buttons (fallback)
      const parsed = parseApprovalButtonId(interaction.customId);
      if (!parsed) return;
      const found = resolveApproval(parsed.approvalId, parsed.approved);
      if (found) {
        void interaction.update({
          content: parsed.approved
            ? `✅ 已允許執行（approvalId: ${parsed.approvalId}）`
            : `❌ 已拒絕執行（approvalId: ${parsed.approvalId}）`,
          components: [],
        }).catch(() => {});
      }
    }).catch(() => {});
  });

  return client;
}

// ── 重啟上線通知 ────────────────────────────────────────────────────────────

async function sendRestartNotification(client: Client): Promise<void> {
  const notify = config.restartNotify;
  if (notify?.enabled === false) return;

  try {
    // 決定通知頻道（必須明確設定，不自動廣播所有頻道）
    const targetChannels = notify?.channels ?? [];
    if (targetChannels.length === 0) return;

    // 組裝通知訊息
    const botName = client.user?.displayName ?? client.user?.username ?? "Bot";
    let text = `✅ **${botName}** 已上線`;

    // 未完成任務摘要
    if (notify?.showPendingTasks !== false) {
      try {
        const { loadAllPersistedTasks } = await import("./core/task-store.js");
        const allPending = loadAllPersistedTasks();
        const totalPending = allPending.reduce((sum, s) => sum + s.tasks.length, 0);
        if (totalPending > 0) {
          text += `\n📋 有 ${totalPending} 個未完成任務（${allPending.length} 個 session）`;
        }
      } catch { /* task store 未初始化 */ }
    }

    // 發送
    for (const chId of targetChannels) {
      try {
        const ch = await client.channels.fetch(chId);
        if (ch && "send" in ch) await ch.send(text);
      } catch (err) {
        log.debug(`[discord] 上線通知發送失敗 ch=${chId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log.info(`[discord] 上線通知已送出至 ${targetChannels.length} 個頻道`);
  } catch (err) {
    log.warn(`[discord] 上線通知失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // NOTE: bot 自身訊息永遠忽略（不論 allowBot 設定），避免自我迴圈
  if (message.author.id === message.client.user?.id) {
    return;
  }

  log.debug(`[discord] 收到訊息 from=${message.author.tag} channel=${message.channelId} guild=${message.guild?.id ?? "DM"} content="${message.content}"`);

  // UserMessageReceived hook（可 block / 改 text）
  try {
    const { getHookRegistry } = await import("./hooks/hook-registry.js");
    const hookReg = getHookRegistry();
    if (hookReg && hookReg.count("UserMessageReceived") > 0) {
      const attachments = message.attachments.size > 0
        ? Array.from(message.attachments.values()).map(a => ({ name: a.name ?? "unknown", type: a.contentType ?? undefined, size: a.size }))
        : undefined;
      const res = await hookReg.runUserMessageReceived({
        event: "UserMessageReceived",
        source: "discord",
        text: message.content,
        attachments,
        user: message.author.tag,
      });
      if (res.blocked) {
        log.info(`[discord] UserMessageReceived hook 阻擋：${res.reason ?? ""}`);
        return;
      }
      // 目前 message 為 immutable；hook 修改 text 的效果由後續 hook 階段（UserPromptSubmit）套用
    }
  } catch { /* ignore */ }

  // 去重：防止同一訊息被處理兩次（DM partial channel 已知問題）
  if (processedMessages.has(message.id)) {
    log.debug(`[discord] 忽略：重複訊息 ${message.id}`);
    return;
  }
  processedMessages.add(message.id);
  if (processedMessages.size > 1000) processedMessages.clear();

  // ── exec-approval：DM 確認回覆攔截 ──────────────────────────────────────────
  // DM 訊息且符合「✅/❌ ABCDEF」格式 → 嘗試解析為確認回覆，不進入一般處理
  if (message.channel.type === ChannelType.DM) {
    const parsed = parseApprovalReply(message.content);
    if (parsed) {
      const found = resolveApproval(parsed.approvalId, parsed.approved);
      if (found) {
        const emoji = parsed.approved ? "✅" : "❌";
        log.info(`[discord] exec-approval ${emoji} approvalId=${parsed.approvalId} from=${message.author.tag}`);
        await message.react(emoji).catch(() => {});
        return;
      }
    }
  }

  // 查詢 per-channel 存取設定（含繼承鏈：Thread → Parent → Guild）
  const guildId = message.guild?.id ?? null;
  const parentId = getParentId(message);
  const access = getChannelAccess(guildId, message.channelId, parentId);

  if (!access.allowed) {
    log.debug(`[discord] 忽略：頻道 ${message.channelId} 不允許`);
    return;
  }

  // ── Inbound history helper（提早定義，供所有早退路徑使用） ──────────────
  const { getCliBridgeBotUserIds, getCliBridge: getCB, getAllBridges } = await import("./cli-bridge/index.js");
  const { getBootAgentId } = await import("./core/agent-loader.js");

  const _recordInbound = () => {
    const inboundStore = getInboundHistoryStore();
    // 落地記錄與 inject 解耦：只要 inboundHistory.enabled（預設 true）就記錄，
    // inject.enabled 只控制是否在下次 prompt 注入摘要
    const inboundEnabled = config.inboundHistory?.enabled ?? true;
    if (inboundStore && inboundEnabled && message.content.trim()) {
      const entry: InboundEntry = {
        ts: new Date().toISOString(),
        platform: "discord",
        channelId: message.channelId,
        authorId: message.author.id,
        authorName: message.author.displayName,
        content: message.content.trim(),
        wasProcessed: false,
      };
      // 寫入所有已註冊 agent/bridge 的 scope（各自消費、互不干擾）
      const scopes: string[] = [`agent:${getBootAgentId()}`];
      for (const b of getAllBridges()) scopes.push(`bridge:${b.label}`);
      inboundStore.appendToScopes(message.channelId, entry, scopes);
    }
  };

  // Bot 訊息過濾（自身已在上面擋掉，這裡處理其他 bot）
  if (message.author.bot) {
    if (!access.allowBot) {
      _recordInbound();
      log.debug(`[discord] 忽略：bot 訊息（allowBot=false）`);
      return;
    }
    // Bot-to-Bot circuit breaker
    if (!checkBotMessage(message.channelId, config.botCircuitBreaker)) {
      _recordInbound();
      log.info(`[discord] bot-circuit-breaker 攔截：channel=${message.channelId} author=${message.author.tag}`);
      return;
    }
  } else {
    // 人類訊息 → 重置 circuit breaker
    resetOnHumanMessage(message.channelId);
  }

  // allowFrom 白名單過濾：有設定（非空陣列）→ 只處理名單內的 user/bot
  if (access.allowFrom.length > 0 && !access.allowFrom.includes(message.author.id)) {
    _recordInbound();
    log.debug(`[discord] 忽略：${message.author.tag} 不在 allowFrom 白名單中`);
    return;
  }

  // @here / @everyone 群組廣播過濾
  if (access.blockGroupMentions && message.mentions.everyone) {
    _recordInbound();
    log.debug(`[discord] 忽略：群組 mention（@here/@everyone），blockGroupMentions=true`);
    return;
  }

  // ── Mention 路由規則 ─────────────────────────────────────────────────────
  // 訊息有 mention 某 bot → 只有被 mention 的 bot 處理，其餘記 inbound
  // 訊息沒 mention 任何 bot → requireMention=false 的 bot 處理，requireMention=true 記 inbound

  const botUser = message.client.user;
  const mainBotId = botUser?.id;

  // 收集訊息中 mention 到的已註冊 bot ID
  const cliBridgeBotIds = getCliBridgeBotUserIds();
  const allRegisteredBotIds = new Set(cliBridgeBotIds);
  if (mainBotId) allRegisteredBotIds.add(mainBotId);

  const mentionedBotIds = new Set<string>();
  for (const botId of allRegisteredBotIds) {
    if (message.mentions.has(botId)) mentionedBotIds.add(botId);
  }

  // 外部 bot mention 檢查：Discord API 的 mentions.users 有 bot flag
  const mentionedExternalBot = message.mentions.users.some(u => u.bot && !allRegisteredBotIds.has(u.id));

  const hasMentionedAnyBot = mentionedBotIds.size > 0 || mentionedExternalBot;
  const mainBotMentioned = mainBotId ? mentionedBotIds.has(mainBotId) : false;

  // 主 bot 觸發判斷
  let text: string;

  if (hasMentionedAnyBot) {
    // 訊息 mention 了某 bot → 只有被 mention 的 bot 處理
    if (!mainBotMentioned) {
      // 主 bot 沒被 mention → 記 inbound，不處理
      _recordInbound();
      log.debug("[discord] 忽略：訊息 mention 了其他 bot，主 bot 未被 mention");
      return;
    }
    // 主 bot 被 mention → 處理（移除 mention prefix）
    text = message.content.replace(/<@!?\d+>/g, "").trim();
  } else if (access.requireMention) {
    // 沒 mention 任何 bot + 主 bot 需要 mention → 記 inbound，不處理
    _recordInbound();
    log.debug("[discord] 忽略：未 mention bot");
    return;
  } else {
    // 沒 mention 任何 bot + 主 bot 不需 mention → 處理
    text = message.content.trim();
  }

  // 下載附件（圖片直接 base64，非圖片存磁碟讓 Claude 用 read_file 讀取）
  const { filePaths: attachmentPaths, images: imageAttachments } = await downloadAttachments(message);
  if (attachmentPaths.length > 0) {
    const fileList = attachmentPaths.map((p) => `- ${p}`).join("\n");
    text += `\n\n[使用者附件，請用 read_file 工具讀取]\n${fileList}`;
  }
  if (imageAttachments.length > 0) {
    const imgNote = imageAttachments.map(i => i.name).join(", ");
    text += text ? `\n\n[使用者上傳圖片：${imgNote}]` : `[使用者上傳圖片：${imgNote}]`;
  }

  // 訊息為空（只有 mention 沒有文字，且無附件）→ 忽略
  if (!text && imageAttachments.length === 0) {
    log.debug("[discord] 忽略：文字為空");
    return;
  }

  log.debug(`[discord] 通過過濾，text="${text.slice(0, 80)}" → 進入 debounce`);

  // Debounce：合併短時間內同一人的多則訊息
  debounce(message, text, imageAttachments, config, (combinedText, firstMessage, allImages) => { void (async () => { try {
    // 生成 turn_id，串聯 user input + AI response
    const turnId = randomUUID();

    // ── Message Trace 建立 ──────────────────────────────────────────────────
    const trace = MessageTrace.create(turnId, firstMessage.channelId, firstMessage.author.id, "discord");
    trace.recordInbound({
      messageId: firstMessage.id,
      text: combinedText,
      attachments: [...firstMessage.attachments.values()].length + allImages.length,
    });

    // 記錄 user 訊息到 history DB
    recordUserMessage({
      turnId,
      messageId: firstMessage.id,
      authorId: firstMessage.author.id,
      authorName: firstMessage.author.displayName,
      isBot: firstMessage.author.bot ?? false,
      channelId: firstMessage.channelId,
      guildId: firstMessage.guild?.id ?? null,
      content: combinedText,
      attachments: [...firstMessage.attachments.values()].map(a => a.name ?? a.url),
    });

    // ── Skill 攔截層（Phase 0） ────────────────────────────────────────────
    // 比對 skill trigger，有匹配直接執行，不送 LLM
    const skillMatch = matchSkill(combinedText);
    if (skillMatch) {
      const { skill, args } = skillMatch;
      log.info(`[discord] skill 命中：${skill.name} args="${args}"`);

      // Tier 權限檢查（平台就緒時才啟用）
      if (isPlatformReady()) {
        const { accountId } = resolveDiscordIdentity(
          firstMessage.author.id,
          config.admin?.allowedUserIds ?? [],
        );
        const tierCheck = getPlatformPermissionGate().checkTier(accountId, skill.tier);
        if (!tierCheck.allowed) {
          void firstMessage.reply(`❌ 權限不足：${tierCheck.reason ?? "tier 限制"}`);
          return;
        }
      }

      try {
        const skillAccountId = isPlatformReady()
          ? resolveDiscordIdentity(firstMessage.author.id, config.admin?.allowedUserIds ?? []).accountId
          : undefined;
        const { getBootAgentId } = await import("./core/agent-loader.js");
        const skillCtx = { args, message: firstMessage, channelId: firstMessage.channelId, authorId: firstMessage.author.id, accountId: skillAccountId, agentId: getBootAgentId(), config };

        if (skill.preflight) {
          const check = await skill.preflight(skillCtx);
          if (!check.ok) {
            void firstMessage.reply(`❌ ${skill.name} 無法執行：${check.reason ?? "前置檢查失敗"}`);
            return;
          }
        }
        const result = await skill.execute(skillCtx);
        await firstMessage.reply(result.text).catch((e) => log.warn(`[discord] skill ${skill.name} reply 失敗：${e instanceof Error ? e.message : String(e)}`));
      } catch (err) {
        trace.recordError(err instanceof Error ? err.message : String(err));
        log.warn(`[discord] skill ${skill.name} 執行失敗：${err instanceof Error ? err.message : String(err)}`);
        await firstMessage.reply(`❌ ${skill.name} 執行失敗`).catch((e) => log.warn(`[discord] skill error reply 失敗：${e instanceof Error ? e.message : String(e)}`));
      } finally {
        getTraceStore()?.append(trace.finalize());
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── SUB-5：Persistent Subagent Thread 路由 ────────────────────────────
    // 若此頻道是子 agent 綁定的 thread → 直接路由到子 session，跳過父 session
    if (isPlatformReady()) {
      const boundChildKey = getSubagentThreadBinding(firstMessage.channelId);
      if (boundChildKey) {
        const { accountId } = resolveDiscordIdentity(
          firstMessage.author.id,
          config.admin?.allowedUserIds ?? [],
        );
        const providerRegistry = getProviderRegistry();
        const provider = providerRegistry.resolve();
        // Trace 建立（subagent thread 路由）
        const threadTrace = MessageTrace.create(randomUUID(), firstMessage.channelId, accountId, "subagent");
        threadTrace.recordInbound({ messageId: firstMessage.id, text: combinedText, attachments: 0 });

        const threadGen = agentLoop(combinedText, {
          platform: "discord",
          channelId: firstMessage.channelId,
          accountId,
          provider,
          turnTimeoutMs: config.turnTimeoutMs,
          showToolCalls: config.showToolCalls as "all" | "summary" | "none",
          _sessionKeyOverride: boundChildKey,
          allowSpawn: false,
          trace: threadTrace,
        }, {
          sessionManager: getPlatformSessionManager(),
          permissionGate: getPlatformPermissionGate(),
          toolRegistry: getPlatformToolRegistry(),
          safetyGuard: getPlatformSafetyGuard(),
          eventBus,
        });
        void handleAgentLoopReply(threadGen, firstMessage, config);
        return;
      }
    }

    // ── CLI Bridge 路由：持久 Claude CLI process ──────────────────────────
    {
      const { getCliBridge } = await import("./cli-bridge/index.js");
      const cliBridge = getCliBridge(firstMessage.channelId);
      if (cliBridge) {
        try {
          const sender = cliBridge.getSender();
          if (sender.mode === "independent-bot") {
            // 獨立 bot 模式：頻道已綁定 CliBridge，由獨立 Client 自行監聽處理。
            // 主 bot 一律跳過 AgentLoop，避免同 token 雙 Client 雙路由導致主 bot
            // 用無記憶的 AgentLoop 回覆蓋掉 CliBridge 的上下文。
            log.debug(`[discord] CLI Bridge ${cliBridge.label} 是 independent-bot，頻道已綁定，跳過 AgentLoop`);
            return;
          }
          // main-bot fallback 模式 → 主 bot 代為路由
          const chCfg = cliBridge.getChannelConfig();
          const needsMention = chCfg.requireMention;
          const botUserId = sender.getBotUserId();
          const isMentioned = botUserId ? firstMessage.mentions.has(botUserId) : true;

          if (!needsMention || isMentioned) {
            await cliBridge.ensureAlive();
            const { handleCliBridgeReply, extractAttachments } = await import("./cli-bridge/reply.js");
            const { consumeBridgeInboundHistory } = await import("./cli-bridge/index.js");
            const { text: attachmentText, imageBlocks } = await extractAttachments(firstMessage);
            let fullText = combinedText + attachmentText;
            // 消費 inbound history（bridge scope）
            const inboundCtx = await consumeBridgeInboundHistory(cliBridge);
            if (inboundCtx) fullText = inboundCtx + "\n\n---\n" + fullText;
            log.info(`[discord] CLI Bridge 路由：${cliBridge.label} channel=${firstMessage.channelId}${attachmentText ? " +attachments" : ""}${imageBlocks.length ? ` +${imageBlocks.length}image` : ""}${inboundCtx ? " +inbound" : ""}`);
            void handleCliBridgeReply(cliBridge, fullText, firstMessage, config, cliBridge.getBridgeConfig(), imageBlocks);
            return;
          }
        } catch (err) {
          log.debug(`[discord] CLI Bridge 路由跳過（sender 未就緒）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── 路由：新平台路徑 vs 舊 Claude CLI 路徑 ────────────────────────────
    if (isPlatformReady()) {
      const { accountId, isGuest } = resolveDiscordIdentity(
        firstMessage.author.id,
        config.admin?.allowedUserIds ?? [],
      );
      if (isGuest) {
        ensureGuestAccount(accountId);

        // DM 未知使用者 → 提示配對流程（非阻斷）
        if (!firstMessage.guild) {
          try {
            const { getRegistrationManager } = await import("./accounts/registration.js");
            const pairResult = getRegistrationManager().createPairingCode("discord", firstMessage.author.id);
            if (pairResult.ok && pairResult.code) {
              void firstMessage.reply(
                `👋 你尚未有註冊帳號。配對碼：\`${pairResult.code}\`（5 分鐘內有效）\n` +
                `請將此碼告知管理員，由管理員執行：\n\`/account approve ${pairResult.code} --name <你的帳號名>\`\n\n` +
                `已有邀請碼？使用 \`/register <邀請碼> <帳號名>\``
              );
              return;
            }
          } catch (err) { log.debug(`[discord] registration 未初始化：${err instanceof Error ? err.message : String(err)}`); }
        }
      }

      // ── 帳號角色 + 當前專案 ─────────────────────────────────────────────
      let accountRole = isGuest ? "guest" : "member";
      let currentProjectId: string | undefined;
      try {
        const acct = getAccountRegistry().get(accountId);
        if (acct) {
          accountRole = acct.role;
          currentProjectId = acct.projects?.[0];
        }
      } catch (err) { log.debug(`[discord] account registry 無法存取：${err instanceof Error ? err.message : String(err)}`); }

      // 頻道綁定的專案優先於帳號的 currentProject
      const guildId = firstMessage.guild?.id ?? null;
      const coreChannelAccess = guildId
        ? getCoreChannelAccess(guildId, firstMessage.channelId)
        : undefined;
      const resolvedProjectId = coreChannelAccess?.boundProject ?? currentProjectId;

      // ── Rate Limit 檢查 ─────────────────────────────────────────────────
      const rateLimiter = getPlatformRateLimiter();
      if (rateLimiter) {
        const rlResult = rateLimiter.check(accountId, accountRole);
        if (!rlResult.allowed) {
          const waitSec = Math.ceil(rlResult.retryAfterMs / 1000);
          void firstMessage.reply(
            `⏳ 請求過於頻繁，請 ${waitSec} 秒後再試（角色 \`${accountRole}\` 每分鐘上限已達）`
          );
          log.info(`[discord] rate limit accountId=${accountId} role=${accountRole}`);
          return;
        }
        rateLimiter.record(accountId);
      }

      // ── Provider 路由（channel override > channel > role > project > default） ─
      const providerOverride = getChannelProviderOverride(firstMessage.channelId);
      const providerId = providerOverride ?? resolveProvider({
        channelAccess: coreChannelAccess,
        channelId: firstMessage.channelId,
        role: accountRole,
        projectId: resolvedProjectId,
      });
      const providerRegistry = getProviderRegistry();
      const provider = providerRegistry.get(providerId)
        ?? providerRegistry.resolve({ role: accountRole, projectId: resolvedProjectId });

      const isGroupChannel = !!firstMessage.guild;
      const prompt = combinedText;

      // ── ConversationLabel（比照 OpenClaw buildGuildLabel / buildDirectLabel）
      const channelName = "name" in firstMessage.channel ? (firstMessage.channel as { name: string }).name : null;
      const conversationLabel = isGroupChannel
        ? `${firstMessage.guild!.name} #${channelName ?? firstMessage.channelId} channel id:${firstMessage.channelId}`
        : `${firstMessage.author.displayName} user id:${firstMessage.author.id}`;

      // ── 統一管線（Memory Recall → Prompt Assembly → Trace） ─────────
      const channelSystemOverride = getChannelSystemOverride(firstMessage.channelId);
      const modePreset = getChannelModePreset(firstMessage.channelId);

      const pipeline = await runMessagePipeline({
        prompt,
        platform: "discord",
        trace,
        channelId: firstMessage.channelId,
        accountId,
        provider,
        projectId: resolvedProjectId,
        role: accountRole,
        isGroupChannel,
        speakerDisplay: firstMessage.author.displayName,
        modeName: getChannelMode(firstMessage.channelId),
        modePreset,
        activeMcpServers: ["discord"],
        memoryRecall: true,
        inboundHistory: true,
        sessionMemory: true,
        modeExtras: true,
        channelOverride: channelSystemOverride,
        conversationLabel,
      });

      const combinedSystemPrompt = pipeline.systemPrompt;
      const { inboundContext } = pipeline;

      // ── 中途插隊：soft-inject 取代 abort ─────────────────────────────────
      // 之前是 abort + clearQueue + 開新 turn → 丟脈絡、可能空回應 fallback。
      // 現在優先 push 到 active turn 的 interrupt queue，agent-loop 在下一 iter
      // 開頭會 drain 進 messages，模型自然接續處理「[使用者插話] xxx」。
      {
        const sessionKey = `discord:ch:${firstMessage.channelId}`;
        const { pushInterruptMessage } = await import("./core/agent-loop.js");
        if (pushInterruptMessage(sessionKey, combinedText)) {
          log.info(`[discord] 插話 soft-inject 到 active turn sessionKey=${sessionKey} text="${combinedText.slice(0, 60)}"`);
          // 把插話訊息歸入 active trace；當前剛建的 trace 廢棄不持久化（避免孤兒 live trace）
          const activeTrace = MessageTrace.findActiveBySession(sessionKey);
          if (activeTrace) activeTrace.recordInsertedInbound(combinedText);
          trace.discard();
          // 在 user 訊息加 👀 emoji 表示 bot 已收到，不開新 reply
          try { await firstMessage.react("👀"); } catch { /* 失敗忽略 */ }
          return;  // 不走後面的新 turn 流程
        }
        // 沒 active turn → 維持原本流程，啟新 turn
      }

      // ── AutoThread：為每條訊息建立獨立 Thread ────────────────────────────
      let replyThread: import("discord.js").AnyThreadChannel | null = null;
      let effectiveChannelId = firstMessage.channelId;
      const isAlreadyThread = (
        firstMessage.channel.type === ChannelType.PublicThread ||
        firstMessage.channel.type === ChannelType.PrivateThread ||
        firstMessage.channel.type === ChannelType.AnnouncementThread
      );
      if (access.autoThread && !isAlreadyThread) {
        try {
          const threadName = combinedText.replace(/\n/g, " ").slice(0, 50) || "對話";
          replyThread = await firstMessage.startThread({
            name: threadName,
            autoArchiveDuration: 60,
          });
          effectiveChannelId = replyThread.id;
          log.debug(`[discord] autoThread 建立 threadId=${replyThread.id} name="${threadName}"`);
        } catch (err) {
          log.warn(`[discord] autoThread 建立失敗，改用原頻道：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Ack Reaction：⏳ queued ──────────────────────────────────────────
      void firstMessage.react("⏳").catch(() => { /* 無 permission 時靜默 */ });

      const { getBootAgentId, getBootIsAdmin } = await import("./core/agent-loader.js");
      const gen = agentLoop(prompt, {
        platform: "discord",
        channelId: effectiveChannelId,
        accountId,
        agentId: getBootAgentId(),
        isAdmin: getBootIsAdmin(),
        isGroupChannel,
        speakerDisplay: firstMessage.author.displayName,
        speakerRole: accountRole,
        provider,
        systemPrompt: combinedSystemPrompt || undefined,
        inboundContext,
        turnTimeoutMs: config.turnTimeoutMs,
        showToolCalls: config.showToolCalls as "all" | "summary" | "none",
        ...(pipeline.sessionMemoryOpts ? { sessionMemory: pipeline.sessionMemoryOpts } : {}),
        ...(config.safety?.execApproval?.enabled && config.safety.execApproval.dmUserId ? {
          execApproval: {
            enabled: true,
            dmUserId: config.safety.execApproval.dmUserId,
            timeoutMs: config.safety.execApproval.timeoutMs,
            allowedPatterns: config.safety.execApproval.allowedPatterns ?? [],
            sendDm: async (dmUserId: string, content: string) => {
              const dmUser = await message.client.users.fetch(dmUserId);
              await dmUser.send(content);
            },
          },
        } : {}),
        ...(allImages.length > 0 ? { imageAttachments: allImages } : {}),
        ...(() => {
          const channelThinking = getChannelThinking(firstMessage.channelId);
          const thinking = channelThinking ?? getModeThinking(modePreset);
          return {
            ...(thinking ? { thinking } : {}),
            modePreset,
            modeName: getChannelMode(firstMessage.channelId),
          };
        })(),
        trace: pipeline.trace,
        promptBreakdownHints: pipeline.promptBreakdownHints,
      }, {
        sessionManager: getPlatformSessionManager(),
        permissionGate: getPlatformPermissionGate(),
        toolRegistry: getPlatformToolRegistry(),
        safetyGuard: getPlatformSafetyGuard(),
        eventBus,
      });

      // ── Ack Reaction 包裝 gen ────────────────────────────────────────────
      async function* withAckReactions(source: typeof gen) {
        let thinking = false;
        let toolActive = false;
        for await (const evt of source) {
          if (evt.type === "tool_start" && !toolActive) {
            toolActive = true;
            if (thinking) {
              void firstMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
              thinking = false;
            }
            void firstMessage.react("🔧").catch(() => {});
          } else if (!thinking && evt.type === "text_delta") {
            thinking = true;
            void firstMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
            void firstMessage.react("🤔").catch(() => {});
          }
          if (evt.type === "done") {
            void firstMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
            void firstMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
            void firstMessage.reactions.cache.get("🔧")?.remove().catch(() => {});
          } else if (evt.type === "error") {
            void firstMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
            void firstMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
            void firstMessage.reactions.cache.get("🔧")?.remove().catch(() => {});
            void firstMessage.react("❌").catch(() => {});
          }
          yield evt;
        }
      }

      void handleAgentLoopReply(withAckReactions(gen), firstMessage, config, replyThread ? { threadChannel: replyThread } : undefined);
    }
  } catch (err) {
    log.error(`[discord] debounce handler 未預期錯誤：${err instanceof Error ? err.message : String(err)}`);
    void firstMessage.react("❌").catch(() => {});
  } })(); });
}
