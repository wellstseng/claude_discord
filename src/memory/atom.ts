/**
 * @file memory/atom.ts
 * @description Atom CRUD — 讀寫記憶 atom 檔案（.md，YAML frontmatter 格式）
 *
 * Atom 格式沿用原子記憶 V2.18：
 *   # 標題
 *
 *   - Scope: global | project
 *   - Confidence: [固] | [觀] | [臨]
 *   - Trigger: {關鍵詞, 逗號分隔}
 *   - Last-used: {YYYY-MM-DD}
 *   - Confirmations: {數字}
 *   - Related: {相關 atom name}（可選）
 *
 *   ## 知識
 *   {內容}
 *
 * 注意：本系統使用原子記憶 V2.18 格式（非 YAML frontmatter `---` 格式）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { log } from "../logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

export type AtomConfidence = "[固]" | "[觀]" | "[臨]";
export type AtomScope = "global" | "project" | "account";

export interface Atom {
  /** Atom 檔名（不含 .md） */
  name: string;
  /** 完整檔案路徑 */
  path: string;
  /** 一行描述 */
  description: string;
  /** 信心等級 */
  confidence: AtomConfidence;
  /** 所屬層 */
  scope: AtomScope;
  /** 觸發關鍵詞列表 */
  triggers: string[];
  /** 最後使用日期（YYYY-MM-DD） */
  lastUsed?: string;
  /** 確認次數 */
  confirmations: number;
  /** 相關 atom 名稱列表 */
  related: string[];
  /** 原始 Markdown 全文 */
  raw: string;
  /** 純內容（去除 frontmatter header 後） */
  content: string;
}

// ── 解析工具 ─────────────────────────────────────────────────────────────────

/**
 * 解析 atom 的 metadata 行（`- Key: Value` 格式）
 * 從 markdown 的第一個 ## 前的內容提取
 */
function parseAtomMetadata(raw: string): {
  description: string;
  confidence: AtomConfidence;
  scope: AtomScope;
  triggers: string[];
  lastUsed?: string;
  confirmations: number;
  related: string[];
  content: string;
} {
  const lines = raw.split("\n");
  let description = "";
  let confidence: AtomConfidence = "[臨]";
  let scope: AtomScope = "global";
  let triggers: string[] = [];
  let lastUsed: string | undefined;
  let confirmations = 0;
  let related: string[] = [];

  // 找第一個 ## section 的位置（內容從這裡開始）
  const contentStartIdx = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
  const metaLines = contentStartIdx > 0 ? lines.slice(0, contentStartIdx) : lines;
  const content = contentStartIdx > 0 ? lines.slice(contentStartIdx).join("\n").trim() : "";

  for (const line of metaLines) {
    const m = line.match(/^-\s+(\w[\w-]*):\s+(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    switch (key.toLowerCase()) {
      case "description":  description = val.trim(); break;
      case "confidence":   confidence = val.trim() as AtomConfidence; break;
      case "scope":        scope = val.trim() as AtomScope; break;
      case "trigger":
      case "triggers":
        triggers = val.split(",").map(s => s.trim()).filter(Boolean); break;
      case "last-used":    lastUsed = val.trim(); break;
      case "confirmations": confirmations = parseInt(val.trim(), 10) || 0; break;
      case "related":
        related = val.split(",").map(s => s.trim()).filter(Boolean); break;
    }
  }

  return { description, confidence, scope, triggers, lastUsed, confirmations, related, content };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 從檔案路徑讀取並解析 atom
 */
export function readAtom(filePath: string): Atom | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const name = basename(filePath, extname(filePath));
    const meta = parseAtomMetadata(raw);
    return { name, path: filePath, raw, ...meta };
  } catch (err) {
    log.warn(`[atom] 讀取失敗 ${filePath}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 掃描目錄下所有 .md 檔案並解析為 atom 清單
 * 跳過以 `_` 開頭的目錄（staging/episodic 等）
 */
export function readAllAtoms(dir: string): Atom[] {
  if (!existsSync(dir)) return [];
  const atoms: Atom[] = [];

  function scan(currentDir: string) {
    let entries: string[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: false }) as string[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      if (entry.startsWith("_")) continue;     // 跳過 _staging / _vectordb 等
      if (entry === "MEMORY.md") continue;       // 索引檔不是 atom

      if (entry.endsWith(".md")) {
        const atom = readAtom(fullPath);
        if (atom) atoms.push(atom);
      }
    }
  }

  scan(dir);
  return atoms;
}

/**
 * 更新 atom 的 Last-used 日期 + Confirmations 計數（+1）
 * 用於 recall 命中時更新統計
 */
export function touchAtom(filePath: string): void {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);

    // 替換或插入 Last-used
    let updated = raw.replace(/^-\s+Last-used:\s+.+$/m, `- Last-used: ${today}`);
    if (!/^-\s+Last-used:/m.test(updated)) {
      // 在 Confirmations 行前插入
      updated = updated.replace(/^(-\s+Confirmations:)/m, `- Last-used: ${today}\n$1`);
    }

    // Confirmations +1
    updated = updated.replace(/^(-\s+Confirmations:\s+)(\d+)/m, (_, prefix, n) =>
      `${prefix}${parseInt(n, 10) + 1}`
    );

    writeFileSync(filePath, updated, "utf-8");
  } catch (err) {
    log.warn(`[atom] touchAtom 失敗 ${filePath}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 寫入新 atom 檔案（原子記憶 V2.18 格式）
 */
export function writeAtom(dir: string, name: string, opts: {
  description: string;
  confidence?: AtomConfidence;
  scope?: AtomScope;
  triggers?: string[];
  related?: string[];
  content: string;
}): string {
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, `${name}.md`);

  const lines = [
    `# ${name}`,
    "",
    `- Scope: ${opts.scope ?? "global"}`,
    `- Confidence: ${opts.confidence ?? "[臨]"}`,
    ...(opts.triggers?.length ? [`- Trigger: ${opts.triggers.join(", ")}`] : []),
    `- Last-used: ${today}`,
    `- Confirmations: 0`,
    ...(opts.related?.length ? [`- Related: ${opts.related.join(", ")}`] : []),
    "",
    `## 知識`,
    "",
    opts.content,
    "",
  ];

  if (!opts.description) {
    log.warn(`[atom] writeAtom ${name} 缺少 description`);
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
  log.debug(`[atom] 寫入 ${filePath}`);
  return filePath;
}
