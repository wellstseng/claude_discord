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

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

  append(channelId: string, entry: InboundEntry): void {
    try {
      const filePath = this._filePath(channelId);
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log.warn(`[inbound-history] append 失敗：${err instanceof Error ? err.message : String(err)}`);
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
  ): Promise<string | null> {
    if (!cfg.inject.enabled) return null;

    const entries = this._readAll(channelId);
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
    this._clearFile(channelId);

    // 組裝 context string
    const parts: string[] = [];
    if (bucketBText) parts.push(`[較早訊息摘要]\n${bucketBText}`);
    if (bucketAText) parts.push(`[最近 ${cfg.fullWindowHours}h 訊息]\n${bucketAText}`);

    if (parts.length === 0) return null;

    const result = `=== 頻道脈絡（未被處理的訊息） ===\n${parts.join("\n\n")}`;
    log.debug(`[inbound-history] inject channel=${channelId} bucketA=${bucketA.length} bucketB=${bucketB.length}`);
    return result;
  }

  // ── 私有輔助 ──────────────────────────────────────────────────────────────

  private _filePath(channelId: string): string {
    const safe = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.storeDir, `discord_${safe}.jsonl`);
  }

  private _readAll(channelId: string): InboundEntry[] {
    const filePath = this._filePath(channelId);
    if (!existsSync(filePath)) return [];
    try {
      return readFileSync(filePath, "utf-8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l) as InboundEntry);
    } catch { return []; }
  }

  private _clearFile(channelId: string): void {
    try {
      writeFileSync(this._filePath(channelId), "", "utf-8");
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
