/**
 * @file memory/index-manager.ts
 * @description MEMORY.md 索引管理 — 解析、查詢、更新
 *
 * MEMORY.md 格式（原子記憶 V2.18）：
 *   # Atom Index
 *   | Atom | Path | Trigger | Confidence |
 *   |------|------|---------|------------|
 *   | name | path/to/name.md | trigger1, trigger2 | [固] |
 *
 * 支援三層（global / project / account）各自獨立的 MEMORY.md
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

export interface IndexEntry {
  /** Atom 名稱 */
  name: string;
  /** Atom 檔案路徑（相對於 MEMORY.md 所在目錄） */
  path: string;
  /** 觸發關鍵詞列表 */
  triggers: string[];
  /** 信心等級 */
  confidence: string;
}

// ── 解析工具 ─────────────────────────────────────────────────────────────────

/**
 * 解析 MEMORY.md 中的 markdown table 行
 * 格式：| name | path | trigger1, trigger2 | [固] |
 */
function parseTableRow(line: string): IndexEntry | null {
  const parts = line.split("|").map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  // 跳過表頭行（含 "---"）
  if (parts[0].includes("---") || parts[0] === "Atom" || parts[0] === "atom") return null;

  const [name, path, triggerStr, confidence] = parts;
  const triggers = (triggerStr ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!name || !path) return null;
  return { name, path, triggers, confidence: confidence?.trim() ?? "" };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 讀取並解析 MEMORY.md，回傳 IndexEntry 清單
 */
export function loadIndex(memoryMdPath: string): IndexEntry[] {
  if (!existsSync(memoryMdPath)) return [];
  try {
    const raw = readFileSync(memoryMdPath, "utf-8");
    const entries: IndexEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.includes("|")) continue;
      const entry = parseTableRow(line);
      if (entry) entries.push(entry);
    }
    log.debug(`[index-manager] 載入 ${memoryMdPath}：${entries.length} 筆`);
    return entries;
  } catch (err) {
    log.warn(`[index-manager] 讀取失敗 ${memoryMdPath}：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Trigger 關鍵詞匹配
 * 輸入 prompt 文字，從索引中找出 trigger 有命中的 entry
 * 比對策略：全詞比對（大小寫不敏感）
 */
export function matchTriggers(prompt: string, entries: IndexEntry[]): IndexEntry[] {
  const lower = prompt.toLowerCase();
  return entries.filter(e =>
    e.triggers.some(t => lower.includes(t.toLowerCase()))
  );
}

/**
 * 更新或新增 MEMORY.md 的某個 atom entry
 * 若 entry 已存在（相同 name）→ 更新；不存在 → 新增
 */
export function upsertIndex(memoryMdPath: string, entry: IndexEntry): void {
  const dir = dirname(memoryMdPath);
  let content = existsSync(memoryMdPath) ? readFileSync(memoryMdPath, "utf-8") : "";

  const row = `| ${entry.name} | ${entry.path} | ${entry.triggers.join(", ")} | ${entry.confidence} |`;

  if (!content) {
    // 建立新 MEMORY.md
    content = [
      "# Atom Index",
      "",
      "| Atom | Path | Trigger | Confidence |",
      "|------|------|---------|------------|",
      row,
      "",
    ].join("\n");
    writeFileSync(memoryMdPath, content, "utf-8");
    return;
  }

  // 已有同名 entry → 替換
  const namePattern = new RegExp(`^\\|\\s*${entry.name}\\s*\\|.*$`, "m");
  if (namePattern.test(content)) {
    content = content.replace(namePattern, row);
  } else {
    // 在最後一個 table 行後插入（找最後的 | 行）
    const lines = content.split("\n");
    let lastTableLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith("|")) { lastTableLine = i; break; }
    }
    if (lastTableLine >= 0) {
      lines.splice(lastTableLine + 1, 0, row);
      content = lines.join("\n");
    } else {
      content += `\n${row}\n`;
    }
  }

  writeFileSync(memoryMdPath, content, "utf-8");
  log.debug(`[index-manager] 更新 ${memoryMdPath}：${entry.name}`);
}

/**
 * 從 MEMORY.md 移除某個 atom entry
 */
export function removeIndex(memoryMdPath: string, atomName: string): void {
  if (!existsSync(memoryMdPath)) return;
  try {
    const content = readFileSync(memoryMdPath, "utf-8");
    const namePattern = new RegExp(`^\\|\\s*${atomName}\\s*\\|.*\\n?`, "m");
    const updated = content.replace(namePattern, "");
    writeFileSync(memoryMdPath, updated, "utf-8");
  } catch (err) {
    log.warn(`[index-manager] removeIndex 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
