/**
 * @file cli-bridge/reply.ts
 * @description CLI Bridge → Discord 回覆處理
 *
 * 消費 CliBridge.send() 回傳的 TurnHandle.events，串流回覆到 Discord。
 * 透過 BridgeSender 抽象層支援三種發送模式：
 * - IndependentBotSender（獨立 bot token）
 * - WebhookSender（webhook 偽裝）
 * - MainBotSender（主 bot fallback）
 *
 * 特點：
 * - Streaming edit 模式（live-edit Discord message）
 * - Discord 送達失敗 → 重試 3 次（指數退避 1s, 2s, 4s）
 * - 送達狀態回寫 StdoutLogger
 * - tool_call / thinking 可選顯示
 * - control_request → Discord 按鈕（Approve/Deny）
 * - 附件支援（Discord attachment → 文字描述附加到 stdin）
 * - rate limit 保護（可設定 edit interval）
 */

import {
  type Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ComponentType,
} from "discord.js";
import { log } from "../logger.js";
import type { CliBridge } from "./bridge.js";
import type { CliBridgeEvent, StdinImageBlock } from "./types.js";
import type { BridgeConfig } from "../core/config.js";
import type { CliBridgeConfig } from "./types.js";
import type { BridgeSender } from "./discord-sender.js";

const SUPPORTED_IMAGE_TYPES: Record<string, StdinImageBlock["source"]["media_type"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic API 單張上限 5MB

/** 從 binary magic bytes 偵測真實圖片格式（Discord contentType 不可靠） */
function detectImageMediaType(buf: Buffer): StdinImageBlock["source"]["media_type"] | null {
  if (buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  // GIF: 47 49 46 (GIF)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

const TEXT_LIMIT = 2000;
const RETRY_DELAYS = [1000, 2000, 4000];

// ── 工具函式 ────────────────────────────────────────────────────────────────

function closeFenceIfOpen(text: string): string {
  const fenceCount = (text.match(/```/g) ?? []).length;
  return fenceCount % 2 !== 0 ? text + "\n```" : text;
}

/**
 * 把長文切成多段以符合 Discord 2000 字上限。
 * - 優先在換行處切，找不到就硬切
 * - 跨段 code fence 自動補 open/close，避免語法斷裂
 * - 預留 20 字空間給 fence 標記
 */
function splitForDiscord(content: string, limit = TEXT_LIMIT): string[] {
  if (content.length <= limit) return content.length ? [content] : [];

  const SAFE = limit - 20;
  const chunks: string[] = [];
  let pos = 0;

  while (pos < content.length) {
    const remaining = content.length - pos;
    if (remaining <= limit) {
      chunks.push(content.slice(pos));
      break;
    }
    let cut = content.lastIndexOf("\n", pos + SAFE);
    if (cut <= pos + Math.floor(SAFE / 2)) {
      cut = pos + SAFE;
    }
    chunks.push(content.slice(pos, cut));
    pos = cut;
    if (content[pos] === "\n") pos++;
  }

  // fence-balance pass：跨段補 open/close
  let inFence = false;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const fenceCount = (chunk.match(/```/g) ?? []).length;
    const newState: boolean = inFence !== (fenceCount % 2 !== 0);
    let rebuilt = chunk;
    if (inFence) rebuilt = "```\n" + rebuilt;
    if (newState) rebuilt = rebuilt + "\n```";
    chunks[i] = rebuilt;
    inFence = newState;
  }

  return chunks;
}

async function retrySend(
  fn: () => Promise<void>,
  maxRetries = 3,
): Promise<boolean> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (i < maxRetries) {
        const delay = RETRY_DELAYS[i] ?? 4000;
        log.debug(`[cli-bridge-reply] 送達失敗，${delay}ms 後重試 (${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        log.warn(`[cli-bridge-reply] 送達失敗（已重試 ${maxRetries} 次）：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
  }
  return false;
}

/**
 * 從 Discord Message 提取附件：
 * - 圖片（支援的 media_type）→ 下載並 base64 編碼成 StdinImageBlock
 * - 其他檔案 → 文字描述（URL）
 * - 圖片下載失敗或超過 5MB → 降級為文字描述
 */
export async function extractAttachments(msg: Message): Promise<{ text: string; imageBlocks: StdinImageBlock[] }> {
  if (!msg.attachments.size) return { text: "", imageBlocks: [] };
  const textParts: string[] = [];
  const imageBlocks: StdinImageBlock[] = [];

  for (const [, att] of msg.attachments) {
    const ct = (att.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const mediaType = SUPPORTED_IMAGE_TYPES[ct];
    const sizeKb = Math.round((att.size ?? 0) / 1024);
    const descPrefix = `[附件: ${att.name} (${att.contentType ?? "unknown"}, ${sizeKb}KB)`;

    if (mediaType && (att.size ?? 0) <= MAX_IMAGE_BYTES) {
      try {
        const resp = await fetch(att.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`下載後超過 ${MAX_IMAGE_BYTES} bytes`);
        // 用 magic bytes 偵測真實格式（Discord contentType 可能不正確，例如 webp 實為 png）
        const actualType = detectImageMediaType(buf) ?? mediaType;
        if (actualType !== mediaType) {
          log.info(`[cli-bridge-reply] 圖片格式校正：Discord 報 ${ct} → 實際 ${actualType}（${att.name}）`);
        }
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: actualType, data: buf.toString("base64") },
        });
        textParts.push(`${descPrefix} 已以 inline image 附上]`);
        continue;
      } catch (err) {
        log.warn(`[cli-bridge-reply] 圖片下載失敗，改用 URL 文字：${att.url} (${err instanceof Error ? err.message : String(err)})`);
      }
    } else if (mediaType && (att.size ?? 0) > MAX_IMAGE_BYTES) {
      log.warn(`[cli-bridge-reply] 圖片超過 ${MAX_IMAGE_BYTES} bytes，改用 URL 文字：${att.name}`);
    }

    textParts.push(`${descPrefix} URL: ${att.url}]`);
  }

  return { text: textParts.length ? "\n" + textParts.join("\n") : "", imageBlocks };
}

/** @deprecated 保留給尚未遷移的呼叫端；新路徑請用 extractAttachments */
export function extractAttachmentText(msg: Message): string {
  if (!msg.attachments.size) return "";
  const parts: string[] = [];
  for (const [, att] of msg.attachments) {
    parts.push(`[附件: ${att.name} (${att.contentType ?? "unknown"}, ${Math.round((att.size ?? 0) / 1024)}KB) URL: ${att.url}]`);
  }
  return "\n" + parts.join("\n");
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 消費 CliBridge turn events，串流回覆到 Discord
 */
export async function handleCliBridgeReply(
  bridge: CliBridge,
  text: string,
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
  cliBridgeConfig?: CliBridgeConfig,
  imageBlocks?: StdinImageBlock[],
  senderOverride?: import("./discord-sender.js").BridgeSender,
  sourceChannelId?: string,
): Promise<void> {
  const sender = senderOverride ?? bridge.getSender();
  const handle = bridge.send(text, "discord", {
    user: originalMessage.author.displayName || originalMessage.author.username,
    ts: new Date(originalMessage.createdTimestamp).toISOString(),
    imageBlocks,
    sourceChannelId,
  });
  const turnId = handle.turnId;
  const stdoutLogger = bridge.getStdoutLogger();
  const showToolCalls = bridgeConfig.showToolCalls;
  const showThinking = cliBridgeConfig?.showThinking ?? false;
  const editIntervalMs = cliBridgeConfig?.editIntervalMs ?? 800;
  const intermediateStyle = cliBridgeConfig?.showIntermediateText ?? "none";

  let buffer = "";
  let thinkingBuffer = "";
  const state = { editMsg: null as Message | null };
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editBusy = false;
  let isFirst = true;
  let toolHintSent = false;

  // Intermediate 累積（quote/spoiler 模式：所有中間文字 edit 同一條訊息）
  let intermediateMsg: Message | null = null;
  let intermediateAccum = "";

  // Rate limit 計數器
  let editCount = 0;
  let lastEditTime = 0;

  // Typing indicator — turnDone flag 防止 generator 掛住時 typing 永遠不停
  let turnDone = false;
  sender.sendTyping();
  let typingInterval: ReturnType<typeof setInterval> | null = setInterval(() => { if (!turnDone) sender.sendTyping(); }, 8_000);
  const stopTyping = () => { turnDone = true; if (typingInterval) { clearInterval(typingInterval); typingInterval = null; } };
  const resumeTyping = () => { if (turnDone) return; if (typingInterval) { clearInterval(typingInterval); typingInterval = null; } sender.sendTyping(); typingInterval = setInterval(() => { if (!turnDone) sender.sendTyping(); }, 8_000); };
  // Safety: 最多 10 分鐘 typing（防 generator 掛住永遠不 stopTyping）
  const maxTypingTimer = setTimeout(() => { if (!turnDone) { log.warn(`[cli-bridge-reply] turn=${turnId.slice(0, 8)} typing safety timeout (10min)`); stopTyping(); } }, 10 * 60 * 1000);

  // ── Intermediate text formatting ─────────────────────────────────────────

  function formatIntermediate(text: string): string {
    if (intermediateStyle === "none") return "";
    if (intermediateStyle === "spoiler") {
      const trimmed = text.trim().slice(0, TEXT_LIMIT - 10);
      return `||${trimmed.replaceAll("||", "| |")}||`;
    }
    if (intermediateStyle === "quote") {
      return text.trim().split("\n").map(l => `> ${l}`).join("\n");
    }
    return text; // "normal"
  }

  /** tool_call 到來時 flush 中間推理文字（累積到同一條訊息） */
  async function flushIntermediateBuffer(): Promise<void> {
    if (!buffer.trim()) { buffer = ""; return; }
    cancelEditTimer();
    const raw = closeFenceIfOpen(buffer);
    buffer = "";

    if (intermediateStyle === "none") {
      // style=none → 刪除 placeholder（如有）
      if (state.editMsg) { try { await state.editMsg.delete(); } catch { /* */ } }
      state.editMsg = null;
      return;
    }

    // 累積到同一條訊息
    intermediateAccum += (intermediateAccum ? "\n" : "") + raw.trim();
    const formatted = formatIntermediate(intermediateAccum);

    // 超過單條上限 → 定稿目前訊息，開新的
    if (formatted.length > TEXT_LIMIT - 100 && intermediateMsg) {
      const prevFormatted = formatIntermediate(intermediateAccum.slice(0, -raw.trim().length).trim());
      if (prevFormatted) {
        try { await sender.edit(intermediateMsg, prevFormatted.slice(0, TEXT_LIMIT)); } catch { /* */ }
      }
      intermediateMsg = null;
      intermediateAccum = raw.trim();
    }

    const safe = formatIntermediate(intermediateAccum).slice(0, TEXT_LIMIT);

    if (intermediateMsg) {
      // edit 既有的中間訊息
      try { await sender.edit(intermediateMsg, safe); } catch { /* */ }
    } else if (state.editMsg) {
      // 首次 flush：複用 streaming edit 的訊息
      intermediateMsg = state.editMsg;
      try { await sender.edit(intermediateMsg, safe); } catch { /* */ }
    } else {
      // 沒有既有訊息（例如前一條已滿），建新的
      try {
        intermediateMsg = await sender.send(safe);
      } catch { /* */ }
    }

    state.editMsg = null;
  }

  // ── Streaming edit helpers ──────────────────────────────────────────────

  async function doEdit(): Promise<void> {
    if (!state.editMsg || !buffer.trim() || editBusy) return;

    // Rate limit 保護
    const now = Date.now();
    if (now - lastEditTime < editIntervalMs) return;

    const content = closeFenceIfOpen(buffer);
    const safe = content.length > TEXT_LIMIT ? content.slice(0, TEXT_LIMIT - 3) + "…" : content;
    try {
      editBusy = true;
      lastEditTime = now;
      editCount++;
      await sender.edit(state.editMsg, safe);
    } catch { /* rate-limited or deleted */ }
    finally { editBusy = false; }
  }

  function scheduleEdit(): void {
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      void doEdit();
    }, editIntervalMs);
  }

  function cancelEditTimer(): void {
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
  }

  async function initEditMsg(): Promise<void> {
    try {
      if (isFirst) {
        state.editMsg = await sender.reply(originalMessage, "...");
        isFirst = false;
      } else {
        state.editMsg = await sender.send("...");
      }
    } catch (err) {
      log.debug(`[cli-bridge-reply] initEditMsg 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function sendText(content: string): Promise<void> {
    if (!content.trim()) return;
    if (isFirst) {
      await sender.reply(originalMessage, content);
      isFirst = false;
    } else {
      await sender.send(content);
    }
  }

  // ── Ack reaction（始終用原始訊息的 reaction）──
  void originalMessage.react("⏳").catch(() => {});

  // ── 消費事件 ──────────────────────────────────────────────────────────────

  let discordDelivery: "success" | "failed" | "pending" = "pending";
  let discordMessageId: string | undefined;

  try {
    for await (const evt of handle.events) {

      // ── text_delta ──
      if (evt.type === "text_delta") {
        // 確保 typing indicator 在運作
        if (!typingInterval) resumeTyping();
        buffer += evt.text;

        // none 模式：只累積 buffer，不建立 editMsg（避免 "..." 閃爍）
        if (intermediateStyle === "none") {
          if (!toolHintSent && !state.editMsg) {
            void originalMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
            void originalMessage.react("🤔").catch(() => {});
          }
          continue;
        }

        // 移除 ⏳，加 🤔
        if (!state.editMsg) {
          void originalMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
          void originalMessage.react("🤔").catch(() => {});
          await initEditMsg();
        }
        scheduleEdit();

        // 超過 TEXT_LIMIT → 送出當前 buffer，開新 edit message
        if (buffer.length > TEXT_LIMIT - 100) {
          cancelEditTimer();
          const content = closeFenceIfOpen(buffer);
          const chunks = splitForDiscord(content);
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            try {
              if (i === 0 && state.editMsg) {
                await sender.edit(state.editMsg, chunk);
              } else {
                await sender.send(chunk);
              }
            } catch { /* */ }
          }
          buffer = "";
          state.editMsg = null;
          await initEditMsg();
        }
        continue;
      }

      // ── thinking_delta ──
      if (evt.type === "thinking_delta") {
        if (showThinking) {
          thinkingBuffer += evt.text;
        }
        continue;
      }

      // ── tool_call ──
      if (evt.type === "tool_call") {
        // flush 中間推理文字（quote/spoiler/none）
        if (intermediateStyle !== "normal") {
          await flushIntermediateBuffer();
        }

        // 如果有累積的 thinking，先送出
        if (showThinking && thinkingBuffer.trim()) {
          const thinkText = thinkingBuffer.length > TEXT_LIMIT - 20
            ? thinkingBuffer.slice(0, TEXT_LIMIT - 20) + "…"
            : thinkingBuffer;
          await sendText(`||${thinkText}||`);
          thinkingBuffer = "";
        }

        if (showToolCalls !== "none" && !toolHintSent) {
          void originalMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
          void originalMessage.react("🔧").catch(() => {});
          toolHintSent = true;
        }
        if (showToolCalls === "all") {
          await sendText(`🔧 \`${evt.title}\``);
        }
        continue;
      }

      // ── tool_result ──
      if (evt.type === "tool_result") {
        if (showToolCalls === "all") {
          const durStr = evt.duration_ms ? ` (${Math.round(evt.duration_ms / 1000)}s)` : "";
          await sendText(`✅ \`${evt.title}\`${durStr}`);
        }
        continue;
      }

      // ── control_request ──
      if (evt.type === "control_request") {
        await handleControlRequest(evt, bridge, originalMessage, sender);
        continue;
      }

      // ── idle_timeout_ask — 讓使用者選擇超時行為 ──
      if (evt.type === "status" && evt.subtype === "idle_timeout_ask") {
        stopTyping();
        await handleTimeoutAsk(bridge, handle.turnId, originalMessage, sender);
        continue;
      }

      // ── idle_timeout_warn — 僅通知 ──
      if (evt.type === "status" && evt.subtype === "idle_timeout_warn") {
        await sendText(`⏰ idle 超時警告（持續等待中）`);
        continue;
      }

      // ── result ──
      if (evt.type === "result") {
        // 立即停止 typing — 不等 finally，避免 async 操作期間 interval 再觸發 sendTyping
        stopTyping();
        clearTimeout(maxTypingTimer);

        // 送出殘留的 thinking
        if (showThinking && thinkingBuffer.trim()) {
          const thinkText = thinkingBuffer.length > TEXT_LIMIT - 20
            ? thinkingBuffer.slice(0, TEXT_LIMIT - 20) + "…"
            : thinkingBuffer;
          await sendText(`||${thinkText}||`);
          thinkingBuffer = "";
        }

        // 最後 flush
        cancelEditTimer();
        const hasFinalText = buffer.trim().length > 0;
        if (hasFinalText && intermediateStyle !== "normal" && intermediateMsg && state.editMsg === intermediateMsg) {
          // intermediate 模式：最終回覆是新文字，不要 edit 中間訊息，送新訊息
          const chunks = splitForDiscord(closeFenceIfOpen(buffer));
          let allOk = true;
          for (const chunk of chunks) {
            const ok = await retrySend(async () => { await sendText(chunk); });
            if (!ok) allOk = false;
          }
          discordDelivery = allOk ? "success" : "failed";
        } else if (hasFinalText && state.editMsg) {
          const final = closeFenceIfOpen(buffer);
          const msg = state.editMsg;
          const chunks = splitForDiscord(final);
          let allOk = true;
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const ok = await retrySend(async () => {
              if (i === 0) await sender.edit(msg, chunk);
              else await sender.send(chunk);
            });
            if (!ok) allOk = false;
          }
          discordDelivery = allOk ? "success" : "failed";
          discordMessageId = msg.id;
        } else if (hasFinalText) {
          const chunks = splitForDiscord(buffer);
          let allOk = true;
          for (const chunk of chunks) {
            const ok = await retrySend(async () => { await sendText(chunk); });
            if (!ok) allOk = false;
          }
          discordDelivery = allOk ? "success" : "failed";
        } else if (evt.text) {
          // buffer 為空但 result 帶有文字（常見於 permission deny 後 CLI 直接結束 turn）
          const chunks = splitForDiscord(evt.text);
          let allOk = true;
          for (const chunk of chunks) {
            const ok = await retrySend(async () => { await sendText(chunk); });
            if (!ok) allOk = false;
          }
          discordDelivery = allOk ? "success" : "failed";
        } else if (evt.is_error) {
          // 無文字但標記為錯誤 → 送通用提示
          await retrySend(async () => { await sendText("⚠️ turn 結束（無回應文字）"); });
          discordDelivery = "failed";
        } else {
          discordDelivery = "success";
        }

        // 清理 reactions
        void originalMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
        void originalMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
        void originalMessage.reactions.cache.get("🔧")?.remove().catch(() => {});
        void originalMessage.react("✅").catch(() => {});
        break;
      }

      // ── error ──
      if (evt.type === "error") {
        stopTyping();
        clearTimeout(maxTypingTimer);
        cancelEditTimer();
        const errText = `❌ ${evt.message}`;
        const ok = await retrySend(() => sendText(errText));
        discordDelivery = ok ? "failed" : "failed";

        void originalMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
        void originalMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
        void originalMessage.react("❌").catch(() => {});
        break;
      }
    }
  } catch (err) {
    log.error(`[cli-bridge-reply] 事件消費錯誤：${err instanceof Error ? err.message : String(err)}`);
    discordDelivery = "failed";
  } finally {
    stopTyping();
    clearTimeout(maxTypingTimer);
    cancelEditTimer();

    // 更新 turn 送達狀態
    stdoutLogger.updateTurnDelivery(
      turnId,
      discordDelivery,
      discordMessageId,
      discordDelivery === "failed" ? "Discord 送達失敗" : undefined,
    );

    log.info(`[cli-bridge-reply] turn=${turnId.slice(0, 8)} delivery=${discordDelivery} edits=${editCount}`);
  }
}

// ── control_request 處理 ────────────────────────────────────────────────────

async function handleControlRequest(
  evt: CliBridgeEvent & { type: "control_request" },
  bridge: CliBridge,
  originalMessage: Message,
  sender: BridgeSender,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cb-approve-${evt.requestId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cb-deny-${evt.requestId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  const promptMsg = await sender.sendComponents({
    content: `🔐 **權限請求**\n工具：\`${evt.tool}\`\n${evt.description}`,
    components: [row],
  });

  // 等待按鈕互動（60 秒超時）
  try {
    const interaction = await promptMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => i.user.id === originalMessage.author.id,
      time: 60_000,
    });

    const allowed = interaction.customId.startsWith("cb-approve-");

    // 回寫 stdin
    bridge.sendControlResponse(evt.requestId, allowed);

    await interaction.update({
      content: `🔐 **權限請求** → ${allowed ? "✅ 已允許" : "❌ 已拒絕"}\n工具：\`${evt.tool}\`\n${evt.description}`,
      components: [],
    });

    log.info(`[cli-bridge-reply] control_request ${evt.requestId} → ${allowed ? "approved" : "denied"}`);
  } catch {
    // 超時 → 自動拒絕
    bridge.sendControlResponse(evt.requestId, false);
    await sender.editComponents(promptMsg, {
      content: `🔐 **權限請求** → ⏰ 超時（自動拒絕）\n工具：\`${evt.tool}\`\n${evt.description}`,
      components: [],
    }).catch(() => {});
    log.info(`[cli-bridge-reply] control_request ${evt.requestId} → timeout (denied)`);
  }
}

// ── idle timeout 互動處理 ──────────────────────────────────────────────────

async function handleTimeoutAsk(
  bridge: CliBridge,
  turnId: string,
  originalMessage: Message,
  sender: BridgeSender,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cb-timeout-wait-${turnId}`)
      .setLabel("繼續等")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cb-timeout-interrupt-${turnId}`)
      .setLabel("中斷")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cb-timeout-restart-${turnId}`)
      .setLabel("重啟")
      .setStyle(ButtonStyle.Danger),
  );

  const msg = await sender.sendComponents({
    content: `⏰ **Idle 超時** — CLI 已一段時間沒有回應，要怎麼處理？`,
    components: [row],
  });

  try {
    const interaction = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => i.user.id === originalMessage.author.id,
      time: 120_000,
    });

    const id = interaction.customId;
    let action: "wait" | "interrupt" | "restart";
    let label: string;
    if (id.includes("-wait-")) { action = "wait"; label = "繼續等待"; }
    else if (id.includes("-restart-")) { action = "restart"; label = "重啟"; }
    else { action = "interrupt"; label = "中斷"; }

    bridge.executeTimeoutAction(turnId, action);

    await interaction.update({
      content: `⏰ **Idle 超時** → ${label}`,
      components: [],
    });

    log.info(`[cli-bridge-reply] timeout ask turn=${turnId.slice(0, 8)} → ${action}`);
  } catch {
    // 120s 無回應 → 自動中斷
    bridge.executeTimeoutAction(turnId, "interrupt");
    await sender.editComponents(msg, {
      content: `⏰ **Idle 超時** → 無回應，自動中斷`,
      components: [],
    }).catch(() => {});
    log.info(`[cli-bridge-reply] timeout ask turn=${turnId.slice(0, 8)} → auto interrupt (no response)`);
  }
}
