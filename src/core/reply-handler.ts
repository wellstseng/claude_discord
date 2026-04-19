/**
 * @file core/reply-handler.ts
 * @description AgentLoopEvent async generator → Discord 分段回覆
 *
 * 兩種回覆模式：
 * - streaming（預設）：每條訊息建立後 live-edit，體驗類似 ChatGPT 串流
 * - chunk（fallback）：逐段發送新訊息（fileMode / 超閾值時自動切換）
 */

import { AttachmentBuilder, type Message, type SendableChannels } from "discord.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentLoopEvent } from "./agent-loop.js";
import type { BridgeConfig } from "./config.js";
import { log } from "../logger.js";

// Discord 字數上限
const TEXT_LIMIT = 2000;
const FLUSH_DELAY_MS = 3000;   // chunk 模式：靜默多久後送出
const EDIT_INTERVAL_MS = 800;  // streaming 模式：最快 edit 間隔

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function countCodeFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

function closeFenceIfOpen(text: string): string {
  return countCodeFences(text) % 2 !== 0 ? text + "\n```" : text;
}

const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi;
const WINDOWS_ABS_PATH_RE = /^[a-zA-Z]:[\\/]/;

function extractMediaTokens(raw: string): { text: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const text = raw
    .replace(MEDIA_RE, (_, path: string) => {
      const trimmed = path.trim();
      if (trimmed.startsWith("/") || WINDOWS_ABS_PATH_RE.test(trimmed)) {
        mediaPaths.push(trimmed);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, mediaPaths };
}

async function uploadMediaFile(filePath: string, originalMessage: Message, isFirst: boolean): Promise<boolean> {
  try {
    const buf = await readFile(filePath);
    const attachment = new AttachmentBuilder(buf, { name: basename(filePath) });
    const payload = { files: [attachment] };
    if (isFirst) {
      await originalMessage.reply(payload);
    } else {
      await (originalMessage.channel as SendableChannels).send(payload);
    }
    log.info(`[reply-handler] 已上傳附件：${basename(filePath)} (${buf.length} bytes)`);
    return true;
  } catch (err) {
    log.warn(`[reply-handler] 附件上傳失敗：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function sendChunk(content: string, originalMessage: Message, isFirst: boolean): Promise<void> {
  if (!content.trim()) return;
  if (isFirst) {
    await originalMessage.reply(content);
  } else {
    await (originalMessage.channel as SendableChannels).send(content);
  }
}

async function sendFile(content: string, fileName: string, originalMessage: Message, isFirst: boolean, preview?: string): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(content, "utf-8"), { name: fileName });
  const payload = { content: preview ?? undefined, files: [attachment] };
  if (isFirst) {
    await originalMessage.reply(payload);
  } else {
    await (originalMessage.channel as SendableChannels).send(payload);
  }
}

// ── 主要 API ──────────────────────────────────────────────────────────────────

/**
 * 消費 AgentLoop async generator，串流回覆到 Discord
 *
 * @param opts.threadChannel 若提供，所有回覆直接 send 到此 channel（autoThread 模式）
 */
export async function handleAgentLoopReply(
  gen: AsyncGenerator<AgentLoopEvent>,
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
  opts?: { threadChannel?: SendableChannels },
): Promise<void> {
  let buffer = "";          // chunk 模式累積（streaming 模式不再使用，改 segmentBuffer）
  let totalText = "";
  let fileMode = false;
  let isFirst = true;
  let prevChunkHadOpenFence = false;
  let summaryHintSent = false;
  let thinkingBuffer = "";

  const threshold = bridgeConfig.fileUploadThreshold;
  const toolMode = bridgeConfig.showToolCalls;
  const threadChannel = opts?.threadChannel;
  const useStreamEdit = (bridgeConfig.streamingReply !== false);

  // ── Streaming edit 狀態（rolling progress msg 模式） ──────────────────────
  // progressMsg：此 turn 唯一的 live-edit 目標訊息
  // segmentBuffer：當前 segment（兩個 tool_use 之間）累積的 text
  // pendingSegmentReset：tool_start 後置 true → 下一個 text_delta 觸發覆寫（不 append）
  let progressMsg: Message | null = null;
  let segmentBuffer = "";
  let pendingSegmentReset = false;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editBusy = false;

  async function doEdit(): Promise<void> {
    if (!progressMsg || !segmentBuffer.trim() || editBusy) return;
    const content = closeFenceIfOpen(segmentBuffer);
    const safeContent = content.length > TEXT_LIMIT ? content.slice(0, TEXT_LIMIT - 3) + "…" : content;
    try {
      editBusy = true;
      await progressMsg.edit(safeContent);
    } catch { /* rate-limited 或訊息被刪，靜默 */ }
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

  /** 等待正在進行的 edit 完成（最多 500ms） */
  async function waitEditDone(): Promise<void> {
    let wait = 0;
    while (editBusy && wait < 500) {
      await new Promise(r => setTimeout(r, 50));
      wait += 50;
    }
  }

  /** 建立新的 progress 訊息（"💭" placeholder）— 一個 turn 通常只呼叫一次 */
  async function initProgressMsg(initialContent = "💭"): Promise<void> {
    try {
      let msg: Message;
      if (threadChannel) {
        msg = await threadChannel.send(initialContent);
      } else if (isFirst) {
        msg = await originalMessage.reply(initialContent);
        stopTyping();
        isFirst = false;
      } else {
        msg = await (originalMessage.channel as SendableChannels).send(initialContent);
      }
      progressMsg = msg;
    } catch (err) {
      log.debug(`[reply-handler] initProgressMsg 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 決定送出目標（chunk 模式 or tool/error 臨時 send） ─────────────────────
  async function send(content: string): Promise<void> {
    if (!content.trim()) return;
    if (threadChannel) {
      await threadChannel.send(content);
    } else if (isFirst) {
      await originalMessage.reply(content);
    } else {
      await (originalMessage.channel as SendableChannels).send(content);
    }
  }

  // Typing indicator
  const channel = threadChannel ?? originalMessage.channel;
  if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  }, 8_000);
  const stopTyping = () => clearInterval(typingInterval);

  // ── Chunk 模式：flush timer ───────────────────────────────────────────────
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (flushing) return;
      flushing = true;
      void (async () => {
        if (thinkingBuffer.length > 0) await flushThinking();
        if (buffer.length > 0 && !fileMode) await flush(true);
      })().finally(() => { flushing = false; });
    }, FLUSH_DELAY_MS);
  }

  function cancelFlushTimer(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  async function flush(flushAll = false): Promise<void> {
    while (buffer.length >= TEXT_LIMIT || (flushAll && buffer.length > 0)) {
      const safeLimit = TEXT_LIMIT - 8;
      let chunk = buffer.slice(0, safeLimit);
      buffer = buffer.slice(safeLimit);

      if (prevChunkHadOpenFence) chunk = "```\n" + chunk;
      const hadOpenFence = countCodeFences(chunk) % 2 !== 0;
      const toSend = hadOpenFence ? closeFenceIfOpen(chunk) : chunk;
      prevChunkHadOpenFence = hadOpenFence;

      await send(toSend);
      if (isFirst) stopTyping();
      isFirst = false;
    }
  }

  async function flushThinking(): Promise<void> {
    if (!thinkingBuffer.trim()) return;
    const formatted = thinkingBuffer.trim().split("\n").map(l => `> ${l}`).join("\n");
    const toSend = `> 💭 **Thinking**\n${formatted}`;
    let remaining = toSend;
    while (remaining.length > 0) {
      await send(remaining.slice(0, TEXT_LIMIT));
      if (isFirst) stopTyping();
      isFirst = false;
      remaining = remaining.slice(TEXT_LIMIT);
    }
    thinkingBuffer = "";
  }

  // ── Streaming edit：rolling progress msg（每 segment 覆寫前段） ─────────
  const STREAM_SPLIT_THRESHOLD = TEXT_LIMIT - 100; // 1900

  async function streamEditTextDelta(text: string): Promise<void> {
    // 新 segment 第一個 delta：覆寫 segmentBuffer（替換前段內容）
    if (pendingSegmentReset) {
      segmentBuffer = text;
      pendingSegmentReset = false;
    } else {
      segmentBuffer += text;
    }

    // 確保 progressMsg 存在（首個 text_delta 才建）
    if (!progressMsg) await initProgressMsg("💭");

    // 單一 segment 超過 1900 → 切到下一條 progressMsg 保留 remainder
    // 預設 fileUploadThreshold=3000 通常會在這之前先觸發 fileMode；只有 1900~3000 才會進這裡
    while (segmentBuffer.length >= STREAM_SPLIT_THRESHOLD) {
      cancelEditTimer();
      await waitEditDone();
      const firstChunk = segmentBuffer.slice(0, STREAM_SPLIT_THRESHOLD);
      const remainder = segmentBuffer.slice(STREAM_SPLIT_THRESHOLD);
      segmentBuffer = firstChunk;
      await doEdit();
      progressMsg = null;
      await initProgressMsg("💭");
      segmentBuffer = remainder;
    }

    if (segmentBuffer.length > 0) {
      scheduleEdit();
    }
  }

  async function finalizeStreamEdit(): Promise<void> {
    cancelEditTimer();
    await waitEditDone();
    if (segmentBuffer.trim()) {
      await doEdit();
    }
  }

  // ── 主事件迴圈 ───────────────────────────────────────────────────────────

  try {
    for await (const event of gen) {
      if (event.type === "thinking") {
        if (bridgeConfig.showThinking) {
          thinkingBuffer += event.thinking;
          if (!useStreamEdit) scheduleFlush();
        }

      } else if (event.type === "text_delta") {
        if (thinkingBuffer.length > 0) {
          if (useStreamEdit) { cancelEditTimer(); } else { cancelFlushTimer(); }
          await flushThinking();
        }
        totalText += event.text;

        if (fileMode) continue;

        if (threshold > 0 && totalText.length > threshold) {
          fileMode = true;
          if (useStreamEdit) {
            cancelEditTimer();
            await finalizeStreamEdit();  // 把最後 segment 寫入 progressMsg 當預覽
            segmentBuffer = "";
          } else {
            cancelFlushTimer();
            buffer = "";
          }
          continue;
        }

        if (useStreamEdit) {
          await streamEditTextDelta(event.text);
        } else {
          buffer += event.text;
          if (buffer.length >= TEXT_LIMIT) {
            cancelFlushTimer();
            await flush(false);
          } else {
            scheduleFlush();
          }
        }

      } else if (event.type === "tool_start") {
        // streaming 模式：finalize 寫入最後 segment 到 progressMsg；
        // pendingSegmentReset 讓下個 text_delta 覆寫 segmentBuffer 而非 append
        if (toolMode === "all") {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); pendingSegmentReset = true; }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send(`🔧 使用工具：${event.name}`);
          if (isFirst) stopTyping();
          isFirst = false;
        } else if (toolMode === "summary" && !summaryHintSent) {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); pendingSegmentReset = true; }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send("⏳ 處理中...");
          if (isFirst) stopTyping();
          isFirst = false;
          summaryHintSent = true;
        } else if (toolMode === "summary") {
          // summary 模式後續 tool：靜默切下一段，progressMsg 保留前段內容直到下個 text_delta 覆寫
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); pendingSegmentReset = true; }
        }

      } else if (event.type === "tool_blocked") {
        if (toolMode !== "none") {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); pendingSegmentReset = true; }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send(`🚫 工具被阻擋：${event.name} — ${event.reason}`);
          if (isFirst) stopTyping();
          isFirst = false;
        }

      } else if (event.type === "done") {
        if (useStreamEdit) { cancelEditTimer(); }
        else { cancelFlushTimer(); }
        stopTyping();

        // Fallback：LLM 回傳空字串時，送出預設訊息避免使用者完全收不到回覆
        if (!totalText.trim()) {
          totalText = "（抱歉，我暫時無法回覆這條訊息。請再試一次或換個方式描述。）";
          if (useStreamEdit) segmentBuffer = totalText;
          else buffer = totalText;
          log.warn(`[reply-handler] LLM 回傳空字串，使用 fallback 回覆`);
        }

        const { text: cleanedText, mediaPaths } = extractMediaTokens(totalText);

        if (useStreamEdit) {
          if (fileMode) {
            // fileMode：完整 transcript 上傳；progressMsg 標示已歸檔
            const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
            if (threadChannel) {
              const attachment = new AttachmentBuilder(Buffer.from(cleanedText, "utf-8"), { name: "response.md" });
              await threadChannel.send({ content: preview, files: [attachment] });
            } else {
              await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
            }
            isFirst = false;
            if (progressMsg !== null) {
              try { await (progressMsg as Message).edit("📎 完整回覆已上傳（見附件）"); } catch { /* 靜默 */ }
            }
          } else {
            // 非 fileMode：清 segmentBuffer 中 MEDIA token，最終 edit progressMsg
            const { text: cleanSeg } = extractMediaTokens(segmentBuffer);
            segmentBuffer = cleanSeg;
            await waitEditDone();
            await doEdit();
          }
        } else {
          // chunk 模式：維持原邏輯
          if (fileMode && mediaPaths.length === 0) {
            const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
            if (threadChannel) {
              const attachment = new AttachmentBuilder(Buffer.from(cleanedText, "utf-8"), { name: "response.md" });
              await threadChannel.send({ content: preview, files: [attachment] });
            } else {
              await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
            }
            isFirst = false;
          } else {
            if (fileMode) buffer = cleanedText;
            else { const { text: cb } = extractMediaTokens(buffer); buffer = cb; }
            await flush(true);
          }
        }

        for (const filePath of mediaPaths) {
          if (threadChannel) {
            try {
              const buf2 = await readFile(filePath);
              const attachment = new AttachmentBuilder(buf2, { name: basename(filePath) });
              await threadChannel.send({ files: [attachment] });
              isFirst = false;
            } catch { /* 靜默 */ }
          } else {
            const uploaded = await uploadMediaFile(filePath, originalMessage, isFirst);
            if (uploaded) isFirst = false;
          }
        }

      } else if (event.type === "ce_applied") {
        // decay 單獨觸發且省下 < 1000 tokens → 靜默（避免每輪都發訊息）
        const saved = event.tokensBefore - event.tokensAfter;
        const hasHeavyStrategy = event.strategies.some(s => s !== "decay");
        if (!hasHeavyStrategy && saved < 1000) continue;
        const stratNames: Record<string, string> = {
          "compaction": "LLM 摘要壓縮",
          "overflow-hard-stop": "硬上限截斷",
          "decay": "漸進衰減",
        };
        const names = event.strategies.map(s => stratNames[s] ?? s).join(" + ");
        const ceMsg = `📦 **Context 壓縮**：${names}（${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens，節省 ${saved.toLocaleString()}）`;
        try { await send(ceMsg); isFirst = false; } catch { /* 靜默 */ }

      } else if (event.type === "context_warning") {
        const icon = event.level === "critical" ? "🔴" : "🟡";
        const pct = (event.utilization * 100).toFixed(1);
        const src = event.source === "model" ? "LLM Model" : "Session";
        const hint = event.level === "critical"
          ? "建議開新對話或執行 /reset-session"
          : "接近上限，請留意";
        const warnMsg = `${icon} **Context 用量警告**（${src}）：${pct}%（${event.estimatedTokens.toLocaleString()} / ${event.contextWindow.toLocaleString()} tokens）— ${hint}`;
        try { await send(warnMsg); isFirst = false; } catch { /* 靜默 */ }

      } else if (event.type === "error") {
        stopTyping();
        const errorMsg = `⚠️ ${event.message}`.slice(0, TEXT_LIMIT);
        if (useStreamEdit) {
          cancelEditTimer();
          await waitEditDone();
          // 若 progressMsg 還是空白 placeholder（無實質 segment 內容），直接 edit 為錯誤訊息
          if (progressMsg !== null && !segmentBuffer.trim()) {
            try { await (progressMsg as Message).edit(errorMsg); } catch { /* 靜默 */ }
            progressMsg = null; segmentBuffer = "";
          } else {
            await finalizeStreamEdit();
            await send(errorMsg);
            isFirst = false;
          }
        } else {
          cancelFlushTimer();
          if (!fileMode) await flush(true);
          await send(errorMsg);
          isFirst = false;
        }
      }
    }
  } finally {
    cancelFlushTimer();
    cancelEditTimer();
    stopTyping();
  }
}
