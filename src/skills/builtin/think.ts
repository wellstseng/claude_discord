/**
 * @file skills/builtin/think.ts
 * @description /think skill — 切換 extended thinking 模式（per-channel）
 *
 * 用法：
 *   /think          → 顯示當前狀態
 *   /think on       → 啟用 medium 等級
 *   /think high     → 啟用 high 等級（minimal / low / medium / high / xhigh）
 *   /think off      → 關閉
 */

import type { Skill } from "../types.js";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
const VALID_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

// ── per-channel thinking level store ─────────────────────────────────────────

const _thinkingMap = new Map<string, ThinkingLevel>();

export function getChannelThinking(channelId: string): ThinkingLevel | undefined {
  return _thinkingMap.get(channelId);
}

export function setChannelThinking(channelId: string, level: ThinkingLevel | null): void {
  if (level === null) {
    _thinkingMap.delete(channelId);
  } else {
    _thinkingMap.set(channelId, level);
  }
}

// ── /think skill ──────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "think",
  description: "切換 extended thinking 模式（on / off / minimal / low / medium / high / xhigh）",
  tier: "standard",
  trigger: ["/think"],

  async execute({ channelId, args }) {
    const current = getChannelThinking(channelId);
    const arg = args.trim().toLowerCase();

    if (!arg) {
      const status = current ? `✅ 已啟用（${current}）` : "⭕ 已關閉";
      return { text: `🧠 Extended Thinking：${status}\n用法：\`/think on\` / \`/think off\` / \`/think <level>\`\n等級：${VALID_LEVELS.join(" | ")}` };
    }

    if (arg === "off" || arg === "false" || arg === "0") {
      setChannelThinking(channelId, null);
      return { text: "🧠 Extended Thinking 已關閉" };
    }

    const level: ThinkingLevel = (arg === "on" || arg === "true") ? "medium"
      : VALID_LEVELS.includes(arg as ThinkingLevel) ? arg as ThinkingLevel
      : "medium";

    if (arg !== "on" && arg !== "true" && !VALID_LEVELS.includes(arg as ThinkingLevel)) {
      return { text: `❌ 無效等級：\`${arg}\`\n有效值：${VALID_LEVELS.join(" | ")}`, isError: true };
    }

    setChannelThinking(channelId, level);
    return { text: `🧠 Extended Thinking 已啟用（${level}）\n下次對話開始生效。` };
  },
};
