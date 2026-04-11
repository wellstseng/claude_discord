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
import type { CliBridgeEvent } from "./types.js";
import type { BridgeConfig } from "../core/config.js";
import type { CliBridgeConfig } from "./types.js";
import type { BridgeSender } from "./discord-sender.js";

const TEXT_LIMIT = 2000;
const RETRY_DELAYS = [1000, 2000, 4000];

// ── 工具函式 ────────────────────────────────────────────────────────────────

function closeFenceIfOpen(text: string): string {
  const fenceCount = (text.match(/```/g) ?? []).length;
  return fenceCount % 2 !== 0 ? text + "\n```" : text;
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

/** 從 Discord Message 提取附件描述（供 stdin 附加） */
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
): Promise<void> {
  const sender = bridge.getSender();
  const handle = bridge.send(text, "discord", {
    user: originalMessage.author.displayName || originalMessage.author.username,
    ts: new Date(originalMessage.createdTimestamp).toISOString(),
  });
  const turnId = handle.turnId;
  const stdoutLogger = bridge.getStdoutLogger();
  const showToolCalls = bridgeConfig.showToolCalls;
  const showThinking = cliBridgeConfig?.showThinking ?? false;
  const editIntervalMs = cliBridgeConfig?.editIntervalMs ?? 800;

  let buffer = "";
  let thinkingBuffer = "";
  const state = { editMsg: null as Message | null };
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editBusy = false;
  let isFirst = true;
  let toolHintSent = false;

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
        // 移除 ⏳，加 🤔
        if (!state.editMsg) {
          void originalMessage.reactions.cache.get("⏳")?.remove().catch(() => {});
          void originalMessage.react("🤔").catch(() => {});
          await initEditMsg();
        }
        buffer += evt.text;
        scheduleEdit();

        // 超過 TEXT_LIMIT → 送出當前 buffer，開新 edit message
        if (buffer.length > TEXT_LIMIT - 100) {
          cancelEditTimer();
          const content = closeFenceIfOpen(buffer);
          if (state.editMsg) {
            try { await sender.edit(state.editMsg, content.slice(0, TEXT_LIMIT)); } catch { /* */ }
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
        if (buffer.trim() && state.editMsg) {
          const final = closeFenceIfOpen(buffer);
          const msg = state.editMsg;
          const ok = await retrySend(async () => { await sender.edit(msg, final.slice(0, TEXT_LIMIT)); });
          discordDelivery = ok ? "success" : "failed";
          discordMessageId = msg.id;
        } else if (buffer.trim()) {
          const ok = await retrySend(async () => { await sendText(buffer); });
          discordDelivery = ok ? "success" : "failed";
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
