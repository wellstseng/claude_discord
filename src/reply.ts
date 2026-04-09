/**
 * @file reply.ts
 * @description Discord 回覆邏輯：串流 AcpEvent → 分段傳送訊息或上傳檔案
 *
 * 核心功能：
 * - 累積 text_delta，達 2000 字（Discord API 上限）時自動切割
 * - 定時 flush：收到 text_delta 後 1.5s 無新增即送出當前 buffer（漸進式顯示）
 * - 回覆超過 fileUploadThreshold 時改為上傳 .md 檔案
 * - Code fence 跨 chunk 平衡：奇數個 ``` 時自動補關/補開
 * - 第一段用 message.reply()，後續用 channel.send()
 * - tool_call event → showToolCalls 分級："all" 全顯示 / "summary" 僅提示 / "none" 隱藏
 * - error event → 傳送錯誤訊息
 *
 * 使用方式：
 *   const onEvent = createReplyHandler(message, config);
 *   enqueue(channelId, text, onEvent, opts);
 */

import { AttachmentBuilder, type Message, type SendableChannels } from "discord.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AcpEvent } from "./acp.js";
import type { BridgeConfig } from "./core/config.js";
import { recordAssistantTurn } from "./history.js";
import { log } from "./logger.js";

// Discord 訊息字數硬上限
const TEXT_LIMIT = 2000;

// 定時 flush 延遲（毫秒）：收到 text_delta 後多久自動送出
const FLUSH_DELAY_MS = 3000;

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

// ── MEDIA token 解析 ─────────────────────────────────────────────────────────

/** MEDIA token 正規表達式：MEDIA: /path/to/file 或 MEDIA: `path with spaces` */
const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi;

/** Windows 絕對路徑（C:\... 或 C:/...） */
const WINDOWS_ABS_PATH_RE = /^[a-zA-Z]:[\\/]/;

/**
 * 從文字中抽取 MEDIA: token，回傳清理後的文字 + 檔案路徑
 *
 * 範例輸入："這是報告 MEDIA: /tmp/report.md"
 * 回傳：{ text: "這是報告", mediaPaths: ["/tmp/report.md"] }
 */
function extractMediaTokens(raw: string): {
  text: string;
  mediaPaths: string[];
} {
  const mediaPaths: string[] = [];

  const text = raw
    .replace(MEDIA_RE, (_, path: string) => {
      const trimmed = path.trim();
      // 只接受絕對路徑（Unix / 開頭，或 Windows C:\... 格式），避免誤抓
      if (trimmed.startsWith("/") || WINDOWS_ABS_PATH_RE.test(trimmed)) {
        mediaPaths.push(trimmed);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n") // 清理移除 token 後的多餘空行
    .trim();

  return { text, mediaPaths };
}

/**
 * 讀取檔案並上傳到 Discord 作為附件
 */
async function uploadMediaFile(
  filePath: string,
  originalMessage: Message,
  isFirst: boolean,
): Promise<boolean> {
  try {
    const buffer = await readFile(filePath);
    const fileName = basename(filePath);
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    const payload = { files: [attachment] };

    if (isFirst) {
      await originalMessage.reply(payload);
    } else {
      const channel = originalMessage.channel as SendableChannels;
      await channel.send(payload);
    }

    log.info(`[reply] 已上傳附件：${fileName} (${buffer.length} bytes)`);
    return true;
  } catch (err) {
    log.warn(`[reply] 附件上傳失敗：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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

/**
 * 上傳檔案到 Discord
 *
 * @param content 檔案內容（UTF-8 文字）
 * @param fileName 檔案名稱（例如 "response.md"）
 * @param originalMessage 用於 reply 的原始訊息
 * @param isFirst 是否為第一則回覆
 * @param preview 訊息預覽文字（可選）
 */
async function sendFile(
  content: string,
  fileName: string,
  originalMessage: Message,
  isFirst: boolean,
  preview?: string
): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(content, "utf-8"), {
    name: fileName,
  });

  const payload = {
    content: preview ?? undefined,
    files: [attachment],
  };

  if (isFirst) {
    await originalMessage.reply(payload);
  } else {
    const channel = originalMessage.channel as SendableChannels;
    await channel.send(payload);
  }
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 建立 AcpEvent 回呼處理器，用於接收 session.ts 的 onEvent 回呼
 *
 * 回傳的函式每次收到 AcpEvent 都會：
 * - text_delta → 累積文字，≥2000 字立即切割，否則 1.5s 後自動送出
 * - tool_call  → 依 showToolCalls 模式：all 顯示名稱 / summary 顯示提示 / none 隱藏
 * - done       → 短回覆 flush；長回覆上傳 .md 檔案
 * - error      → flush buffer + 傳送錯誤訊息
 * - status     → 靜默忽略
 *
 * @param originalMessage 觸發此 turn 的 Discord 訊息（用於 reply）
 * @param bridgeConfig 全域設定
 * @returns async event handler，可直接傳給 session.enqueue 的 onEvent 參數
 */
export function createReplyHandler(
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
  turnId?: string,
): (event: AcpEvent) => Promise<void> {
  let buffer = "";
  let isFirst = true;

  // 累積完整文字（用於判斷是否超過 fileUploadThreshold）
  let totalText = "";
  // 是否已切換為檔案模式（停止分段傳送，等 done 時上傳）
  let fileMode = false;
  const threshold = bridgeConfig.fileUploadThreshold;
  const toolMode = bridgeConfig.showToolCalls;

  // ── History 記錄用累積 ──
  let totalThinking = "";
  const toolCallNames: string[] = [];

  // ── Thinking 顯示 ──
  // 推理文字用 Discord 引用格式（> 💭 ...）送出
  let thinkingBuffer = "";

  // ── 定時 flush ──
  // 收到 text_delta 後 1.5s 無新增即自動送出 buffer，實現漸進式顯示
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // 防止 flushTimer 與手動 flush 並行衝突
  let flushing = false;

  /** 排程定時 flush：重設 timer，1.5s 後自動送出（text buffer 或 thinking buffer） */
  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (flushing) return;
      flushing = true;
      void (async () => {
        // 定時 flush thinking buffer（推理過程漸進顯示）
        if (thinkingBuffer.length > 0) {
          await flushThinking();
        }
        // 定時 flush text buffer
        if (buffer.length > 0 && !fileMode) {
          await flush(true);
        }
      })().finally(() => { flushing = false; });
    }, FLUSH_DELAY_MS);
  }

  /** 取消定時 flush */
  function cancelFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

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

  // summary 模式：追蹤是否已送過「處理中」提示（只送一次）
  let summaryHintSent = false;

  /**
   * 將 buffer 切割成 <= TEXT_LIMIT 的 chunk 並傳送
   * @param flushAll 若 true，連最後不足 TEXT_LIMIT 的部分也傳送
   */
  async function flush(flushAll = false): Promise<void> {
    while (buffer.length >= TEXT_LIMIT || (flushAll && buffer.length > 0)) {
      // 預留空間給 code fence 補開/補關（各 4 字元 "```\n"）
      const safeLimit = TEXT_LIMIT - 8;
      let chunk = buffer.slice(0, safeLimit);
      buffer = buffer.slice(safeLimit);

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

  /**
   * 將 thinking buffer 格式化為引用並送出
   * 每行加 > 前綴，整段加 💭 標記
   */
  async function flushThinking(): Promise<void> {
    if (!thinkingBuffer.trim()) return;

    // 將推理文字格式化為 Discord 引用格式
    const formatted = thinkingBuffer
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const toSend = `> 💭 **Thinking**\n${formatted}`;

    // 分段送出（可能超過 2000 字）
    const chunks: string[] = [];
    let remaining = toSend;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, TEXT_LIMIT));
      remaining = remaining.slice(TEXT_LIMIT);
    }

    for (const chunk of chunks) {
      await sendChunk(chunk, originalMessage, isFirst);
      // NOTE: thinking 送出時不停 typing，讓 typing 持續到正式 text 送出
      isFirst = false;
    }

    thinkingBuffer = "";
  }

  return async (event: AcpEvent): Promise<void> => {
    if (event.type === "thinking_delta") {
      // history 記錄用（不論 showThinking 開關都累積）
      totalThinking += event.text;
      // 推理文字：showThinking 開啟時累積，切換到 text 時 flush
      if (bridgeConfig.showThinking) {
        thinkingBuffer += event.text;
        scheduleFlush();
      }
      return;
    }

    if (event.type === "text_delta") {
      // 收到 text 代表 thinking 結束，先 flush thinking buffer
      if (thinkingBuffer.length > 0) {
        cancelFlushTimer();
        await flushThinking();
      }
      totalText += event.text;

      if (fileMode) {
        // 已進入檔案模式，只累積不傳送，等 done 時上傳
        return;
      }

      // 檢查是否應切換為檔案模式
      if (threshold > 0 && totalText.length > threshold) {
        fileMode = true;
        cancelFlushTimer();
        // 不再送出新的 chunk，buffer 清空（已送出的就算了）
        buffer = "";
        return;
      }

      buffer += event.text;

      // ≥2000 字立即 flush，否則排程 1.5s 後自動送出
      if (buffer.length >= TEXT_LIMIT) {
        cancelFlushTimer();
        await flush(false);
      } else {
        scheduleFlush();
      }
    } else if (event.type === "tool_call") {
      toolCallNames.push(event.title);
      if (toolMode === "all") {
        // 全顯示：flush 當前 buffer + 顯示工具名稱
        cancelFlushTimer();
        if (!fileMode) {
          await flush(true);
        }
        await sendChunk(`🔧 使用工具：${event.title}`, originalMessage, isFirst);
        if (isFirst) stopTyping();
        isFirst = false;
      } else if (toolMode === "summary" && !summaryHintSent) {
        // summary 模式：只在第一次 tool_call 時送一次「處理中」提示
        cancelFlushTimer();
        if (!fileMode) {
          await flush(true);
        }
        await sendChunk("⏳ 處理中...", originalMessage, isFirst);
        if (isFirst) stopTyping();
        isFirst = false;
        summaryHintSent = true;
      }
      // "none" → 完全不輸出
    } else if (event.type === "done") {
      cancelFlushTimer();
      stopTyping();

      // 先從完整文字中抽取 MEDIA token
      const { text: cleanedText, mediaPaths } = extractMediaTokens(totalText);

      if (fileMode && mediaPaths.length === 0) {
        // 長回覆且無 MEDIA → 上傳完整內容為 .md 檔案
        const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
        await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
        isFirst = false;
      } else {
        // 短回覆 or 有 MEDIA token → 文字以 chunk 送出，MEDIA 檔案另外上傳
        // NOTE: fileMode + MEDIA 時，文字部分仍需送出（不產生 response.md 避免重複）
        if (fileMode) {
          // fileMode 期間 buffer 已停止累積，用清理後的完整文字重建 buffer
          buffer = cleanedText;
        } else {
          const { text: cleanedBuffer } = extractMediaTokens(buffer);
          buffer = cleanedBuffer;
        }
        await flush(true);
      }

      // 上傳所有 MEDIA 指定的檔案
      for (const filePath of mediaPaths) {
        const uploaded = await uploadMediaFile(filePath, originalMessage, isFirst);
        if (uploaded) isFirst = false;
      }

      // 寫入 history DB
      if (turnId) {
        const botUser = originalMessage.client.user;
        recordAssistantTurn({
          turnId,
          channelId: originalMessage.channelId,
          guildId: originalMessage.guild?.id ?? null,
          botId: botUser?.id ?? "unknown",
          botName: botUser?.displayName ?? "catclaw",
          sessionId: null,
          text: totalText,
          thinking: totalThinking,
          toolCalls: toolCallNames,
        });
      }
    } else if (event.type === "timeout_warning") {
      // Timeout 預警：不中斷流程，送出提示讓使用者知道任務仍在進行
      const minutes = Math.ceil(event.elapsedSec / 60);
      const warningMsg = `⏳ 任務仍在進行中，已耗時 ${minutes} 分鐘...`;
      await sendChunk(warningMsg, originalMessage, isFirst);
      if (isFirst) stopTyping();
      isFirst = false;
    } else if (event.type === "error") {
      cancelFlushTimer();
      stopTyping();
      if (!fileMode) {
        await flush(true);
      }
      // 截斷過長的錯誤訊息（避免超過 Discord 2000 字限制）
      const errorMsg = `⚠️ 發生錯誤：${event.message}`.slice(0, TEXT_LIMIT);
      await sendChunk(errorMsg, originalMessage, isFirst);
      isFirst = false;

      // error 也記入 history
      if (turnId) {
        const botUser = originalMessage.client.user;
        recordAssistantTurn({
          turnId,
          channelId: originalMessage.channelId,
          guildId: originalMessage.guild?.id ?? null,
          botId: botUser?.id ?? "unknown",
          botName: botUser?.displayName ?? "catclaw",
          sessionId: null,
          text: `[ERROR] ${event.message}`,
          thinking: totalThinking,
          toolCalls: toolCallNames,
        });
      }
    }
    // status event 靜默忽略
  };
}
