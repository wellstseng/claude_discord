/**
 * @file skills/registry.ts
 * @description Skill 註冊表 — 目錄掃描自動載入、trigger 前綴匹配
 *
 * 使用方式：
 *   await loadBuiltinSkills()          // 啟動時載入 builtin/
 *   const match = matchSkill(text)     // debounce callback 中攔截
 *   if (match) { await match.skill.execute(ctx) }
 */

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
      const mod = (await import(join(dir, file))) as { skill?: Skill };
      if (mod.skill) {
        registerSkill(mod.skill);
      }
    } catch (err) {
      log.warn(`[skills] 載入失敗：${file} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.info(`[skills] 載入完成，共 ${skills.size} 個 skill`);
}
