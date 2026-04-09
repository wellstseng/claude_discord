/**
 * @file workflow/memory-vector-sync.ts
 * @description file:modified → 自動向量同步
 *
 * 問題：Agent 用 write_file 直接寫 memory .md 時，只寫了檔案但沒有 upsert 向量。
 * 修法：監聽 file:modified，前綴比對判定是否為 memory 路徑，是則自動 upsert LanceDB。
 */

import { basename, dirname, relative } from "node:path";
import { readFileSync } from "node:fs";
import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

/** 不需要向量化的子目錄 */
const SKIP_DIRS = new Set(["_vectordb", "_staging", "_reference", "_session_notes", "episodic", "failures"]);

interface MemoryPaths {
  /** ~/.catclaw/memory/ 的展開絕對路徑 */
  memRoot: string;
  /** ~/.catclaw/agents/ 的展開絕對路徑 */
  agentsRoot: string;
}

/**
 * 判斷 filePath 是否為需要向量化的 memory atom，回傳 namespace 或 null。
 */
function resolveNamespace(filePath: string, paths: MemoryPaths): string | null {
  // 基本篩選
  if (!filePath.endsWith(".md")) return null;
  if (basename(filePath) === "MEMORY.md") return null;

  // 排除 SKIP_DIRS 子目錄
  const parts = filePath.split("/");
  for (const dir of SKIP_DIRS) {
    if (parts.includes(dir)) return null;
  }

  // Agent 層：~/.catclaw/agents/{agentId}/memory/xxx.md
  if (filePath.startsWith(paths.agentsRoot)) {
    const rel = relative(paths.agentsRoot, filePath); // {agentId}/memory/xxx.md
    const segments = rel.split("/");
    if (segments.length >= 3 && segments[1] === "memory") {
      return `agent/${segments[0]}`;
    }
    return null;
  }

  // memRoot 底下的各層
  if (!filePath.startsWith(paths.memRoot)) return null;

  const rel = relative(paths.memRoot, filePath);
  const segments = rel.split("/");

  // Project 層：projects/{projectId}/xxx.md
  if (segments[0] === "projects" && segments.length >= 3) {
    return `project/${segments[1]}`;
  }

  // Account 層：accounts/{accountId}/xxx.md
  if (segments[0] === "accounts" && segments.length >= 3) {
    return `account/${segments[1]}`;
  }

  // Global 層：直接在 memRoot 下
  return "global";
}

/**
 * 從 .md 檔解析 atom 描述行（用於 embedding text）
 * 簡易解析：取 # 標題 + 全文（跟 writeAtom auto-seed 邏輯一致）
 */
function buildEmbedText(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initMemoryVectorSync(eventBus: EventBus, memRoot: string, agentsRoot: string): void {
  const paths: MemoryPaths = {
    memRoot: memRoot.endsWith("/") ? memRoot.slice(0, -1) : memRoot,
    agentsRoot: agentsRoot.endsWith("/") ? agentsRoot.slice(0, -1) : agentsRoot,
  };

  eventBus.on("file:modified", (filePath, tool, _accountId) => {
    // 只處理非 writeAtom 來源（writeAtom 自己已做 upsert）
    // writeAtom 不經由 write_file tool，所以 tool 一定是 "write_file" 或 "edit_file"
    const ns = resolveNamespace(filePath, paths);
    if (!ns) return;

    const atomName = basename(filePath, ".md");
    const embedText = buildEmbedText(filePath);
    if (!embedText) return;

    // fire-and-forget（跟 writeAtom 的 auto-seed 策略一致）
    import("../vector/lancedb.js").then(({ getVectorService }) => {
      try {
        const vs = getVectorService();
        if (vs.isAvailable()) {
          vs.upsert(atomName, embedText, ns, { path: filePath }).catch((err: unknown) => {
            log.debug(`[memory-vector-sync] upsert 失敗 ${atomName}：${err instanceof Error ? err.message : String(err)}`);
          });
          log.debug(`[memory-vector-sync] auto-upsert ${atomName} → ${ns} (via ${tool})`);
        }
      } catch { /* vector service 未初始化，略過 */ }
    }).catch(() => { /* 動態 import 失敗，略過 */ });
  });

  log.info(`[memory-vector-sync] 已啟動（memRoot=${paths.memRoot}）`);
}
