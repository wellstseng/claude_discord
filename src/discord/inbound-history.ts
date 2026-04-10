/**
 * @file discord/inbound-history.ts
 * @description Inbound History Store — 記錄未進入 agent loop 的 Discord 訊息
 *
 * 三 Bucket 處理流程（inject 時）：
 *   Bucket A（< fullWindowHours）→ 全量帶入
 *   Bucket B（fullWindowHours ~ decayWindowHours）→ LLM 壓縮（上限 bucketBTokenCap）
 *     Decay II：壓縮後仍超上限 → 截舊再壓（上限 decayIITokenCap，純程式）
 *   Bucket C（> decayWindowHours）→ 直接清除
 *
 * 消費後刪除這批 entries（append-only JSONL）。
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { LLMProvider } from "../providers/base.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface InboundEntry {
  ts: string;           // ISO 8601
  platform: string;     // "discord"
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  wasProcessed: false;  // 未消費
}

export interface InboundHistoryCfg {
  enabled: boolean;
  fullWindowHours: number;    // Bucket A 上限（預設 24）
  decayWindowHours: number;   // Bucket B/C 分界（預設 168）
  bucketBTokenCap: number;    // Bucket B 壓縮後 token 上限（預設 600）
  decayIITokenCap: number;    // Decay II 最終上限（預設 300）
  inject: { enabled: boolean };
}

const DEFAULT_CFG: InboundHistoryCfg = {
  enabled: true,
  fullWindowHours: 24,
  decayWindowHours: 168,
  bucketBTokenCap: 600,
  decayIITokenCap: 300,
  inject: { enabled: false },
};

// 粗估 token 數（4 chars/token）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── InboundHistoryStore ───────────────────────────────────────────────────────

export class InboundHistoryStore {
  private storeDir: string;

  constructor(dataDir: string) {
    this.storeDir = resolve(
      dataDir.startsWith("~") ? dataDir.replace("~", homedir()) : dataDir,
      "inbound",
    );
    mkdirSync(this.storeDir, { recursive: true });
  }

  // ── 寫入 ──────────────────────────────────────────────────────────────────

  /**
   * @param scope 區分不同 bot/agent 的命名空間（預設 "main"）
   */
  append(channelId: string, entry: InboundEntry, scope = "main"): void {
    try {
      const filePath = this._filePath(channelId, scope);
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log.warn(`[inbound-history] append 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 同時寫入多個 scope（同頻道多 bot 時，一則訊息需記給所有 bot）。
   */
  appendToScopes(channelId: string, entry: InboundEntry, scopes: string[]): void {
    for (const scope of scopes) {
      this.append(channelId, entry, scope);
    }
  }

  // ── 消費（inject） ────────────────────────────────────────────────────────

  /**
   * 讀取所有未消費 entries，依三 Bucket 處理，組裝 context string。
   * 消費後清除這批 entries（寫空檔）。
   * 若 inject.enabled=false 或無 entries，回傳 null。
   */
  async consumeForInjection(
    channelId: string,
    cfg: InboundHistoryCfg = DEFAULT_CFG,
    ceProvider?: LLMProvider,
    scope = "main",
  ): Promise<{ text: string; entriesCount: number; bucketA: number; bucketB: number } | null> {
    if (!cfg.inject.enabled) return null;

    const entries = this._readAll(channelId, scope);
    if (entries.length === 0) return null;

    const now = Date.now();
    const fullWindowMs  = cfg.fullWindowHours  * 3600_000;
    const decayWindowMs = cfg.decayWindowHours * 3600_000;

    // 分 Bucket
    const bucketA: InboundEntry[] = [];
    const bucketB: InboundEntry[] = [];
    // Bucket C 直接丟棄（不加入 context）

    for (const e of entries) {
      const age = now - new Date(e.ts).getTime();
      if (age <= fullWindowMs) {
        bucketA.push(e);
      } else if (age <= decayWindowMs) {
        bucketB.push(e);
      }
      // Bucket C：age > decayWindowMs → 丟棄
    }

    // Bucket A：全量帶入
    const bucketAText = bucketA.length > 0
      ? bucketA.map(e => `[${new Date(e.ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}] ${e.authorName}: ${e.content}`).join("\n")
      : "";

    // Bucket B：LLM 壓縮
    let bucketBText = "";
    if (bucketB.length > 0 && ceProvider) {
      bucketBText = await this._compressBucketB(bucketB, cfg, ceProvider);
    } else if (bucketB.length > 0) {
      // 無 ceProvider → 截斷至 bucketBTokenCap
      const raw = bucketB.map(e => `${e.authorName}: ${e.content}`).join("\n");
      bucketBText = raw.slice(0, cfg.bucketBTokenCap * 4);
    }

    // 消費完成：清空 JSONL
    this._clearFile(channelId, scope);

    // 組裝 context string
    const parts: string[] = [];
    if (bucketBText) parts.push(`[較早訊息摘要]\n${bucketBText}`);
    if (bucketAText) parts.push(`[最近 ${cfg.fullWindowHours}h 訊息]\n${bucketAText}`);

    if (parts.length === 0) return null;

    const text = `=== 頻道脈絡（未被處理的訊息） ===\n${parts.join("\n\n")}`;
    log.debug(`[inbound-history] inject channel=${channelId} bucketA=${bucketA.length} bucketB=${bucketB.length}`);
    return { text, entriesCount: entries.length, bucketA: bucketA.length, bucketB: bucketB.length };
  }

  // ── 公開查詢（Dashboard 用） ──────────────────────────────────────────────

  /** 列出所有有 pending entries 的 channel（含 scope） */
  listChannels(): Array<{ channelId: string; scope: string; count: number; lastTs: string }> {
    const results: Array<{ channelId: string; scope: string; count: number; lastTs: string }> = [];
    try {
      const files = readdirSync(this.storeDir).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        // 檔名格式：discord_{channelId}_{scope}.jsonl 或舊格式 discord_{channelId}.jsonl
        const m = f.match(/^discord_(.+?)(?:_([^.]+))?\.jsonl$/);
        if (!m) continue;
        const channelId = m[1]!;
        const scope = m[2] ?? "main";
        const entries = this._readAllByFile(join(this.storeDir, f));
        if (entries.length > 0) {
          results.push({
            channelId,
            scope,
            count: entries.length,
            lastTs: entries[entries.length - 1]!.ts,
          });
        }
      }
    } catch { /* 靜默 */ }
    return results.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  /** 讀取指定 channel + scope 的所有 pending entries */
  readEntries(channelId: string, scope = "main"): InboundEntry[] {
    return this._readAll(channelId, scope);
  }

  /** 清除指定 channel + scope 的 pending entries，回傳清除數量 */
  clearChannel(channelId: string, scope = "main"): number {
    const count = this._readAll(channelId, scope).length;
    this._clearFile(channelId, scope);
    return count;
  }

  /** 清除指定 channel 所有 scope 的 pending entries */
  clearChannelAllScopes(channelId: string): number {
    const safeCh = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let count = 0;
    try {
      const files = readdirSync(this.storeDir).filter(f => f.startsWith(`discord_${safeCh}`) && f.endsWith(".jsonl"));
      for (const f of files) {
        const entries = this._readAllByFile(join(this.storeDir, f));
        count += entries.length;
        if (entries.length > 0) writeFileSync(join(this.storeDir, f), "", "utf-8");
      }
    } catch { /* 靜默 */ }
    return count;
  }

  /** 清除所有 channel 的 pending entries，回傳清除數量 */
  clearAll(): number {
    let count = 0;
    try {
      const files = readdirSync(this.storeDir).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        const entries = this._readAllByFile(join(this.storeDir, f));
        count += entries.length;
        if (entries.length > 0) {
          writeFileSync(join(this.storeDir, f), "", "utf-8");
        }
      }
    } catch { /* 靜默 */ }
    return count;
  }

  // ── 私有輔助 ──────────────────────────────────────────────────────────────

  private _filePath(channelId: string, scope = "main"): string {
    const safeCh = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.storeDir, `discord_${safeCh}_${safeScope}.jsonl`);
  }

  private _readAll(channelId: string, scope = "main"): InboundEntry[] {
    return this._readAllByFile(this._filePath(channelId, scope));
  }

  private _readAllByFile(filePath: string): InboundEntry[] {
    if (!existsSync(filePath)) return [];
    try {
      return readFileSync(filePath, "utf-8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l) as InboundEntry);
    } catch { return []; }
  }

  private _clearFile(channelId: string, scope = "main"): void {
    try {
      writeFileSync(this._filePath(channelId, scope), "", "utf-8");
    } catch { /* 靜默 */ }
  }

  private async _compressBucketB(
    entries: InboundEntry[],
    cfg: InboundHistoryCfg,
    ceProvider: LLMProvider,
  ): Promise<string> {
    const raw = entries.map(e =>
      `[${new Date(e.ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}] ${e.authorName}: ${e.content}`
    ).join("\n");

    try {
      const result = await ceProvider.stream(
        [{ role: "user", content: `請用繁體中文摘要以下 Discord 頻道訊息（保留關鍵主題、人名、事件）：\n\n${raw}` }],
        { systemPrompt: "你是摘要助手，只輸出摘要，不加說明。" },
      );

      let summaryText = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) summaryText += evt.text;
      }

      // Decay II：摘要仍超上限 → 純程式截斷
      if (estimateTokens(summaryText) > cfg.bucketBTokenCap) {
        summaryText = summaryText.slice(0, cfg.decayIITokenCap * 4);
        log.debug(`[inbound-history] Decay II 觸發，截斷至 ${cfg.decayIITokenCap} tokens`);
      }

      return summaryText.trim();
    } catch (err) {
      log.warn(`[inbound-history] Bucket B LLM 壓縮失敗：${err instanceof Error ? err.message : String(err)}`);
      // fallback：純截斷
      return raw.slice(0, cfg.bucketBTokenCap * 4);
    }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _inboundHistoryStore: InboundHistoryStore | null = null;

export function initInboundHistoryStore(dataDir: string): InboundHistoryStore {
  _inboundHistoryStore = new InboundHistoryStore(dataDir);
  return _inboundHistoryStore;
}

export function getInboundHistoryStore(): InboundHistoryStore | null {
  return _inboundHistoryStore;
}
