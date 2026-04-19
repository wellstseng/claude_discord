/**
 * @file skills/builtin/help.ts
 * @description /help — 完整指令清單（trigger skills + slash commands + prompt skills）
 *
 * 列出所有指令，依權限標註可用/不可用。超過 Discord 字數限制自動分段。
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { log } from "../../logger.js";

const DISCORD_MAX_LEN = 1900; // 留 100 給 code block 前後綴

/** 角色 → 最高可存取 tier 對照 */
const TIER_ORDER = ["public", "standard", "elevated", "admin", "owner"] as const;
const ROLE_MAX_TIER: Record<string, string> = {
  guest: "public",
  member: "standard",
  developer: "elevated",
  admin: "admin",
  "platform-owner": "owner",
};

function tierIndex(tier: string): number {
  return TIER_ORDER.indexOf(tier as typeof TIER_ORDER[number]);
}

export const skill: Skill = {
  name: "help",
  description: "顯示所有指令清單（含權限標註）",
  tier: "public",
  trigger: ["/help"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    log.debug(`[skill:help] authorId=${ctx.authorId}`);

    try {
      // ── 取得呼叫者角色 ──
      let accountRole = "guest";
      try {
        const { isPlatformReady, resolveDiscordIdentity, getAccountRegistry } =
          await import("../../core/platform.js");
        if (isPlatformReady()) {
          const { accountId } = resolveDiscordIdentity(ctx.authorId, []);
          const account = getAccountRegistry().get(accountId);
          if (account) accountRole = account.role;
        }
      } catch { /* 無法取得角色 → guest */ }

      // admin 白名單補正（config.admin.allowedUserIds 裡的人一律算 admin）
      const adminIds = (ctx.config.admin as { allowedUserIds?: string[] } | undefined)?.allowedUserIds ?? [];
      if (adminIds.includes(ctx.authorId) && tierIndex(ROLE_MAX_TIER[accountRole] ?? "public") < tierIndex("admin")) {
        accountRole = "admin";
      }

      const maxTierIdx = tierIndex(ROLE_MAX_TIER[accountRole] ?? "public");

      // ── 蒐集 Trigger Skills ──
      const { listSkills } = await import("../registry.js");
      const allSkills = listSkills();
      const triggerLines: string[] = [];
      for (const s of allSkills) {
        const allowed = tierIndex(s.tier) <= maxTierIdx;
        const tag = allowed ? "" : " ⛔";
        const triggers = s.trigger.join(" | ");
        triggerLines.push(`  ${triggers}  — ${s.description} [${s.tier}]${tag}`);
      }

      // ── 蒐集 Discord Slash Commands ──
      // slash commands 在 slash.ts 定義，admin only
      const slashDefs: Array<{ name: string; desc: string }> = [
        { name: "/restart", desc: "重啟 CatClaw bot" },
        { name: "/reset-session", desc: "清除 Claude session [--channel_id] [--all]" },
        { name: "/status", desc: "查看 bot 狀態" },
        { name: "/cd <path>", desc: "切換 CLI Bridge 工作目錄" },
        { name: "/context", desc: "查看 context window 使用量" },
        { name: "/session <action> [id]", desc: "CLI Bridge session 管理 (status/new/set)" },
      ];
      const slashAllowed = tierIndex("admin") <= maxTierIdx;
      const slashLines = slashDefs.map(s => {
        const tag = slashAllowed ? "" : " ⛔";
        return `  ${s.name}  — ${s.desc} [admin]${tag}`;
      });

      // ── 蒐集 Prompt-type Skills ──
      let promptLines: string[] = [];
      try {
        const { buildSkillsPrompt } = await import("../registry.js");
        const prompt = buildSkillsPrompt();
        // 簡單解析 <name>...</name> 和 <description>...</description>
        const nameRe = /<name>(.+?)<\/name>/g;
        const descRe = /<description>(.+?)<\/description>/g;
        const names: string[] = [];
        const descs: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = nameRe.exec(prompt)) !== null) names.push(m[1]);
        while ((m = descRe.exec(prompt)) !== null) descs.push(m[1]);
        for (let i = 0; i < names.length; i++) {
          promptLines.push(`  /${names[i]}  — ${descs[i] || "(無說明)"} [prompt]`);
        }
      } catch { /* prompt skills 載入失敗 → 跳過 */ }

      // ── 組裝輸出 ──
      const sections: string[] = [];
      const displayRole = accountRole === "platform-owner" ? "admin" : accountRole;
      sections.push(`📋 **CatClaw 指令清單**（角色：${displayRole}）`);
      sections.push(`⛔ = 你的角色無法使用此指令\n`);

      sections.push(`**▸ Trigger Skills（文字觸發，${allSkills.length} 個）**`);
      sections.push(triggerLines.join("\n"));

      sections.push(`\n**▸ Discord Slash Commands（${slashDefs.length} 個）**`);
      sections.push(slashLines.join("\n"));

      if (promptLines.length > 0) {
        sections.push(`\n**▸ Prompt Skills（AI 注入型，${promptLines.length} 個）**`);
        sections.push(promptLines.join("\n"));
      }

      const full = sections.join("\n");

      // ── 分段處理（超過 Discord 上限就拆）──
      if (full.length <= DISCORD_MAX_LEN) {
        return { text: full };
      }

      // 按行拆段
      const lines = full.split("\n");
      const pages: string[] = [];
      let current = "";
      for (const line of lines) {
        if (current.length + line.length + 1 > DISCORD_MAX_LEN) {
          pages.push(current);
          current = line;
        } else {
          current += (current ? "\n" : "") + line;
        }
      }
      if (current) pages.push(current);

      // 回傳第一段，後續段透過 message.channel.send 送出
      const [first, ...rest] = pages;
      if (rest.length > 0) {
        // 非同步送出後續段
        void (async () => {
          for (const page of rest) {
            try {
              const ch = ctx.message?.channel;
              if (ch && "send" in ch) await ch.send(page);
            } catch (err) {
              log.warn(`[skill:help] 分段發送失敗：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
      }

      return { text: first! };
    } catch (err) {
      return {
        text: `❌ /help 失敗：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
