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
  let buffer = "";
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

  // ── Streaming edit 狀態 ───────────────────────────────────────────────────
  let editMsg: Message | null = null;   // 目前正在被 live-edit 的訊息
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editBusy = false;  // 正在 await edit，避免重疊

  async function doEdit(): Promise<void> {
    if (!editMsg || !buffer.trim() || editBusy) return;
    const content = closeFenceIfOpen(buffer);
    const safeContent = content.length > TEXT_LIMIT ? content.slice(0, TEXT_LIMIT - 3) + "…" : content;
    try {
      editBusy = true;
      await editMsg.edit(safeContent);
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

  /** 建立新的 edit 目標訊息（並立刻把 buffer 寫入） */
  async function initEditMsg(initialContent = "💭"): Promise<void> {
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
      editMsg = msg;
    } catch (err) {
      log.debug(`[reply-handler] initEditMsg 失敗：${err instanceof Error ? err.message : String(err)}`);
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

  // ── Streaming edit：文字累積後 live-edit ────────────────────────────────
  const STREAM_SPLIT_THRESHOLD = TEXT_LIMIT - 100; // 1900

  async function streamEditTextDelta(text: string): Promise<void> {
    buffer += text;

    // 首次：建立 edit 目標訊息
    if (!editMsg) {
      await initEditMsg("💭");
    }

    // 超過安全上限 → 終結目前段，開新訊息
    if (buffer.length >= STREAM_SPLIT_THRESHOLD) {
      cancelEditTimer();
      await waitEditDone();
      await doEdit();           // 最終 edit 目前段
      editMsg = null;           // 重置，下次 initEditMsg 時開新訊息
      buffer = "";              // 清空已發送部分
      // 剩餘 text 已在 buffer（此次 call 全部 += 進去），實際上此 branch
      // 只會發生在 text 本身很短的情況，所以 buffer 已清空沒有 residue
    } else {
      scheduleEdit();
    }
  }

  async function finalizeStreamEdit(): Promise<void> {
    cancelEditTimer();
    await waitEditDone();
    if (buffer.trim()) {
      await doEdit();
    }
    editMsg = null;
    buffer = "";
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
            await finalizeStreamEdit();
          } else {
            cancelFlushTimer();
          }
          buffer = "";
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
        if (toolMode === "all") {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send(`🔧 使用工具：${event.name}`);
          if (isFirst) stopTyping();
          isFirst = false;
          editMsg = null; // 重置，下次文字重新起始
        } else if (toolMode === "summary" && !summaryHintSent) {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send("⏳ 處理中...");
          if (isFirst) stopTyping();
          isFirst = false;
          summaryHintSent = true;
          editMsg = null;
        }

      } else if (event.type === "tool_blocked") {
        if (toolMode !== "none") {
          if (useStreamEdit) { cancelEditTimer(); await finalizeStreamEdit(); }
          else { cancelFlushTimer(); if (!fileMode) await flush(true); }
          await send(`🚫 工具被阻擋：${event.name} — ${event.reason}`);
          if (isFirst) stopTyping();
          isFirst = false;
          editMsg = null;
        }

      } else if (event.type === "done") {
        if (useStreamEdit) { cancelEditTimer(); }
        else { cancelFlushTimer(); }
        stopTyping();

        // Fallback：LLM 回傳空字串時，送出預設訊息避免使用者完全收不到回覆
        if (!totalText.trim()) {
          totalText = "（抱歉，我暫時無法回覆這條訊息。請再試一次或換個方式描述。）";
          buffer = totalText;
          log.warn(`[reply-handler] LLM 回傳空字串，使用 fallback 回覆`);
        }

        const { text: cleanedText, mediaPaths } = extractMediaTokens(totalText);

        if (fileMode && mediaPaths.length === 0) {
          const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
          if (threadChannel) {
            const attachment = new AttachmentBuilder(Buffer.from(cleanedText, "utf-8"), { name: "response.md" });
            await threadChannel.send({ content: preview ?? undefined, files: [attachment] });
          } else {
            await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
          }
          isFirst = false;
        } else {
          if (useStreamEdit) {
            // 串流模式：buffer 已是完整文字，做最終 edit
            if (fileMode) buffer = cleanedText;
            else { const { text: cb } = extractMediaTokens(buffer); buffer = cb; }
            await waitEditDone();
            await doEdit();
            editMsg = null; buffer = "";
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
          // 若有空白 placeholder（editMsg 存在但 buffer 空），直接 edit 為錯誤訊息
          if (editMsg !== null && !buffer.trim()) {
            try { await (editMsg as Message).edit(errorMsg); } catch { /* 靜默 */ }
            editMsg = null; buffer = "";
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
