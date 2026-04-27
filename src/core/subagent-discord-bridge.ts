/**
 * @file core/subagent-discord-bridge.ts
 * @description Subagent ↔ Discord 橋接層
 *
 * 持有 Discord Client 引用，提供：
 * - sendSubagentNotification：SUB-4 async 完成通知
 * - createSubagentThread：SUB-5 持久子 agent thread 建立
 * - getSubagentThreadBinding：SUB-5 thread → childSessionKey 路由查詢
 */

import type { Client, TextChannel, ThreadChannel } from "discord.js";
import type { SubagentRunRecord } from "./subagent-registry.js";
import { log } from "../logger.js";

// ── Discord Client 引用 ───────────────────────────────────────────────────────

let _client: Client | null = null;

export function setDiscordClient(client: Client): void {
  _client = client;
}

export function getDiscordClient(): Client | null {
  return _client;
}

// ── Thread Binding（SUB-5）────────────────────────────────────────────────────

/** threadId → childSessionKey */
const _threadBindings = new Map<string, string>();

export function bindSubagentThread(threadId: string, childSessionKey: string): void {
  _threadBindings.set(threadId, childSessionKey);
  log.debug(`[subagent-discord-bridge] thread binding: ${threadId} → ${childSessionKey}`);
}

export function getSubagentThreadBinding(channelId: string): string | undefined {
  return _threadBindings.get(channelId);
}

export function unbindSubagentThread(threadId: string): void {
  _threadBindings.delete(threadId);
}

/** 建立 Discord Thread，回傳 threadId（失敗時回傳 null） */
export async function createSubagentThread(
  originChannelId: string,
  originMessageId: string,
  label: string,
  childSessionKey: string,
): Promise<string | null> {
  if (!_client) return null;

  try {
    const channel = await _client.channels.fetch(originChannelId);
    if (!channel || !("messages" in channel)) return null;

    const textChannel = channel as TextChannel;
    const originMsg = await textChannel.messages.fetch(originMessageId).catch(() => null);
    if (!originMsg) return null;

    const thread = await originMsg.startThread({
      name: `子 agent：${label}`,
      autoArchiveDuration: 1440,
    }) as ThreadChannel;

    bindSubagentThread(thread.id, childSessionKey);
    await thread.send(`🤖 **${label}** — 持久子 agent 已建立，在此 thread 繼續與它對話。`);
    return thread.id;
  } catch (err) {
    log.warn(`[subagent-discord-bridge] 建立 thread 失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Async 完成通知（SUB-4）───────────────────────────────────────────────────

export async function sendSubagentNotification(
  record: SubagentRunRecord,
  opts?: { error?: boolean },
): Promise<void> {
  if (!_client || !record.discordChannelId) return;

  try {
    const channel = await _client.channels.fetch(record.discordChannelId);
    if (!channel || !("send" in channel)) return;

    const label = record.label ?? `子任務 ${record.runId.slice(0, 8)}`;
    const textChannel = channel as TextChannel;

    if (opts?.error) {
      await textChannel.send(`❌ **${label}** 失敗：${record.error ?? "未知錯誤"}`);
    } else if (!record.result) {
      await textChannel.send(`✅ **${label}** 完成\n(無輸出)`);
    } else {
      // Discord 單訊息上限 2000，預留 header 與安全邊距 → 1900 給內容
      const headerLen = `✅ **${label}** 完成\n`.length;
      const inlineCap = 2000 - headerLen - 5; // 5 chars 安全邊距
      if (record.result.length <= inlineCap) {
        await textChannel.send(`✅ **${label}** 完成\n${record.result}`);
      } else {
        // 太長 → 完整內容用 .md 附件，訊息本體放摘要前段提示
        const previewLen = inlineCap - 80; // 留空間給尾段「…（完整內容見附件）」
        const preview = record.result.slice(0, previewLen);
        const note = `\n…（完整內容 ${record.result.length} 字，見附件）`;
        const buf = Buffer.from(record.result, "utf-8");
        const filename = `subagent-${record.runId.slice(0, 8)}.md`;
        try {
          await textChannel.send({
            content: `✅ **${label}** 完成\n${preview}${note}`,
            files: [{ attachment: buf, name: filename }],
          });
        } catch (err) {
          log.warn(`[subagent-discord-bridge] 附件上傳失敗，退回純文字截斷：${err instanceof Error ? err.message : String(err)}`);
          await textChannel.send(`✅ **${label}** 完成\n${preview}\n…（截斷，附件失敗）`);
        }
      }
    }
  } catch (err) {
    log.warn(`[subagent-discord-bridge] 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
