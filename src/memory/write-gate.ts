/**
 * @file memory/write-gate.ts
 * @description Write Gate — 品質閘門，防止重複/注入知識持久化
 *
 * Q1: 向量相似度 ≥ 0.80 → 跳過（dedup）
 * Q2: 使用者明確說「記住」→ 跳過 gate
 * Q4: Prompt Injection 過濾
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";

// ── Threat Pattern 分類偵測（擴充自原 INJECTION） ─────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions?/i,
  /forget\s+(everything|all|your|previous)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /pretend\s+(you|to)\s+(are|be)/i,
  /act\s+as\s+(if\s+you\s+are|a\s+)/i,
  /your\s+new\s+(role|persona|instruction)/i,
  /system\s+prompt/i,
  /<\|?(im_start|im_end|user|assistant|system)\|?>/i,
  /\[INST\]|\[\/INST\]/,
  /###\s+(Human|Assistant|System):/,
];

const EXFILTRATION_PATTERNS = [
  /curl\s+[^\n]*[\$\{]\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /wget\s+[^\n]*[\$\{]\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
  /cat\s+[^\n]*(~|\$HOME)\/\.(ssh|aws|gnupg|kube|docker|azure)/i,
];

const PERSISTENCE_PATTERNS = [
  /authorized_keys/i,
  /(~|\$HOME)\/\.ssh(\/|$)/i,
  /(~|\$HOME)\/\.catclaw\/\.env/i,
  /\.(zshrc|bashrc|profile|bash_profile|zprofile)/i,
  /crontab\s+-e|\/etc\/cron/i,
];

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{32,}\b/,
  /\bsk-ant-[a-zA-Z0-9_-]{32,}\b/,
  /BEGIN\s+(RSA|DSA|EC|OPENSSH)\s+PRIVATE\s+KEY/,
  /\b[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  /\bgh[ps]_[a-zA-Z0-9]{36,}\b/,
  /\bxox[bpsa]-[a-zA-Z0-9-]{10,}\b/,
];

export type ThreatCategory = "prompt_injection" | "exfiltration" | "persistence" | "secret";

export interface ThreatMatch {
  category: ThreatCategory;
  patternIndex: number;
  snippet: string;
}

/** 掃描文字，回傳所有命中的威脅 pattern。 */
export function scanThreats(text: string): ThreatMatch[] {
  const matches: ThreatMatch[] = [];
  const groups: Array<[ThreatCategory, RegExp[]]> = [
    ["prompt_injection", INJECTION_PATTERNS],
    ["exfiltration", EXFILTRATION_PATTERNS],
    ["persistence", PERSISTENCE_PATTERNS],
    ["secret", SECRET_PATTERNS],
  ];
  for (const [cat, pats] of groups) {
    for (let i = 0; i < pats.length; i++) {
      const m = text.match(pats[i]!);
      if (m) matches.push({ category: cat, patternIndex: i, snippet: m[0].slice(0, 80) });
    }
  }
  return matches;
}

/** 向後相容 — 舊呼叫端仍可用。內部走新 scanThreats。 */
export function hasInjectionPattern(text: string): boolean {
  return scanThreats(text).some(t => t.category === "prompt_injection");
}

// ── 主要 Write Gate 邏輯 ──────────────────────────────────────────────────────

export interface WriteGateOpts {
  /** 若 true，跳過向量 dedup（使用者明確說「記住」） */
  bypass?: boolean;
  /** dedup 向量相似度門檻（預設 0.80） */
  dedupThreshold?: number;
  /** 向量搜尋 namespace */
  namespace?: string;
}

export interface WriteGateResult {
  allowed: boolean;
  reason: "bypass" | "injection" | "duplicate" | "ok" | "quarantine";
  similarity?: number;
  /** 偵測到的威脅清單（reason=injection / quarantine 時帶） */
  threats?: ThreatMatch[];
}

/**
 * 檢查知識項目是否通過 write gate
 *
 * @param content   要寫入的知識文字
 * @param namespace 向量搜尋 namespace（用於 dedup 比對）
 * @param opts      選項
 */
export async function checkWriteGate(
  content: string,
  namespace: string,
  opts: WriteGateOpts = {}
): Promise<WriteGateResult> {
  const threshold = opts.dedupThreshold ?? 0.80;

  // ── Q2: bypass（使用者明確指示） ──
  if (opts.bypass) {
    log.debug("[write-gate] bypass — 跳過 gate");
    return { allowed: true, reason: "bypass" };
  }

  // ── Q4: Threat Pattern 分類偵測 ──
  const threats = scanThreats(content);
  if (threats.length > 0) {
    // 嚴重類別 → reject（reason=injection 維持向後相容）
    const reject = threats.filter(t => t.category === "prompt_injection" || t.category === "secret");
    if (reject.length > 0) {
      log.warn(`[write-gate] reject: ${[...new Set(reject.map(t => t.category))].join(", ")}`);
      return { allowed: false, reason: "injection", threats };
    }
    // 中等類別 → quarantine（caller 可選擇 writeQuarantine 落檔審核）
    const quarantine = threats.filter(t => t.category === "exfiltration" || t.category === "persistence");
    if (quarantine.length > 0) {
      log.warn(`[write-gate] quarantine: ${[...new Set(quarantine.map(t => t.category))].join(", ")}`);
      return { allowed: false, reason: "quarantine", threats };
    }
  }

  // ── Q1: 向量相似度 dedup ──
  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (vsvc.isAvailable()) {
      const results = await vsvc.search(content, {
        namespace,
        topK: 1,
        minScore: threshold,
      });
      if (results.length > 0 && results[0].score >= threshold) {
        log.debug(`[write-gate] dedup — 相似度 ${results[0].score.toFixed(3)} ≥ ${threshold}，跳過`);
        return { allowed: false, reason: "duplicate", similarity: results[0].score };
      }
    }
  } catch (err) {
    // Vector service 不可用 → 放行（graceful）
    log.debug(`[write-gate] vector 不可用，放行：${err instanceof Error ? err.message : String(err)}`);
  }

  return { allowed: true, reason: "ok" };
}

// ── Quarantine 寫入 ──────────────────────────────────────────────────────────

export interface QuarantineCtx {
  /** workspace 根目錄（用於決定 _staging/quarantine/ 位置） */
  workspaceDir: string;
  /** 觸發的 agent ID（記錄用） */
  agentId?: string;
  /** 額外說明（記錄用） */
  reason?: string;
}

/**
 * 把疑似威脅內容寫入 _staging/quarantine/，標 requires_review 等待 /memory-review 審核。
 *
 * @returns 寫入的絕對路徑
 */
export async function writeQuarantine(
  content: string,
  threats: ThreatMatch[],
  ctx: QuarantineCtx,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const cat = threats[0]?.category ?? "unknown";
  const dir = join(ctx.workspaceDir, "_staging", "quarantine");
  await mkdir(dir, { recursive: true });
  const filename = `${ts}-${cat}.md`;
  const path = join(dir, filename);
  const categories = [...new Set(threats.map(t => t.category))];
  const body = [
    `---`,
    `quarantined_at: ${new Date().toISOString()}`,
    `agent_id: ${ctx.agentId ?? "unknown"}`,
    `categories: [${categories.join(", ")}]`,
    `reason: ${ctx.reason ?? "auto-detected threat patterns"}`,
    `requires_review: true`,
    `---`,
    ``,
    `## Threats Detected`,
    ...threats.map(t => `- [${t.category}] pattern[${t.patternIndex}] snippet: \`${t.snippet}\``),
    ``,
    `## Original Content`,
    ``,
    content,
    ``,
  ].join("\n");
  await writeFile(path, body, "utf-8");
  log.info(`[write-gate] quarantined to ${path}`);
  return path;
}
