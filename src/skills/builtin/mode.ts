/**
 * @file skills/builtin/mode.ts
 * @description /mode skill — 切換運作模式（per-channel）
 *
 * 用法：
 *   /mode                → 顯示當前模式 + 可用列表
 *   /mode precision      → 切換到精密模式
 *   /mode normal         → 切換到一般模式
 *   /mode reset          → 重設為預設模式
 */

import type { Skill } from "../types.js";
import {
  getChannelMode,
  setChannelMode,
  resetChannelMode,
  listModes,
  resolveMode,
  getDefaultMode,
  getChannelModePreset,
} from "../../core/mode.js";

export const skill: Skill = {
  name: "mode",
  description: "切換運作模式（normal / precision / 自訂），影響 thinking、壓縮策略、行為約束",
  tier: "standard",
  trigger: ["/mode"],

  async execute({ channelId, args }) {
    const arg = args.trim().toLowerCase();
    const current = getChannelMode(channelId);
    const preset = getChannelModePreset(channelId);

    // 無參數：顯示狀態
    if (!arg) {
      const modes = listModes();
      const presetInfo = [
        `  thinking: ${preset.thinking ?? "off"}`,
        `  compaction: ${preset.compaction ?? "sliding-window"}`,
        `  resultTokenCap: ${preset.resultTokenCap ?? 8000}`,
        `  contextReserve: ${(preset.contextReserve ?? 0.2) * 100}%`,
        `  extras: ${(preset.systemPromptExtras ?? []).join(", ") || "none"}`,
      ].join("\n");

      return {
        text: `⚙️ 當前模式：**${current}**\n\`\`\`\n${presetInfo}\n\`\`\`\n可用模式：${modes.map(m => m === current ? `**${m}**` : m).join(" | ")}\n用法：\`/mode <name>\` / \`/mode reset\``,
      };
    }

    // reset
    if (arg === "reset") {
      resetChannelMode(channelId);
      const def = getDefaultMode();
      return { text: `⚙️ 已重設為預設模式：**${def}**` };
    }

    // 切換模式
    const target = resolveMode(arg);
    if (!target) {
      const modes = listModes();
      return { text: `❌ 未知模式：\`${arg}\`\n可用模式：${modes.join(" | ")}`, isError: true };
    }

    setChannelMode(channelId, arg);

    const info = [
      `thinking: ${target.thinking ?? "off"}`,
      `compaction: ${target.compaction ?? "sliding-window"}`,
      `resultTokenCap: ${target.resultTokenCap ?? 8000}`,
      `extras: ${(target.systemPromptExtras ?? []).join(", ") || "none"}`,
    ].join(" | ");

    return { text: `⚙️ 已切換到 **${arg}** 模式\n\`${info}\`` };
  },
};
