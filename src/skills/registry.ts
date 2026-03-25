/**
 * @file skills/registry.ts
 * @description Skill 註冊表 — 目錄掃描自動載入、trigger 前綴匹配
 *
 * 兩種 skill 類型：
 *   Command-type：TypeScript 直接執行（builtin/*.ts）
 *   Prompt-type ：SKILL.md 格式注入 system prompt（builtin-prompt/**／SKILL.md）
 *
 * 使用方式：
 *   await loadBuiltinSkills()          // 啟動時載入 builtin/
 *   await loadPromptSkills()           // 啟動時載入 builtin-prompt/
 *   const match = matchSkill(text)     // debounce callback 中攔截
 *   const prompt = buildSkillsPrompt() // acp.ts 注入 system prompt
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Skill } from "./types.js";
import { log } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 內部 Map ─────────────────────────────────────────────────────────────────

const skills = new Map<string, Skill>();

// ── 公開 API ─────────────────────────────────────────────────────────────────

/** 手動註冊一個 skill */
export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill);
  log.info(`[skills] 已載入：${skill.name}  triggers=[${skill.trigger.join(", ")}]`);
}

/**
 * 比對輸入文字，回傳匹配的 skill + 剩餘 args
 * 無匹配回傳 null
 */
export function matchSkill(text: string): { skill: Skill; args: string } | null {
  const lower = text.toLowerCase().trim();
  for (const skill of skills.values()) {
    for (const t of skill.trigger) {
      const tl = t.toLowerCase();
      if (
        lower === tl ||
        lower.startsWith(tl + " ") ||
        lower.startsWith(tl + "\n")
      ) {
        const args = text.slice(t.length).trim();
        return { skill, args };
      }
    }
  }
  return null;
}

/** 掃描 builtin/ 目錄，自動載入所有 export skill 的 .js 檔 */
export async function loadBuiltinSkills(): Promise<void> {
  const dir = join(__dirname, "builtin");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    log.warn("[skills] builtin 目錄不存在或無法讀取，跳過");
    return;
  }

  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { skill?: Skill };
      if (mod.skill) {
        registerSkill(mod.skill);
      }
    } catch (err) {
      log.warn(`[skills] 載入失敗：${file} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.info(`[skills] 載入完成，共 ${skills.size} 個 skill`);
}

// ── Prompt-type Skill ────────────────────────────────────────────────────────

interface PromptSkill {
  name: string;
  description: string;
  filePath: string; // SKILL.md 絕對路徑（供 Claude Read tool 使用）
}

const promptSkills: PromptSkill[] = [];

/**
 * 遞迴掃描 builtin-prompt/ 目錄，載入所有 SKILL.md
 * 目錄結構：builtin-prompt/{category}/SKILL.md 或 builtin-prompt/{category}/{sub}/SKILL.md
 */
export function loadPromptSkills(): void {
  const baseDir = join(__dirname, "builtin-prompt");
  if (!existsSync(baseDir)) {
    log.warn("[skills] builtin-prompt 目錄不存在，跳過");
    return;
  }

  const found = scanSkillMd(baseDir);
  for (const { name, filePath, content } of found) {
    promptSkills.push({ name, description: extractDescription(content), filePath });
    log.info(`[skills] Prompt-type 載入：${name}`);
  }
  log.info(`[skills] Prompt-type 載入完成，共 ${promptSkills.length} 個`);
}

/** 遞迴掃描目錄，回傳所有 SKILL.md 的 {name, filePath, content} */
function scanSkillMd(dir: string): Array<{ name: string; filePath: string; content: string }> {
  const result: Array<{ name: string; filePath: string; content: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === "SKILL.md") {
      try {
        const content = readFileSync(fullPath, "utf-8");
        // name 取自上層目錄名稱
        const name = dir.split(/[\\/]/).pop() ?? "unknown";
        result.push({ name, filePath: fullPath, content });
      } catch (err) {
        log.warn(`[skills] 讀取失敗：${fullPath} — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // 嘗試作為子目錄遞迴
      try {
        const sub = scanSkillMd(fullPath);
        result.push(...sub);
      } catch {
        // 非目錄，忽略
      }
    }
  }
  return result;
}

/** 從 SKILL.md 內容提取 description 欄位（YAML frontmatter） */
function extractDescription(content: string): string {
  const m = content.match(/^description:\s*(.+)$/m);
  return m?.[1]?.trim() ?? "";
}

/**
 * 產生 Prompt-type skill 的 system prompt 注入字串
 *
 * 仿 OpenClaw 兩段式：只注入清單（name + description + path）
 * Claude 需要時自己用 Read tool 讀取 SKILL.md 完整內容
 */
export function buildSkillsPrompt(): string {
  if (promptSkills.length === 0) return "";

  const items = promptSkills.map((s) =>
    `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>`
  ).join("\n");

  return `\n\n## Skills
Scan <available_skills> before replying.
- If a skill clearly applies: use Read tool to load the SKILL.md at <location>, then follow it.
- If none apply: do not load any SKILL.md.

<available_skills>
${items}
</available_skills>`;
}
