/**
 * @file tools/builtin/clear-session.ts
 * @description clear_session — 讓 CatClaw bot（LLM）主動清除當前頻道的 session 歷史
 *
 * 解決 /clear 文字指令與 Discord slash command 衝突的問題。
 * LLM 可在對話中自行判斷何時清除（使用者要求、context 過長等）。
 */

import type { Tool } from "../types.js";
import { getSessionManager } from "../../core/session.js";
import { getTraceStore } from "../../core/message-trace.js";

export const tool: Tool = {
  name: "clear_session",
  description: [
    "清除當前頻道的 session 歷史（清空 messages + 重置 turnCount）。",
    "使用時機：使用者要求清除對話紀錄、開始新話題、context 過長需要重新開始。",
    "清除後 session 仍存在（保留 sessionKey），只是歷史歸零。",
    "可選 clear_traces=true 同時刪除該 session 的 trace 紀錄。",
  ].join(" "),
  tier: "standard",
  parameters: {
    type: "object",
    properties: {
      clear_traces: {
        type: "boolean",
        description: "是否同時清除該 session 的 trace 紀錄（預設 false）",
      },
    },
    required: [],
  },
  async execute(params, ctx) {
    const sessionManager = getSessionManager();
    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === ctx.channelId);

    if (!session) {
      return { result: "此頻道尚無 session 歷史，無需清除。" };
    }

    const msgCount = session.messages.length;
    const sessionKey = session.sessionKey;
    session.messages = [];
    session.turnCount = 0;

    let tracesDeleted = 0;
    if (params["clear_traces"]) {
      const traceStore = getTraceStore();
      tracesDeleted = traceStore?.deleteBySession(sessionKey) ?? 0;
    }

    const parts = [`Session 已清除（${msgCount} 條訊息已刪除）`];
    if (tracesDeleted > 0) parts.push(`${tracesDeleted} 筆 trace 已刪除`);
    return { result: parts.join("，") + "。" };
  },
};
