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
      // 用 cli-bridge 的 splitForDiscord（含 code fence 平衡 + 換行斷點）拆段
      const { splitForDiscord } = await import("../cli-bridge/reply.js");
      const header = `✅ **${label}** 完成`;
      const fullText = `${header}\n${record.result}`;
      const chunks = splitForDiscord(fullText);
      // 每段加序號（多段時才加）讓使用者看到全貌
      const total = chunks.length;
      for (let i = 0; i < total; i++) {
        const body = total > 1 ? `${chunks[i]}\n\n_(${i + 1}/${total})_` : chunks[i]!;
        await textChannel.send(body);
      }
    }
  } catch (err) {
    log.warn(`[subagent-discord-bridge] 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
