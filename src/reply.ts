/**
 * @file reply.ts
 * @description Discord 回覆邏輯：串流 AcpEvent → 分段傳送訊息
 *
 * 核心功能：
 * - 累積 text_delta，達 2000 字（Discord API 上限）時自動切割
 * - Code fence 跨 chunk 平衡：奇數個 ``` 時自動補關/補開
 * - 第一段用 message.reply()，後續用 channel.send()
 * - tool_call event → 傳送 🔧 提示訊息
 * - error event → 傳送錯誤訊息
 *
 * 使用方式：
 *   const onEvent = createReplyHandler(message);
 *   enqueue(channelId, text, onEvent, opts);
 */

import type { Message, SendableChannels } from "discord.js";
import type { AcpEvent } from "./acp.js";

// Discord 訊息字數硬上限
const TEXT_LIMIT = 2000;

// ── 工具函式 ────────────────────────────────────────────────────────────────

/**
 * 計算字串中 ``` 出現的次數
 * 奇數次 → 有未閉合的 code fence
 */
function countCodeFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

/**
 * 若 text 有奇數個 ```（未閉合），在尾端補上 ``` 關閉
 */
function closeFenceIfOpen(text: string): string {
  return countCodeFences(text) % 2 !== 0 ? text + "\n```" : text;
}

// ── 傳送函式 ────────────────────────────────────────────────────────────────

/**
 * 傳送一段訊息到 Discord
 * 第一段（isFirst = true）用 message.reply()，之後用 channel.send()
 */
async function sendChunk(
  content: string,
  originalMessage: Message,
  isFirst: boolean
): Promise<void> {
  if (!content.trim()) return;

  if (isFirst) {
    await originalMessage.reply(content);
  } else {
    // NOTE: PartialGroupDMChannel 沒有 send，但 bot 不會在 Group DM 中使用，直接 cast
    const channel = originalMessage.channel as SendableChannels;
    await channel.send(content);
  }
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 建立 AcpEvent 回呼處理器，用於接收 session.ts 的 onEvent 回呼
 *
 * 回傳的函式每次收到 AcpEvent 都會：
 * - text_delta → 累積到 buffer，達 TEXT_LIMIT 時 flush
 * - tool_call  → flush buffer + 傳送 🔧 提示
 * - done       → flush 所有剩餘 buffer
 * - error      → flush buffer + 傳送錯誤訊息
 * - status     → 靜默忽略
 *
 * @param originalMessage 觸發此 turn 的 Discord 訊息（用於 reply）
 * @returns async event handler，可直接傳給 session.enqueue 的 onEvent 參數
 */
export function createReplyHandler(
  originalMessage: Message
): (event: AcpEvent) => Promise<void> {
  let buffer = "";
  let isFirst = true;

  // ── Typing indicator ──
  // Discord typing 持續約 10 秒，每 8 秒重發一次，直到第一則回覆送出
  const channel = originalMessage.channel;
  if ("sendTyping" in channel) {
    void (channel as SendableChannels).sendTyping();
  }
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) {
      void (channel as SendableChannels).sendTyping();
    }
  }, 8_000);
  // typing 清理函式，送出第一則回覆後呼叫
  const stopTyping = () => clearInterval(typingInterval);
  // NOTE: 追蹤上一個 chunk 末尾是否有未閉合 code fence
  //       若有，下一個 chunk 開頭要補開
  let prevChunkHadOpenFence = false;

  /**
   * 將 buffer 切割成 <= TEXT_LIMIT 的 chunk 並傳送
   * @param flushAll 若 true，連最後不足 TEXT_LIMIT 的部分也傳送
   */
  async function flush(flushAll = false): Promise<void> {
    while (buffer.length >= TEXT_LIMIT || (flushAll && buffer.length > 0)) {
      let chunk = buffer.slice(0, TEXT_LIMIT);
      buffer = buffer.slice(TEXT_LIMIT);

      // 補開：若上一個 chunk 有未閉合 fence，這個 chunk 開頭補 ```
      if (prevChunkHadOpenFence) {
        chunk = "```\n" + chunk;
      }

      // 補關：若這個 chunk 有未閉合 fence，尾端補 ```
      const hadOpenFence = countCodeFences(chunk) % 2 !== 0;
      const toSend = hadOpenFence ? closeFenceIfOpen(chunk) : chunk;

      prevChunkHadOpenFence = hadOpenFence;

      await sendChunk(toSend, originalMessage, isFirst);
      if (isFirst) stopTyping(); // 第一則回覆送出 → 停止 typing
      isFirst = false;
    }
  }

  return async (event: AcpEvent): Promise<void> => {
    if (event.type === "text_delta") {
      buffer += event.text;
      await flush(false);
    } else if (event.type === "tool_call") {
      // 先把目前 buffer flush 出去，再傳工具提示
      await flush(true);
      await sendChunk(`🔧 使用工具：${event.title}`, originalMessage, isFirst);
      if (isFirst) stopTyping();
      isFirst = false;
    } else if (event.type === "done") {
      stopTyping();
      await flush(true);
    } else if (event.type === "error") {
      stopTyping();
      await flush(true);
      await sendChunk(
        `⚠️ 發生錯誤：${event.message}`,
        originalMessage,
        isFirst
      );
      isFirst = false;
    }
    // status event 靜默忽略
  };
}
