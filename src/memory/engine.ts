/**
 * @file memory/engine.ts
 * @description 記憶引擎 — 組裝所有 memory 子模組，對外提供 MemoryEngine 介面
 *
 * 生命週期：init() → recall/extract/write → shutdown()
 * 觸發點：EventBus 事件（turn:before, turn:after, session:idle, platform:shutdown）
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { initVectorService, getVectorService, resetVectorService } from "../vector/lancedb.js";
import { buildContext } from "./context-builder.js";
import type { MemoryConfig } from "../core/config.js";

// ── Re-export 子模組型別 ──────────────────────────────────────────────────────
export type { AtomFragment, MemoryLayer, RecallContext, RecallPaths, RecallResult } from "./recall.js";
export type { KnowledgeItem, KnowledgeType, KnowledgeTier, ExtractOpts } from "./extract.js";
export type { PromotionCandidate, ArchiveCandidate, ConsolidateResult } from "./consolidate.js";
export type { SessionStats, RutWarning } from "./episodic.js";
export type { ContextPayload } from "./context-builder.js";
export type { WriteGateResult } from "./write-gate.js";

// ── 路徑解析 ──────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function memRoot(cfg: MemoryConfig): string {
  return resolvePath(cfg.root);
}

function globalDir(cfg: MemoryConfig): string {
  return memRoot(cfg);
}

function projectDir(cfg: MemoryConfig, projectId: string): string {
  return join(memRoot(cfg), "projects", projectId);
}

function accountDir(cfg: MemoryConfig, accountId: string): string {
  return join(memRoot(cfg), "accounts", accountId);
}

function agentDir(agentId: string): string {
  return join(resolvePath("~/.catclaw"), "agents", agentId, "memory");
}

function episodicDir(cfg: MemoryConfig): string {
  return join(memRoot(cfg), "episodic");
}

// ── MemoryEngine ─────────────────────────────────────────────────────────────

export interface MemoryStatus {
  initialized: boolean;
  vectorAvailable: boolean;
  globalDir: string;
  projectCount: number;
  accountCount: number;
}

export class MemoryEngine {
  private cfg: MemoryConfig;
  private initialized = false;

  constructor(cfg: MemoryConfig) {
    this.cfg = cfg;
  }

  // ── 生命週期 ─────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    const gDir = globalDir(this.cfg);
    const vectorDbPath = resolvePath(this.cfg.vectorDbPath);

    // 確保目錄存在
    mkdirSync(gDir, { recursive: true });
    mkdirSync(vectorDbPath, { recursive: true });

    // 初始化 Vector Service
    try {
      const vsvc = initVectorService(vectorDbPath);
      await vsvc.init();
    } catch (err) {
      log.warn(`[memory-engine] VectorService 初始化失敗（graceful）：${err instanceof Error ? err.message : String(err)}`);
    }

    this.initialized = true;
    log.info(`[memory-engine] 初始化完成：global=${gDir}`);
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    resetVectorService();
    this.initialized = false;
    log.info("[memory-engine] 已關閉");
  }

  // ── Recall ───────────────────────────────────────────────────────────────────

  async recall(
    prompt: string,
    ctx: import("./recall.js").RecallContext,
    overrides?: { vectorSearch?: boolean; vectorTopK?: number }
  ): Promise<import("./recall.js").RecallResult> {
    const { recall } = await import("./recall.js");
    const paths: import("./recall.js").RecallPaths = {
      globalDir: globalDir(this.cfg),
      projectDir: ctx.projectId ? projectDir(this.cfg, ctx.projectId) : undefined,
      accountDir: ctx.accountId ? accountDir(this.cfg, ctx.accountId) : undefined,
      agentDir: ctx.agentId ? agentDir(ctx.agentId) : undefined,
    };
    const opts = overrides ? { ...this.cfg.recall, ...overrides } : this.cfg.recall;
    const startMs = Date.now();
    const result = await recall(prompt, ctx, paths, opts);

    // MemoryRecall hook（observer）
    try {
      const { getHookRegistry } = await import("../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("MemoryRecall", ctx.agentId) > 0) {
        await hookReg.runMemoryRecall({
          event: "MemoryRecall",
          query: prompt,
          hitCount: result.fragments?.length ?? 0,
          durationMs: Date.now() - startMs,
          agentId: ctx.agentId,
          accountId: ctx.accountId,
        });
      }
    } catch { /* ignore */ }

    return result;
  }

  // ── Context Build ─────────────────────────────────────────────────────────────

  buildContext(
    fragments: import("./recall.js").AtomFragment[],
    prompt: string,
    blindSpot = false
  ): import("./context-builder.js").ContextPayload {
    return buildContext(fragments, prompt, this.cfg.contextBudget, this.cfg.contextBudgetRatio, blindSpot);
  }

  // ── Extract ───────────────────────────────────────────────────────────────────

  /** 逐輪萃取（fire-and-forget） */
  extractPerTurn(
    newText: string,
    opts: import("./extract.js").ExtractOpts
  ): Promise<import("./extract.js").KnowledgeItem[]> {
    if (!this.cfg.extract.enabled || !this.cfg.extract.perTurn) return Promise.resolve([]);
    return import("./extract.js").then(({ extractPerTurn }) =>
      extractPerTurn(newText, { ...opts, maxItems: this.cfg.extract.maxItemsPerTurn, cooldownMs: this.cfg.extract.cooldownMs })
    );
  }

  // ── Write Gate ────────────────────────────────────────────────────────────────

  async checkWrite(
    content: string,
    namespace: string,
    bypass = false
  ): Promise<import("./write-gate.js").WriteGateResult> {
    const { checkWriteGate } = await import("./write-gate.js");
    return checkWriteGate(content, namespace, {
      bypass,
      dedupThreshold: this.cfg.writeGate.dedupThreshold,
    });
  }

  // ── Consolidate ───────────────────────────────────────────────────────────────

  async evaluatePromotions(
    memoryDir?: string
  ): Promise<import("./consolidate.js").ConsolidateResult> {
    const { consolidate } = await import("./consolidate.js");
    const dir = memoryDir ?? globalDir(this.cfg);
    const stagingDir = join(memRoot(this.cfg), "_staging");
    return consolidate(dir, {
      autoPromoteThreshold: this.cfg.consolidate.autoPromoteThreshold,
      suggestPromoteThreshold: this.cfg.consolidate.suggestPromoteThreshold,
      halfLifeDays: this.cfg.consolidate.decay.halfLifeDays,
      archiveThreshold: this.cfg.consolidate.decay.archiveThreshold,
      archiveCandidatesPath: join(stagingDir, "archive-candidates.md"),
    });
  }

  // ── Episodic ──────────────────────────────────────────────────────────────────

  async generateEpisodic(
    stats: import("./episodic.js").SessionStats
  ): Promise<string | null> {
    if (!this.cfg.episodic.enabled) return null;
    const { generateEpisodic } = await import("./episodic.js");
    return generateEpisodic(stats, {
      episodicDir: episodicDir(this.cfg),
      ttlDays: this.cfg.episodic.ttlDays,
    });
  }

  async detectRutPatterns(): Promise<import("./episodic.js").RutWarning[]> {
    if (!this.cfg.rutDetection.enabled) return [];
    const { detectRutPatterns } = await import("./episodic.js");
    return detectRutPatterns(episodicDir(this.cfg));
  }

  // ── 狀態 ─────────────────────────────────────────────────────────────────────

  getStatus(): MemoryStatus {
    let vectorAvailable = false;
    try {
      vectorAvailable = getVectorService().isAvailable();
    } catch { /* not initialized */ }

    const gDir = globalDir(this.cfg);
    const projectsDir = join(memRoot(this.cfg), "projects");
    const accountsDir = join(memRoot(this.cfg), "accounts");

    let projectCount = 0, accountCount = 0;
    try {
      if (existsSync(projectsDir)) projectCount = readdirSync(projectsDir).length;
    } catch { /* ignore */ }
    try {
      if (existsSync(accountsDir)) accountCount = readdirSync(accountsDir).length;
    } catch { /* ignore */ }

    return {
      initialized: this.initialized,
      vectorAvailable,
      globalDir: gDir,
      projectCount,
      accountCount,
    };
  }

  /**
   * 掃描記憶目錄下所有 atom .md 檔，嵌入並寫入 LanceDB
   * 用途：首次安裝或手動複製 atom 後補跑 embedding
   */
  async seedFromDir(dir: string, namespace: string): Promise<{ seeded: number; skipped: number; errors: number }> {
    const { readAtom } = await import("./atom.js");
    const { readdirSync, statSync, existsSync } = await import("node:fs");
    const { join: pathJoin, basename } = await import("node:path");

    let seeded = 0, skipped = 0, errors = 0;

    const resolvedDir = dir.startsWith("~") ? dir.replace("~", (await import("node:os")).homedir()) : dir;
    if (!existsSync(resolvedDir)) {
      log.warn(`[memory-engine] seedFromDir: 目錄不存在 ${resolvedDir}`);
      return { seeded, skipped, errors };
    }

    // 遞迴掃描，排除 _ 前綴目錄和非 .md 檔
    const SKIP_DIRS = new Set(["_vectordb", "episodic", "_staging", "_reference", "failures"]);
    function walkMd(d: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(d)) {
        if (entry.startsWith("_") || SKIP_DIRS.has(entry)) continue;
        const full = pathJoin(d, entry);
        if (statSync(full).isDirectory()) {
          results.push(...walkMd(full));
        } else if (entry.endsWith(".md") && entry !== "MEMORY.md") {
          results.push(full);
        }
      }
      return results;
    }

    const files = walkMd(resolvedDir);
    log.info(`[memory-engine] seedFromDir: 掃描到 ${files.length} 個 atom，namespace=${namespace}`);

    const { getVectorService } = await import("../vector/lancedb.js");
    const vs = getVectorService();

    for (const filePath of files) {
      const atomName = basename(filePath, ".md");
      try {
        const atom = readAtom(filePath);
        if (!atom) { skipped++; continue; }
        const text = `${atom.description ?? atomName}\n${atom.content}`;
        const written = await vs.upsert(atomName, text, namespace, { path: filePath });
        if (written) {
          seeded++;
          log.debug(`[memory-engine] seed ${atomName} → ${namespace}`);
        } else {
          skipped++;
          log.debug(`[memory-engine] seed ${atomName} skip — embedding unavailable`);
        }
      } catch (err) {
        errors++;
        log.warn(`[memory-engine] seed 失敗 ${atomName}：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log.info(`[memory-engine] seedFromDir 完成：seeded=${seeded} skipped=${skipped} errors=${errors}`);
    return { seeded, skipped, errors };
  }

  /** 重建向量索引（rebuild 指定 namespace） */
  async rebuildIndex(namespace: string): Promise<void> {
    try {
      const { getVectorService } = await import("../vector/lancedb.js");
      await getVectorService().rebuild(namespace);
    } catch (err) {
      log.warn(`[memory-engine] rebuildIndex 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 完整 drop table + 從 dir 重新 seed（embedding model 換維度後必須走這條）。
   * seedFromDir 只 upsert 不 drop，遇到舊維度 schema 會 schema 衝突靜默失敗。
   *
   * 成功 seed 至少 1 筆 → 寫入 embedding-meta.json 標記當前 model + dim，
   * 供 dashboard 比對偵測 model 漂移
   */
  async dropAndSeed(dir: string, namespace: string): Promise<{ dropped: boolean; seeded: number; skipped: number; errors: number }> {
    let dropped = false;
    try {
      const { getVectorService } = await import("../vector/lancedb.js");
      dropped = await getVectorService().dropTable(namespace);
    } catch (err) {
      log.warn(`[memory-engine] dropAndSeed: dropTable ${namespace} 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
    const result = await this.seedFromDir(dir, namespace);

    // 重建成功 → 標記當前 embedding model 與 dim 進 state
    if (result.seeded > 0) {
      try {
        const { getEmbeddingProvider } = await import("../vector/embedding-provider.js");
        const { writeEmbeddingMeta } = await import("../vector/embedding-state.js");
        const provider = getEmbeddingProvider();
        const dim = await provider.getDimensions();
        writeEmbeddingMeta(resolvePath(this.cfg.vectorDbPath), {
          model: provider.modelName,
          dim,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        log.debug(`[memory-engine] dropAndSeed 寫 embedding-meta 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { dropped, ...result };
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _engine: MemoryEngine | null = null;

export function initMemoryEngine(cfg: MemoryConfig): MemoryEngine {
  _engine = new MemoryEngine(cfg);
  return _engine;
}

export function getMemoryEngine(): MemoryEngine {
  if (!_engine) throw new Error("[memory-engine] 尚未初始化，請先呼叫 initMemoryEngine()");
  return _engine;
}

export function resetMemoryEngine(): void {
  _engine = null;
}
