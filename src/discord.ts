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
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./core/config.js";
import { config, getChannelAccess, loadBaseSystemPrompt } from "./core/config.js";
import { enqueue } from "./session.js";
import { createReplyHandler } from "./reply.js";
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
  getPlatformMemoryEngine,
  getPlatformProjectManager,
  getPlatformRateLimiter,
  getPlatformMemoryRoot,
} from "./core/platform.js";
import { getInboundHistoryStore, type InboundEntry } from "./discord/inbound-history.js";
import { resolveProvider, getChannelAccess as getCoreChannelAccess } from "./core/config.js";
import { getProviderRegistry } from "./providers/registry.js";
import { agentLoop } from "./core/agent-loop.js";
import { getChannelThinking } from "./skills/builtin/think.js";
import { getChannelModePreset, getModeThinking } from "./core/mode.js";
import { getChannelProviderOverride } from "./skills/builtin/use.js";
import { getChannelSystemOverride } from "./skills/builtin/system.js";
import { eventBus } from "./core/event-bus.js";
import { handleAgentLoopReply } from "./core/reply-handler.js";
import { setDiscordClient, getSubagentThreadBinding } from "./core/subagent-discord-bridge.js";
import { parseApprovalReply, parseApprovalButtonId, resolveApproval, setApprovalDiscordClient } from "./core/exec-approval.js";
import { abortRunningTurn } from "./skills/builtin/stop.js";
import { MessageTrace } from "./core/message-trace.js";

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

    onFire(combinedText, firstMessage, allImages);
  }, config.debounceMs);

  debounceTimers.set(key, timer);
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

  // SUB-5：持久子 agent Discord 通知 + thread 建立用
  client.once("clientReady", () => {
    setDiscordClient(client);
    setApprovalDiscordClient(client);
  });

  // Exec-approval 按鈕互動處理
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isButton()) return;
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
  // NOTE: bot 自身訊息永遠忽略（不論 allowBot 設定），避免自我迴圈
  if (message.author.id === message.client.user?.id) {
    return;
  }

  log.debug(`[discord] 收到訊息 from=${message.author.tag} channel=${message.channelId} guild=${message.guild?.id ?? "DM"} content="${message.content}"`);


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

  // @here / @everyone 群組廣播過濾
  if (access.blockGroupMentions && message.mentions.everyone) {
    log.debug(`[discord] 忽略：群組 mention（@here/@everyone），blockGroupMentions=true`);
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
      // Inbound History：記錄未被 mention 的訊息，供下次觸發時注入（僅 inject.enabled=true 時才記）
      const inboundStore = getInboundHistoryStore();
      const inboundEnabled = config.inboundHistory?.inject?.enabled ?? false;
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
        inboundStore.append(message.channelId, entry);
        log.debug(`[discord] inbound-history append channel=${message.channelId}`);
      }
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
  debounce(message, text, imageAttachments, config, (combinedText, firstMessage, allImages) => { void (async () => {
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
        const skillCtx = { args, message: firstMessage, channelId: firstMessage.channelId, authorId: firstMessage.author.id, accountId: skillAccountId, config };

        if (skill.preflight) {
          const check = await skill.preflight(skillCtx);
          if (!check.ok) {
            void firstMessage.reply(`❌ ${skill.name} 無法執行：${check.reason ?? "前置檢查失敗"}`);
            return;
          }
        }
        const result = await skill.execute(skillCtx);
        void firstMessage.reply(result.text);
      } catch (err) {
        log.warn(`[discord] skill ${skill.name} 執行失敗：${err instanceof Error ? err.message : String(err)}`);
        void firstMessage.reply(`❌ ${skill.name} 執行失敗`);
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
          } catch { /* registration not initialized, fall through */ }
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
      } catch { /* account registry not available */ }

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

      // ── Base System Prompt（CATCLAW.md → AGENTS.md，共用函式） ──────────
      const baseSystemPrompt = loadBaseSystemPrompt();
      if (baseSystemPrompt) log.debug(`[discord] 載入 base system prompt (${baseSystemPrompt.length} 字)`);

      // ── 記憶 Recall（三層：全域+專案+個人） ─────────────────────────────
      trace.recordContextStart();
      let systemPromptFromMemory = "";
      const memEngine = getPlatformMemoryEngine();
      if (memEngine) {
        const recallStartMs = Date.now();
        try {
          const recallResult = await memEngine.recall(prompt, {
            accountId,
            projectId: resolvedProjectId,
            channelId: firstMessage.channelId,
          });
          if (recallResult.fragments.length > 0) {
            const ctx = memEngine.buildContext(recallResult.fragments, prompt, recallResult.blindSpot);
            systemPromptFromMemory = ctx.text;
            log.debug(`[discord] 記憶注入 ${recallResult.fragments.length} 個 atom (${ctx.tokenCount} tokens)`);
            trace.recordMemoryRecall({
              durationMs: Date.now() - recallStartMs,
              fragmentCount: recallResult.fragments.length,
              atomNames: recallResult.fragments.map(f => f.atom.name),
              injectedTokens: ctx.tokenCount,
              vectorSearch: !recallResult.degraded,
              degraded: recallResult.degraded,
            });
          }
        } catch (err) {
          log.debug(`[discord] 記憶 recall 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── 當前日期/時間注入 ────────────────────────────────────────────────────
      const nowStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
      const dateBlock = `[系統資訊] 當前時間（Asia/Taipei）：${nowStr}`;

      // ── System Prompt 組裝（不含 inbound history） ──────────────────────
      const channelSystemOverride = getChannelSystemOverride(firstMessage.channelId);

      // Mode prompt extras（workspace/prompts/{name}.md）
      const modePreset = getChannelModePreset(firstMessage.channelId);
      let modeExtrasBlock = "";
      if (modePreset.systemPromptExtras?.length) {
        const { resolveWorkspaceDir } = await import("./core/config.js");
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const promptsDir = join(resolveWorkspaceDir(), "prompts");
        const parts: string[] = [];
        for (const name of modePreset.systemPromptExtras) {
          const p = join(promptsDir, `${name}.md`);
          if (existsSync(p)) {
            try { parts.push(readFileSync(p, "utf-8")); } catch { /* skip */ }
          }
        }
        if (parts.length > 0) modeExtrasBlock = parts.join("\n\n");
      }

      const combinedSystemPrompt = [baseSystemPrompt, systemPromptFromMemory, channelSystemOverride, modeExtrasBlock, dateBlock].filter(Boolean).join("\n\n");

      // ── Inbound History（注入到 messages 層，非 system prompt）──────────
      let inboundContext: string | undefined;
      const inboundStore = getInboundHistoryStore();
      const inboundCfg = config.inboundHistory;
      if (inboundStore && inboundCfg?.enabled !== false) {
        try {
          const ctx = await inboundStore.consumeForInjection(
            firstMessage.channelId,
            {
              enabled: true,
              fullWindowHours: inboundCfg?.fullWindowHours ?? 24,
              decayWindowHours: inboundCfg?.decayWindowHours ?? 168,
              bucketBTokenCap: inboundCfg?.bucketBTokenCap ?? 600,
              decayIITokenCap: inboundCfg?.decayIITokenCap ?? 300,
              inject: { enabled: inboundCfg?.inject?.enabled ?? false },
            },
          );
          if (ctx) {
            inboundContext = ctx.text;
            trace.recordInboundHistory({
              entriesCount: ctx.entriesCount,
              bucketA: ctx.bucketA,
              bucketB: ctx.bucketB,
              tokens: Math.ceil(ctx.text.length / 4),
              decayIIApplied: false,
            });
          }
        } catch (err) {
          log.debug(`[discord] inbound-history inject 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── 中途插隊（interruptOnNewMessage）───────────────────────────────
      // 若此頻道設定了 interruptOnNewMessage=true，新訊息到來時自動 abort 正在執行的 turn
      if (access.interruptOnNewMessage) {
        const sessionKey = `discord:ch:${firstMessage.channelId}`;
        if (abortRunningTurn(sessionKey)) {
          getPlatformSessionManager().clearQueue(sessionKey);
          log.debug(`[discord] interruptOnNewMessage：已中斷 turn sessionKey=${sessionKey}`);
        }
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

      // Trace: Context 組裝完成
      {
        const sysTokens = Math.ceil((combinedSystemPrompt?.length ?? 0) / 4);
        trace.recordContextEnd({
          systemPromptTokens: sysTokens,
          historyTokens: 0,  // 精確值在 agent-loop CE 之後才知道
          historyMessageCount: 0,
          totalContextTokens: sysTokens,
        });
      }

      // ── Ack Reaction：⏳ queued ──────────────────────────────────────────
      void firstMessage.react("⏳").catch(() => { /* 無 permission 時靜默 */ });

      const memoryRoot = getPlatformMemoryRoot();
      const gen = agentLoop(prompt, {
        platform: "discord",
        channelId: effectiveChannelId,
        accountId,
        isGroupChannel,
        speakerDisplay: firstMessage.author.displayName,
        speakerRole: accountRole,
        provider,
        systemPrompt: combinedSystemPrompt || undefined,
        inboundContext,
        turnTimeoutMs: config.turnTimeoutMs,
        showToolCalls: config.showToolCalls as "all" | "summary" | "none",
        ...(memoryRoot && config.memory.sessionMemory?.enabled !== false ? {
          sessionMemory: {
            enabled: true,
            intervalTurns: config.memory.sessionMemory?.intervalTurns ?? 10,
            maxHistoryTurns: config.memory.sessionMemory?.maxHistoryTurns ?? 15,
            memoryDir: memoryRoot,
          },
        } : {}),
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
          // thinking 優先：/think 手動設定 > mode preset
          const channelThinking = getChannelThinking(firstMessage.channelId);
          const modePreset = getChannelModePreset(firstMessage.channelId);
          const thinking = channelThinking ?? getModeThinking(modePreset);
          return {
            ...(thinking ? { thinking } : {}),
            modePreset,
          };
        })(),
        trace,
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
  })(); });
}
