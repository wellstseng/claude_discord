/**
 * @file tools/builtin/skill.ts
 * @description skill — LLM 可呼叫 builtin skill 指令
 *
 * 讓 Agent Loop 中的 LLM 直接執行 /cron、/session 等 builtin skill，
 * 不需要引導使用者手動輸入指令。
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "skill",
  description:
    "執行 CatClaw builtin skill 指令。可用 skill 清單已在系統提示的「可用 Skill 指令」區段列出。" +
    "傳入 skill 的觸發指令（如 /cron、/session list）即可執行。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 4000,
  concurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "完整的 skill 指令（含觸發前綴），例如 \"/cron list\"、\"/session clear\"、\"/help\"",
      },
    },
    required: ["command"],
  },

  async execute(params, ctx) {
    const command = String(params["command"] ?? "").trim();
    if (!command) return { error: "command 不能為空" };

    // 攔截常見誤用：把 MCP tool 當 skill 呼叫
    if (/^\/mcp[\s_]/i.test(command)) {
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return {
        error: `「${preview}」不是 skill。MCP tool 請直接以 tool 名稱呼叫（例：mcp_catclaw-discord_discord、mcp_github_create_issue），不要用 skill tool 包裝 /mcp 語法。`,
      };
    }

    // 比對 skill
    const { matchSkill } = await import("../../skills/registry.js");
    const match = matchSkill(command);
    if (!match) {
      return { error: `找不到對應的 skill：「${command}」` };
    }

    const { skill, args } = match;

    // 權限檢查（admin agent 跳過 tier 檢查——tool registry 已驗證 tool tier）
    if (!ctx.isAdmin) {
      try {
        const { isPlatformReady } = await import("../../core/platform.js");
        if (isPlatformReady()) {
          const { getPlatformPermissionGate } = await import("../../core/platform.js");
          const tierCheck = getPlatformPermissionGate().checkTier(ctx.accountId, skill.tier);
          if (!tierCheck.allowed) {
            return { error: `權限不足：${tierCheck.reason ?? "tier 限制"}` };
          }
        }
      } catch {
        // platform 未就緒，跳過權限檢查
      }
    }

    // 建構 SkillContext（無 Discord Message）
    const { getBootAgentId } = await import("../../core/agent-loader.js");
    const { config } = await import("../../core/config.js");

    // 若 agent 是 admin（config.json admin flag），authorId 用 allowedUserIds[0]
    // 讓 skill 內部的 isAdmin() 檢查通過
    const adminIds = (config.admin as { allowedUserIds?: string[] } | undefined)?.allowedUserIds ?? [];
    const effectiveAuthorId = ctx.isAdmin && adminIds.length > 0
      ? adminIds[0]!
      : ctx.accountId;

    const skillCtx = {
      args,
      channelId: ctx.channelId,
      authorId: effectiveAuthorId,
      accountId: ctx.accountId,
      agentId: ctx.agentId ?? getBootAgentId(),
      config,
    };

    // Preflight
    if (skill.preflight) {
      const check = await skill.preflight(skillCtx);
      if (!check.ok) {
        return { error: `${skill.name} 無法執行：${check.reason ?? "前置檢查失敗"}` };
      }
    }

    // 執行
    try {
      const result = await skill.execute(skillCtx);
      if (result.isError) {
        return result.validation ? { error: result.text, validation: true } : { error: result.text };
      }
      return { result: result.text };
    } catch (err) {
      return { error: `skill ${skill.name} 執行失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
