/**
 * @file vector/lancedb.ts
 * @description LanceDB in-process 向量資料庫 — VectorService 介面實作
 *
 * 設計原則：
 * - In-process：不需要 HTTP server（取代 Python memory-vector-service @ port 3849）
 * - Namespace 強制：global / project/{id} / account/{id}，空字串拒絕
 * - 每個 namespace 對應一個 LanceDB table，table 名稱 = namespace 轉底線
 * - Ollama offline 時 index/upsert/rebuild 回傳空 graceful；search 降級純關鍵字
 * - 非同步初始化：init() 必須在使用前呼叫
 */

import { connect, type Connection, type Table } from "@lancedb/lancedb";
import { log } from "../logger.js";
import { embedTexts, embedOne, getCachedDim } from "./embedding.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  namespace: string;
  path?: string;
  meta?: string;       // JSON string 儲存額外 metadata
  updatedAt: string;   // ISO 8601
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;       // cosine 相似度 (0–1)
  path?: string;
  meta?: string;
}

export interface SearchOpts {
  /** 必填：global / project/{id} / account/{id} */
  namespace: string;
  topK?: number;
  minScore?: number;
}

export interface VectorService {
  init(): Promise<void>;
  upsert(id: string, text: string, namespace: string, opts?: { path?: string; meta?: object }): Promise<boolean>;
  search(query: string | number[], opts: SearchOpts): Promise<SearchResult[]>;
  delete(id: string, namespace: string): Promise<void>;
  rebuild(namespace: string): Promise<void>;
  isAvailable(): boolean;
}

// ── Namespace 驗證 ────────────────────────────────────────────────────────────

const VALID_NS = /^(global|project\/[\w-]+|account\/[\w-]+)$/;

function validateNamespace(ns: string): void {
  if (!ns || !VALID_NS.test(ns)) {
    throw new Error(`[lancedb] 無效 namespace "${ns}"，格式：global / project/{id} / account/{id}`);
  }
}

/** namespace 轉 table 名稱（LanceDB 不接受 /） */
function nsToTable(ns: string): string {
  return ns.replace(/\//g, "__");
}

// ── LanceVectorService ────────────────────────────────────────────────────────

export class LanceVectorService implements VectorService {
  private db: Connection | null = null;
  private readonly dbPath: string;
  private initialized = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.db = await connect(this.dbPath);
      this.initialized = true;
      log.info(`[lancedb] 初始化完成：${this.dbPath}`);
    } catch (err) {
      log.warn(`[lancedb] 初始化失敗（graceful）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isAvailable(): boolean {
    return this.initialized && this.db !== null;
  }

  /** isReady alias（供 skill 直接呼叫） */
  isReady(): boolean {
    return this.isAvailable();
  }

  /** 回傳所有 table 的向量數 */
  async stats(): Promise<{ tables: { name: string; count: number }[] } | null> {
    if (!this.db) return null;
    try {
      const tableNames = await this.db.tableNames();
      const tables: { name: string; count: number }[] = [];
      for (const name of tableNames) {
        const table = await this.db.openTable(name);
        const count = await table.countRows();
        tables.push({ name, count });
      }
      return { tables };
    } catch (err) {
      log.warn(`[lancedb] stats 失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ── Upsert ──────────────────────────────────────────────────────────────────

  async upsert(
    id: string,
    text: string,
    namespace: string,
    opts: { path?: string; meta?: object } = {}
  ): Promise<boolean> {
    validateNamespace(namespace);
    if (!this.db) { log.debug("[lancedb] upsert skip — not initialized"); return false; }

    const { vectors, dim } = await embedTexts([text]);
    if (!vectors.length || !dim) {
      log.debug(`[lancedb] upsert ${id} skip — embedding not available`);
      return false;
    }

    const record: Record<string, unknown> = {
      id,
      vector: vectors[0],
      text,
      namespace,
      path: opts.path ?? "",       // LanceDB 不接受 null，用空字串代替
      meta: opts.meta ? JSON.stringify(opts.meta) : "",
      updatedAt: new Date().toISOString(),
    };

    try {
      const tableName = nsToTable(namespace);
      const tableList = await this.db.tableNames();

      if (!tableList.includes(tableName)) {
        await this.db.createTable(tableName, [record]);
        log.debug(`[lancedb] table "${tableName}" 建立`);
      } else {
        const table = await this.db.openTable(tableName);
        // upsert：先刪舊再插入
        await this.deleteFromTable(table, id);
        await table.add([record]);
      }
      return true;
    } catch (err) {
      log.warn(`[lancedb] upsert ${id} 失敗：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  async search(query: string | number[], opts: SearchOpts): Promise<SearchResult[]> {
    validateNamespace(opts.namespace);
    const topK = opts.topK ?? 10;
    const minScore = opts.minScore ?? 0.65;

    if (!this.db) return [];

    const tableName = nsToTable(opts.namespace);
    const tableList = await this.db.tableNames().catch(() => [] as string[]);
    if (!tableList.includes(tableName)) return [];

    // query → vector
    let queryVec: number[];
    if (Array.isArray(query)) {
      queryVec = query as number[];
    } else {
      const vec = await embedOne(query as string);
      if (!vec.length) return [];  // Ollama offline → graceful empty
      queryVec = vec;
    }

    try {
      const table = await this.db.openTable(tableName);
      const rawResults = await table
        .vectorSearch(queryVec)
        .limit(topK * 2)          // 多取再 filter，避免 minScore 後數量不足
        .toArray();

      // LanceDB 回傳 _distance（越小越近），轉換成 cosine 相似度
      const results: SearchResult[] = rawResults
        .map(r => ({
          id: r["id"] as string,
          text: r["text"] as string,
          score: 1 - (r["_distance"] as number ?? 0),
          path: (r["path"] as string) || undefined,
          meta: (r["meta"] as string) || undefined,
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      log.debug(`[lancedb] search "${opts.namespace}" → ${results.length} hits`);
      return results;
    } catch (err) {
      log.warn(`[lancedb] search 失敗：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async delete(id: string, namespace: string): Promise<void> {
    validateNamespace(namespace);
    if (!this.db) return;

    try {
      const tableName = nsToTable(namespace);
      const tableList = await this.db.tableNames().catch(() => [] as string[]);
      if (!tableList.includes(tableName)) return;

      const table = await this.db.openTable(tableName);
      await this.deleteFromTable(table, id);
    } catch (err) {
      log.warn(`[lancedb] delete ${id} 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Rebuild ──────────────────────────────────────────────────────────────────

  /**
   * 重建指定 namespace 的向量索引
   * 適用於：大批量 upsert 後、embedding model 更換後
   */
  async rebuild(namespace: string): Promise<void> {
    validateNamespace(namespace);
    if (!this.db) return;

    const tableName = nsToTable(namespace);
    try {
      const tableList = await this.db.tableNames();
      if (!tableList.includes(tableName)) {
        log.debug(`[lancedb] rebuild "${namespace}" skip — table 不存在`);
        return;
      }
      const table = await this.db.openTable(tableName);
      await table.createIndex("vector");
      log.info(`[lancedb] rebuild "${namespace}" 完成`);
    } catch (err) {
      log.warn(`[lancedb] rebuild "${namespace}" 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 內部 ─────────────────────────────────────────────────────────────────────

  private async deleteFromTable(table: Table, id: string): Promise<void> {
    try {
      await table.delete(`id = '${id.replace(/'/g, "''")}'`);
    } catch {
      // 不存在時靜默
    }
  }
}

// ── 全域單例 ─────────────────────────────────────────────────────────────────

let _service: LanceVectorService | null = null;

export function initVectorService(dbPath: string): LanceVectorService {
  _service = new LanceVectorService(dbPath);
  return _service;
}

export function getVectorService(): LanceVectorService {
  if (!_service) throw new Error("[lancedb] VectorService 尚未初始化，請先呼叫 initVectorService()");
  return _service;
}

export function resetVectorService(): void {
  _service = null;
}
