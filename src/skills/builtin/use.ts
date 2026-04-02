/**
 * @file skills/builtin/use.ts
 * @description /use skill — 暫時切換此 channel 的 provider（runtime，不改 config）
 *
 * 用法：
 *   /use              → 顯示當前 channel 的 provider override
 *   /use <id>         → 切換到指定 provider
 *   /use reset        → 清除 override，回到 routing 預設
 */

import type { Skill } from "../types.js";
import { getProviderRegistry } from "../../providers/registry.js";

// ── per-channel provider override store ──────────────────────────────────────

const _channelProviderMap = new Map<string, string>();

export function getChannelProviderOverride(channelId: string): string | undefined {
  return _channelProviderMap.get(channelId);
}

export function setChannelProviderOverride(channelId: string, providerId: string | null): void {
  if (providerId === null) {
    _channelProviderMap.delete(channelId);
  } else {
    _channelProviderMap.set(channelId, providerId);
  }
}

// ── /use skill ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "use",
  description: "暫時切換此頻道的 LLM provider（runtime，不改 config）",
  tier: "admin",
  trigger: ["/use"],

  async execute({ channelId, args }) {
    const arg = args.trim();
    const current = getChannelProviderOverride(channelId);

    if (!arg) {
      const providerRegistry = getProviderRegistry();
      const all = providerRegistry.list().map(p => {
        const model = p.modelId ? ` (${p.modelId})` : "";
        return `\`${p.id}\`${model}`;
      }).join("  ");
      const status = current ? `\`${current}\` (覆寫中)` : "依 routing 設定（未覆寫）";
      return { text: `🔌 **Provider**：${status}\n可用：${all}\n用法：\`/use <id>\` 或 \`/use reset\`` };
    }

    if (arg === "reset" || arg === "default") {
      setChannelProviderOverride(channelId, null);
      return { text: "🔌 Provider 覆寫已清除，回到 routing 預設。" };
    }

    // 驗證 provider 存在（registry.get 自動解析 alias）
    const providerRegistry = getProviderRegistry();
    const p = providerRegistry.get(arg);
    if (!p) {
      const all = providerRegistry.list().map(p2 => `\`${p2.id}\``).join("  ");
      return { text: `❌ Provider \`${arg}\` 不存在。\n可用：${all}`, isError: true };
    }

    setChannelProviderOverride(channelId, p.id);
    const modelSuffix = p.modelId ? ` — ${p.modelId}` : "";
    return { text: `🔌 此頻道已切換至 \`${arg}\`（${p.name}${modelSuffix}）。下次對話生效。` };
  },
};
