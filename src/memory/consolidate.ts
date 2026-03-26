/**
 * @file memory/consolidate.ts
 * @description 鞏固與演進 — 晉升 + Decay + Archive
 *
 * C1: recall 命中 → confirmations +1（touchAtom，在 recall.ts 呼叫）
 * C2: 建議晉升 [觀]→[固]（confirmations ≥ suggestPromoteThreshold，需使用者確認）
 * C3: 自動晉升 [臨]→[觀]（confirmations ≥ autoPromoteThreshold）
 * C4: Decay 評分（score = 0.5 * recency + 0.5 * usage，half_life=30d）
 * C5: Archive candidates（score < archiveThreshold）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import { readAllAtoms, type Atom, type AtomConfidence } from "./atom.js";

// ── Decay 評分 ────────────────────────────────────────────────────────────────

const HALF_LIFE_FACTOR = Math.log(2); // ln(2)

/**
 * Decay 分數：score = 0.5 * recency + 0.5 * usage_norm
 * recency = exp(-lambda * days)，half_life = 30d
 * usage_norm = min(1, confirmations / 20)
 */
function decayScore(atom: Atom, halfLifeDays: number): number {
  let days = 30;
  if (atom.lastUsed) {
    const ms = Date.now() - new Date(atom.lastUsed).getTime();
    days = Math.max(0, ms / (1000 * 60 * 60 * 24));
  }
  const lambda = HALF_LIFE_FACTOR / halfLifeDays;
  const recency = Math.exp(-lambda * days);
  const usageNorm = Math.min(1, atom.confirmations / 20);
  return 0.5 * recency + 0.5 * usageNorm;
}

// ── 晉升 ──────────────────────────────────────────────────────────────────────

export interface PromotionCandidate {
  atom: Atom;
  from: AtomConfidence;
  to: AtomConfidence;
  /** true = 自動執行；false = 需使用者確認 */
  auto: boolean;
}

export interface ArchiveCandidate {
  atom: Atom;
  score: number;
}

/** 自動晉升 [臨]→[觀]：直接改寫檔案 */
function autoPromote(atom: Atom): void {
  try {
    const raw = readFileSync(atom.path, "utf-8");
    const updated = raw.replace(
      /^(-\s+Confidence:\s+)\[臨\]/m,
      "$1[觀]"
    );
    if (updated !== raw) {
      writeFileSync(atom.path, updated, "utf-8");
      log.info(`[consolidate] 自動晉升 [臨]→[觀]：${atom.name}`);
    }
  } catch (err) {
    log.warn(`[consolidate] autoPromote 失敗 ${atom.name}：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export interface ConsolidateOpts {
  autoPromoteThreshold: number;    // [臨]→[觀]（預設 20）
  suggestPromoteThreshold: number; // 建議 [觀]→[固]（預設 4）
  halfLifeDays: number;
  archiveThreshold: number;
  /** Archive candidate 清單寫入路徑 */
  archiveCandidatesPath?: string;
}

export interface ConsolidateResult {
  promoted: PromotionCandidate[];
  archiveCandidates: ArchiveCandidate[];
}

/**
 * 掃描指定目錄，執行晉升 + Decay 評估
 */
export async function consolidate(
  memoryDir: string,
  opts: ConsolidateOpts
): Promise<ConsolidateResult> {
  if (!existsSync(memoryDir)) return { promoted: [], archiveCandidates: [] };

  const atoms = readAllAtoms(memoryDir);
  const promoted: PromotionCandidate[] = [];
  const archiveCandidates: ArchiveCandidate[] = [];

  for (const atom of atoms) {
    // ── C3: 自動晉升 [臨]→[觀] ──
    if (atom.confidence === "[臨]" && atom.confirmations >= opts.autoPromoteThreshold) {
      autoPromote(atom);
      promoted.push({ atom, from: "[臨]", to: "[觀]", auto: true });
    }

    // ── C2: 建議晉升 [觀]→[固] ──
    if (atom.confidence === "[觀]" && atom.confirmations >= opts.suggestPromoteThreshold) {
      promoted.push({ atom, from: "[觀]", to: "[固]", auto: false });
    }

    // ── C4/C5: Decay 評分 ──
    const score = decayScore(atom, opts.halfLifeDays);
    if (score < opts.archiveThreshold) {
      archiveCandidates.push({ atom, score });
    }
  }

  // ── C5: 寫入 archive-candidates.md ──
  if (archiveCandidates.length > 0 && opts.archiveCandidatesPath) {
    try {
      mkdirSync(join(opts.archiveCandidatesPath, ".."), { recursive: true });
      const lines = [
        "# Archive Candidates",
        "",
        `Generated: ${new Date().toISOString()}`,
        "",
        "| Atom | Score | Last Used | Confirmations |",
        "|------|-------|-----------|---------------|",
        ...archiveCandidates.map(c =>
          `| ${c.atom.name} | ${c.score.toFixed(3)} | ${c.atom.lastUsed ?? "n/a"} | ${c.atom.confirmations} |`
        ),
        "",
      ];
      writeFileSync(opts.archiveCandidatesPath, lines.join("\n"), "utf-8");
    } catch (err) {
      log.warn(`[consolidate] 寫入 archive-candidates 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`[consolidate] ${memoryDir} → promoted=${promoted.length}，archive=${archiveCandidates.length}`);
  return { promoted, archiveCandidates };
}
