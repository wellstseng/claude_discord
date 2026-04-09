/**
 * @file cli-bridge/reply.ts
 * @description CLI Bridge → Discord 回覆處理
 *
 * 消費 CliBridge.send() 回傳的 TurnHandle.events，串流回覆到 Discord。
 * 設計參考 core/reply-handler.ts，但更簡單（不需 tool registry / permission 等）。
 *
 * 特點：
 * - Streaming edit 模式（live-edit Discord message）
 * - Discord 送達失敗 → 重試 3 次（指數退避 1s, 2s, 4s）
 * - 送達狀態回寫 StdoutLogger
 * - tool_call / thinking 可選顯示
 */

import { type Message, type SendableChannels } from "discord.js";
import { log } from "../logger.js";
import type { CliBridge } from "./bridge.js";
import type { CliBridgeEvent } from "./types.js";
import type { BridgeConfig } from "../core/config.js";

const TEXT_LIMIT = 2000;
const EDIT_INTERVAL_MS = 800;
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

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 消費 CliBridge turn events，串流回覆到 Discord
 */
export async function handleCliBridgeReply(
  bridge: CliBridge,
  text: string,
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
): Promise<void> {
  const handle = bridge.send(text, "discord");
  const turnId = handle.turnId;
  const stdoutLogger = bridge.getStdoutLogger();
  const showToolCalls = bridgeConfig.showToolCalls;

  let buffer = "";
  const state = { editMsg: null as Message | null };
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editBusy = false;
  let isFirst = true;
  let toolHintSent = false;

  // Typing indicator
  const channel = originalMessage.channel;
  if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  }, 8_000);
  const stopTyping = () => clearInterval(typingInterval);

  // ── Streaming edit helpers ──────────────────────────────────────────────

  async function doEdit(): Promise<void> {
    if (!state.editMsg || !buffer.trim() || editBusy) return;
    const content = closeFenceIfOpen(buffer);
    const safe = content.length > TEXT_LIMIT ? content.slice(0, TEXT_LIMIT - 3) + "…" : content;
    try {
      editBusy = true;
      await state.editMsg.edit(safe);
    } catch { /* rate-limited or deleted */ }
    finally { editBusy = false; }
  }

  function scheduleEdit(): void {
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      void doEdit();
    }, EDIT_INTERVAL_MS);
  }

  function cancelEditTimer(): void {
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
  }

  async function initEditMsg(): Promise<void> {
    try {
      if (isFirst) {
        state.editMsg = await originalMessage.reply("...");
        isFirst = false;
      } else {
        state.editMsg = await (channel as SendableChannels).send("...");
      }
    } catch (err) {
      log.debug(`[cli-bridge-reply] initEditMsg 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function send(content: string): Promise<void> {
    if (!content.trim()) return;
    if (isFirst) {
      await originalMessage.reply(content);
      isFirst = false;
    } else {
      await (channel as SendableChannels).send(content);
    }
  }

  // ── Ack reaction ──
  void originalMessage.react("⏳").catch(() => {});

  // ── 消費事件 ──────────────────────────────────────────────────────────────

  let discordDelivery: "success" | "failed" | "pending" = "pending";
  let discordMessageId: string | undefined;

  try {
    for await (const evt of handle.events) {

      // ── text_delta ──
      if (evt.type === "text_delta") {
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
            try { await state.editMsg.edit(content.slice(0, TEXT_LIMIT)); } catch { /* */ }
          }
          buffer = "";
          state.editMsg = null;
          await initEditMsg();
        }
        continue;
      }

      // ── thinking_delta ──
      if (evt.type === "thinking_delta") {
        // 靜默（thinking 不顯示在 Discord，但 log 有記錄）
        continue;
      }

      // ── tool_call ──
      if (evt.type === "tool_call") {
        if (showToolCalls !== "none" && !toolHintSent) {
          void originalMessage.reactions.cache.get("🤔")?.remove().catch(() => {});
          void originalMessage.react("🔧").catch(() => {});
          toolHintSent = true;
        }
        if (showToolCalls === "all") {
          await send(`🔧 \`${evt.title}\``);
        }
        continue;
      }

      // ── tool_result ──
      if (evt.type === "tool_result") {
        if (showToolCalls === "all") {
          const durStr = evt.duration_ms ? ` (${Math.round(evt.duration_ms / 1000)}s)` : "";
          await send(`✅ \`${evt.title}\`${durStr}`);
        }
        continue;
      }

      // ── result ──
      if (evt.type === "result") {
        // 最後 flush
        cancelEditTimer();
        if (buffer.trim() && state.editMsg) {
          const final = closeFenceIfOpen(buffer);
          const msg = state.editMsg;
          const ok = await retrySend(async () => { await msg.edit(final.slice(0, TEXT_LIMIT)); });
          discordDelivery = ok ? "success" : "failed";
          discordMessageId = msg.id;
        } else if (buffer.trim()) {
          const ok = await retrySend(async () => { await send(buffer); });
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
        const ok = await retrySend(() => send(errText));
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
    cancelEditTimer();

    // 更新 turn 送達狀態
    stdoutLogger.updateTurnDelivery(
      turnId,
      discordDelivery,
      discordMessageId,
      discordDelivery === "failed" ? "Discord 送達失敗" : undefined,
    );

    log.info(`[cli-bridge-reply] turn=${turnId.slice(0, 8)} delivery=${discordDelivery}`);
  }
}
