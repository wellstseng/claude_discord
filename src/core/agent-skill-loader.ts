/**
 * @file core/agent-skill-loader.ts
 * @description Agent Persona Skills — 掃描 agents/{id}/skills/*.md，解析 frontmatter 並組裝 prompt
 *
 * Skill 格式：
 * ```markdown
 * ---
 * name: stock-analysis
 * description: 專業股票技術分析
 * userInvocable: true
 * ---
 *
 * # 股票技術分析 Skill
 * 當使用者提到股票代號或要求分析時...
 * ```
 *
 * 載入策略：
 *   1. 掃描 agents/{id}/skills/*.md
 *   2. 若 config.json 有 skills 欄位 → 只載入指定的 skill
 *   3. 若 skills 欄位為空/未設 → 載入全部
 */

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { log } from "../logger.js";
import { resolveAgentDataDir } from "./agent-loader.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AgentSkill {
  name: string;
  description?: string;
  userInvocable?: boolean;
  /** frontmatter 以外的 body（prompt 內容） */
  body: string;
  /** 來源檔案路徑 */
  filePath: string;
}

// ── Frontmatter 解析 ────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    if (val === "true") val = true;
    else if (val === "false") val = false;
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 載入指定 agent 的 skills。
 * @param agentId Agent ID
 * @param filter 只載入這些 skill name（來自 config.json skills 欄位）；null/undefined = 全部
 */
export function loadAgentSkills(agentId: string, filter?: string[] | null): AgentSkill[] {
  const skillsDir = join(resolveAgentDataDir(agentId), "skills");
  if (!existsSync(skillsDir)) return [];

  const filterSet = filter?.length ? new Set(filter) : null;
  const skills: AgentSkill[] = [];

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter(f => f.endsWith(".md"));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(skillsDir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);

      const name = String(meta.name ?? file.replace(/\.md$/, ""));
      if (filterSet && !filterSet.has(name)) continue;

      skills.push({
        name,
        description: meta.description ? String(meta.description) : undefined,
        userInvocable: meta.userInvocable === true,
        body,
        filePath,
      });
    } catch (err) {
      log.warn(`[agent-skill-loader] 讀取失敗：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.debug(`[agent-skill-loader] agent=${agentId} loaded ${skills.length} skill(s)`);
  return skills;
}

/**
 * 將 skills 組裝為 system prompt 區塊。
 */
export function buildSkillsPrompt(skills: AgentSkill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map(s => {
    const header = s.description ? `### ${s.name} — ${s.description}` : `### ${s.name}`;
    return `${header}\n\n${s.body}`;
  });

  return `\n\n# Agent Skills\n\n以下是你的專屬 skills，遇到相關情境時請依照指示執行。\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * 產生 skill 自建提示（注入 system prompt，告知 agent 如何建立新 skill）。
 */
export function buildSkillCreationHint(agentId: string): string {
  const skillsDir = join(resolveAgentDataDir(agentId), "skills");
  return `\n\n# Skill 自建能力\n\n你可以用 write_file 在 \`${skillsDir}/\` 建立新的 skill 檔案（.md），下次被召喚時會自動載入。\n\n格式範例：\n\`\`\`markdown\n---\nname: my-skill\ndescription: 簡短說明\nuserInvocable: true\n---\n\n# Skill 標題\n\n具體指示內容...\n\`\`\``;
}
