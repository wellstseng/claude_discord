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
import { upsertIndex } from "./index-manager.js";

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
  /** 建立時間（Unix ms，用於 ACT-R activation 計算） */
  createdAt?: number;
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
  createdAt?: number;
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
  let createdAt: number | undefined;
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
      case "created-at":   createdAt = parseInt(val.trim(), 10) || undefined; break;
      case "last-used":    lastUsed = val.trim(); break;
      case "confirmations": confirmations = parseInt(val.trim(), 10) || 0; break;
      case "related":
        related = val.split(",").map(s => s.trim()).filter(Boolean); break;
    }
  }

  return { description, confidence, scope, triggers, createdAt, lastUsed, confirmations, related, content };
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
  /** 向量搜尋 namespace（應匹配 recall layerToNs，e.g. "project/id", "account/id"） */
  namespace?: string;
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
    `- Created-at: ${Date.now()}`,
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

  // 同步更新 MEMORY.md index（trigger matching 依賴此 index）
  const memoryMdPath = join(dir, "MEMORY.md");
  try {
    upsertIndex(memoryMdPath, {
      name,
      path: `${name}.md`,
      triggers: opts.triggers ?? [],
      confidence: opts.confidence ?? "[臨]",
    });
    log.debug(`[atom] 更新 MEMORY.md index：${name}`);
  } catch (err) {
    log.warn(`[atom] MEMORY.md index 更新失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // 自動 seed 進 LanceDB（fire-and-forget，vector service 不可用時靜默略過）
  const namespace = opts.namespace ?? opts.scope ?? "global";
  const embedText = `${opts.description ?? name}\n${opts.content}`;
  import("../vector/lancedb.js").then(({ getVectorService }) => {
    try {
      const vs = getVectorService();
      if (vs.isAvailable()) {
        vs.upsert(name, embedText, namespace, { path: filePath }).catch((err: unknown) => {
          log.debug(`[atom] auto-seed ${name} 失敗：${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch { /* vector service 未初始化，略過 */ }
  }).catch(() => { /* 動態 import 失敗，略過 */ });

  return filePath;
}

// ── ACT-R Activation ──────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * 近似 ACT-R base-level activation：B(i) = ln(Σ t_k^{-d})
 *
 * 假設 n 次存取均勻分布在 createdAt～lastUsed 之間。
 * 若無 createdAt，降級為 ln(n * t_last^{-d})（與舊公式相容）。
 *
 * @param d 衰減指數（預設 0.5）
 */
export function computeActivation(atom: Atom, d = 0.5): number {
  const n = Math.max(1, atom.confirmations);
  const nowMs = Date.now();

  const lastMs = atom.lastUsed
    ? new Date(atom.lastUsed).getTime()
    : (atom.createdAt ?? nowMs);
  const tLastDays = Math.max(0.1, (nowMs - lastMs) / MS_PER_DAY);

  // 降級：無 createdAt 或只有 1 次存取 → 舊公式
  if (!atom.createdAt || n <= 1) {
    return Math.log(n * Math.pow(tLastDays, -d));
  }

  // 均勻分布：n 次存取散布在 [createdAt, lastUsed] 區間
  const tCreatedDays = Math.max(0.1, (nowMs - atom.createdAt) / MS_PER_DAY);
  const spanDays = Math.max(0, tCreatedDays - tLastDays);
  const spacing = spanDays / (n - 1);

  let sum = 0;
  for (let k = 0; k < n; k++) {
    const t = Math.max(0.1, tLastDays + k * spacing);
    sum += Math.pow(t, -d);
  }

  return Math.log(Math.max(Number.EPSILON, sum));
}
