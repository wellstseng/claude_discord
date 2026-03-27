/**
 * @file skills/builtin/subagents.ts
 * @description /subagents skill — 使用者查詢/終止子 agent
 *
 * 用法：
 *   /subagents              → 列出所有子 agent（表格）
 *   /subagents kill <id>    → 終止指定
 *   /subagents kill all     → 終止所有
 */

import type { Skill } from "../types.js";
import { getSubagentRegistry } from "../../core/subagent-registry.js";
import { getPlatformSessionManager } from "../../core/platform.js";

export const skill: Skill = {
  name: "subagents",
  description: "查詢與管理子 agent（/subagents / /subagents kill <id>）",
  tier: "standard",
  trigger: ["/subagents"],

  async execute({ args, channelId }) {
    const registry = getSubagentRegistry();
    if (!registry) return { text: "❌ SubagentRegistry 尚未初始化", isError: true };

    // 找到此頻道對應的 sessionKey
    const sessionManager = getPlatformSessionManager();
    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === channelId);
    const sessionKey = session?.sessionKey ?? `discord:ch:${channelId}`;

    const trimmed = args.trim().toLowerCase();

    // kill 指令
    if (trimmed.startsWith("kill")) {
      const target = args.trim().slice(4).trim();

      if (!target || target === "all") {
        const count = registry.killAll(sessionKey);
        return { text: count > 0 ? `🛑 已終止 ${count} 個子 agent` : "ℹ️ 沒有進行中的子 agent" };
      }

      const ok = registry.kill(target);
      return { text: ok ? `🛑 已終止 ${target.slice(0, 8)}` : `❌ 找不到或已結束：${target.slice(0, 8)}` };
    }

    // 預設：列出所有子 agent
    const records = registry.listByParent(sessionKey);
    if (records.length === 0) return { text: "ℹ️ 目前無子 agent 記錄" };

    const statusIcon: Record<string, string> = {
      running:   "🔄",
      completed: "✅",
      failed:    "❌",
      killed:    "🛑",
      timeout:   "⏱️",
    };

    const lines = [
      "**子 Agent 列表**",
      "```",
      "狀態  標籤              時長  Runtime   RunId",
      "----  ----------------  ----  --------  --------",
    ];

    for (const r of records) {
      const icon = statusIcon[r.status] ?? "?";
      const dur = r.endedAt
        ? `${Math.round((r.endedAt - r.createdAt) / 1000)}s`
        : `${Math.round((Date.now() - r.createdAt) / 1000)}s+`;
      const label = (r.label ?? r.runId.slice(0, 12)).padEnd(16).slice(0, 16);
      const durStr = dur.padEnd(4);
      const rt = r.runtime.padEnd(8);
      const id = r.runId.slice(0, 8);
      lines.push(`${icon}     ${label}  ${durStr}  ${rt}  ${id}`);
    }

    lines.push("```");
    return { text: lines.join("\n") };
  },
};
