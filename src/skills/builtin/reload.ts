/**
 * @file skills/builtin/reload.ts
 * @description /reload — 強制重建 frozen prompt snapshot
 *
 * 使用情境：
 * - 手動修改 CATCLAW.md 後想立即生效
 * - 想讓 agent 用最新 memory 內容重新 recall
 * - 工具 / skill 清單變動需要刷新
 *
 * 後果：下個 turn cache 必 miss 一次（snapshot 內容變了），之後恢復命中。
 */

import type { Skill } from "../types.js";
import { getPlatformSessionManager } from "../../core/platform.js";

export const reloadSkill: Skill = {
  name: "reload",
  description: "強制重建 frozen prompt snapshot（CATCLAW.md / 規則檔修改後生效；下個 turn cache miss 一次）",
  tier: "standard",
  trigger: ["/reload"],

  async execute({ channelId, accountId, agentId }) {
    const sessionManager = getPlatformSessionManager();
    const session = sessionManager.list().find(s => s.channelId === channelId);
    if (!session) {
      return { text: "❌ 此頻道尚無 session（先送一則訊息開啟 session 再 /reload）", isError: true };
    }

    try {
      const { prepareSessionSnapshot, setFrozenMaterials } = await import("../../core/session-snapshot.js");
      const { resolveWorkspaceDir } = await import("../../core/config.js");
      let workspaceDir: string | undefined;
      try { workspaceDir = resolveWorkspaceDir(); } catch { /* fallback */ }

      const materials = await prepareSessionSnapshot({
        sessionKey: session.sessionKey,
        accountId: session.accountId ?? accountId ?? "unknown",
        channelId,
        agentId,
        workspaceDir,
      });
      setFrozenMaterials(session.sessionKey, materials);

      const memBlockKb = (materials.memoryContextBlock.length / 1024).toFixed(1);
      return {
        text: [
          "✅ Frozen snapshot 已重建",
          `  preparedAt: ${materials.preparedAt}`,
          `  memoryBlock: ${memBlockKb} KB`,
          `  catclaw-md: ${materials.catclawMdText.length > 0 ? "✓" : "✗"}`,
          "",
          "下個 turn prompt cache 會 miss 一次，之後恢復命中。",
        ].join("\n"),
      };
    } catch (err) {
      return {
        text: `❌ 重建失敗：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

export const skill = reloadSkill;
