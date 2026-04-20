/**
 * @file core/context-engine.ts
 * @description Context Engineering — Strategy Pattern 架構
 *
 * 設計：
 * - ContextEngine 持有 Strategy Map，build() 依序套用啟用的 strategies
 * - 各 strategy 可獨立開關（A/B 比較），不動核心
 * - CompactionStrategy：turn 數超閾值時用 LLM 摘要壓縮舊訊息
 * - OverflowHardStopStrategy：context 超硬上限時緊急截斷
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import type { Message, ContentBlock } from "../providers/base.js";
import type { LLMProvider } from "../providers/base.js";
import type { DecayStrategyConfig, DecayLevel, ExternalizeConfig } from "./config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface LevelChange {
  messageIndex: number;
  fromLevel: number;
  toLevel: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface StrategyDetail {
  name: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved?: number;
  messagesDecayed?: number;
  levelChanges?: LevelChange[];
}

export interface OriginalMessageDigest {
  index: number;
  role: string;
  turnIndex: number;
  originalTokens: number;
  currentTokens: number;
  compressionLevel: number;
  toolName?: string;
}

export interface ContextBreakdown {
  totalMessages: number;
  estimatedTokens: number;
  strategiesApplied: string[];
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  /** 三段 failover 的第三段觸發：截斷後仍超硬上限，需要停止執行 */
  overflowSignaled?: boolean;
  strategyDetails?: StrategyDetail[];
  originalMessageDigest?: OriginalMessageDigest[];
}

export interface ContextBuildContext {
  messages: Message[];
  sessionKey: string;
  turnIndex: number;
  estimatedTokens: number;
}

export interface ContextStrategy {
  name: string;
  enabled: boolean;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext>;
}

export interface BuildOpts {
  sessionKey: string;
  turnIndex: number;
  ceProvider?: LLMProvider;  // CE 用 LLM（壓縮/摘要）
  agentId?: string;
  accountId?: string;
}

// ── Tool Pairing Repair ───────────────────────────────────────────────────────

/**
 * 修補截斷後的 tool_use / tool_result 孤立問題
 * - 移除沒有對應 tool_use 的 tool_result block
 * - 移除沒有對應 tool_result 的 tool_use block
 * - 移除因此變空的 user/assistant messages
 */
export function repairToolPairing(messages: Message[]): Message[] {
  // 1. 收集所有 tool_use id
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id);
      }
    }
  }

  // 2. 收集有 tool_result 的 tool_use_id
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // 3. 移除孤立 blocks，過濾空 messages
  return messages
    .map(m => {
      if (typeof m.content === "string") return m;
      const cleaned = m.content.filter(b => {
        if (b.type === "tool_use") return toolResultIds.has(b.id);    // 有對應 result 才保留
        if (b.type === "tool_result") return toolUseIds.has(b.tool_use_id);  // 有對應 use 才保留
        return true;
      });
      if (cleaned.length === 0) return null;
      return { ...m, content: cleaned };
    })
    .filter((m): m is Message => m !== null);
}

// ── Token 估算（~4 chars/token 粗估） ────────────────────────────────────────

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    // 優先使用 per-message 精確 token 數
    if (m.tokens != null) {
      total += m.tokens;
      continue;
    }
    let chars = 0;
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += typeof b.content === "string" ? b.content.length : JSON.stringify(b.content).length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      }
    }
    total += Math.ceil(chars / 4);
  }
  return total;
}

// ── DecayStrategy（漸進式衰減）─────────────────────────────────────────────────

const DEFAULT_DECAY_LEVELS: DecayLevel[] = [
  { minAge: 1,  maxTokens: 2000 },  // L1: 精簡
  { minAge: 3,  maxTokens: 500 },   // L2: 核心
  { minAge: 6,  maxTokens: 80 },    // L3: stub
  { minAge: 10, action: "remove" },  // L4: 移除
];

const RETAIN_RATIO_THRESHOLDS: [number, number][] = [
  [0.80, 0],  // > 80% → L0 (原始)
  [0.40, 1],  // > 40% → L1
  [0.10, 2],  // > 10% → L2
  [0.05, 3],  // > 5%  → L3
];

function discreteLevel(age: number, levels: DecayLevel[]): number {
  let level = 0;
  for (let i = 0; i < levels.length; i++) {
    if (age >= levels[i].minAge) level = i + 1;
  }
  return level;
}

function continuousLevel(age: number, baseDecay: number, tempoMultiplier: number): number {
  const retainRatio = Math.exp(-baseDecay * tempoMultiplier * age);
  for (const [threshold, level] of RETAIN_RATIO_THRESHOLDS) {
    if (retainRatio > threshold) return level;
  }
  return 4; // remove
}

function truncateContent(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  const origLen = content.length;
  return content.slice(0, maxChars) + `\n…[⚠️ CE 已截斷：原文 ${origLen} chars，僅保留前 ${maxChars} chars。後續內容已丟失，勿假設完整性]`;
}

function truncateBlocks(blocks: ContentBlock[], maxTokens: number): ContentBlock[] {
  const maxChars = maxTokens * 4;
  let totalChars = 0;
  const result: ContentBlock[] = [];

  for (const b of blocks) {
    if (b.type === "tool_result") {
      // rich content（圖片等）不截斷，直接保留
      if (typeof b.content !== "string") {
        result.push(b);
        totalChars += JSON.stringify(b.content).length;
      } else {
        const remaining = Math.max(0, maxChars - totalChars);
        if (remaining <= 0) {
          result.push({ ...b, content: `[⚠️ CE 已截斷：此 tool_result 原文 ${b.content.length} chars，已全部丟失，勿假設完整性]` });
        } else if (b.content.length > remaining) {
          const origLen = b.content.length;
          result.push({ ...b, content: b.content.slice(0, remaining) + `\n…[⚠️ CE 已截斷：原文 ${origLen} chars，僅保留前 ${remaining} chars。後續內容已丟失，勿假設完整性]` });
          totalChars += remaining;
        } else {
          result.push(b);
          totalChars += b.content.length;
        }
      }
    } else if (b.type === "tool_use") {
      const input = JSON.stringify(b.input);
      totalChars += input.length;
      result.push(b);
    } else if (b.type === "text") {
      const remaining = Math.max(0, maxChars - totalChars);
      if (b.text.length > remaining) {
        const origLen = b.text.length;
        result.push({ ...b, text: b.text.slice(0, remaining) + `\n…[⚠️ CE 已截斷：原文 ${origLen} chars，僅保留前 ${remaining} chars。後續內容已丟失，勿假設完整性]` });
        totalChars += remaining;
      } else {
        result.push(b);
        totalChars += b.text.length;
      }
    } else {
      result.push(b);
    }
  }
  return result;
}

/** 從 message 提取主題摘要（前 80 chars，零 LLM 成本） */
function extractTopicHint(m: Message): string {
  const raw = typeof m.content === "string" ? m.content : getMessageText(m);
  // 跳過已是標記的內容
  if (raw.startsWith("[")) return "";
  const clean = raw.replace(/\n+/g, " ").trim();
  if (clean.length <= 80) return clean;
  return clean.slice(0, 80) + "...";
}

function stubMessage(m: Message): Message {
  const role = m.role;
  const turnLabel = m.turnIndex != null ? ` turn ${m.turnIndex}` : "";
  const topic = extractTopicHint(m);
  const topicPart = topic ? `｜主題：${topic}` : "";
  if (typeof m.content === "string") {
    return { ...m, content: `[已壓縮 ${role}${turnLabel}${topicPart}｜內容不可恢復，勿引用]`, compressionLevel: 3, originalTokens: m.originalTokens ?? m.tokens };
  }
  const stubText = `[已壓縮 ${role}${turnLabel}${topicPart}｜內容不可恢復，勿引用]`;
  const stubBlocks: ContentBlock[] = m.content.map(b => {
    if (b.type === "tool_use") return { ...b, input: {} };
    if (b.type === "tool_result") return { ...b, content: "[stub]" };
    if (b.type === "text") return { ...b, text: stubText };
    return b;
  });
  return { ...m, content: stubBlocks, compressionLevel: 3, originalTokens: m.originalTokens ?? m.tokens };
}

// ── Externalization helpers ──────────────────────────────────────────────────

export function getMessageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map(b => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_result") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      if (b.type === "tool_use") return `[tool:${b.name}]`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 存原文到外部檔案，回傳相對路徑 */
function externalizeMessage(
  m: Message,
  sessionKey: string,
  msgIndex: number,
  dataDir: string,
): string {
  const sk = safeKey(sessionKey);
  const dir = join(dataDir, "externalized", sk);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileName = `msg_t${m.turnIndex ?? 0}_i${msgIndex}.json`;
  const filePath = join(dir, fileName);

  const record = {
    sessionKey,
    turnIndex: m.turnIndex ?? 0,
    messageIndex: msgIndex,
    role: m.role,
    originalTokens: m.originalTokens ?? m.tokens ?? estimateTokens([m]),
    externalizedAt: new Date().toISOString(),
    content: typeof m.content === "string" ? m.content : m.content,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
  return filePath;
}

/** 建立外部化摘要指標訊息（不含原文截斷，只標記外部化路徑） */
function createExternalizedStub(m: Message, relativePath: string, targetLevel: number): Message {
  const origTokens = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
  const topic = extractTopicHint(m);
  const topicLine = topic ? `\n主題：${topic}` : "";
  const stub = `[📄 外部化] ${m.role} turn ${m.turnIndex ?? "?"}（原始 ${origTokens} tokens 已存至檔案）${topicLine}\n→ ${relativePath}\n⚠️ 如需原文請用 read_file 讀取上方絕對路徑。若無法讀取則告知使用者，勿腦補。`;
  return {
    ...m,
    content: stub,
    compressionLevel: targetLevel,
    compressedBy: "externalize",
    originalTokens: origTokens,
  };
}

/** 清理過期外部化檔案 */
export function cleanupExternalized(dataDir: string, ttlDays: number): number {
  const dir = join(dataDir, "externalized");
  if (!existsSync(dir)) return 0;

  const cutoff = Date.now() - ttlDays * 86_400_000;
  let removed = 0;

  for (const sessionDir of readdirSync(dir)) {
    const sessionPath = join(dir, sessionDir);
    try {
      const stat = statSync(sessionPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    for (const file of readdirSync(sessionPath)) {
      const filePath = join(sessionPath, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }

    // 空目錄清除
    try {
      const remaining = readdirSync(sessionPath);
      if (remaining.length === 0) {
        rmdirSync(sessionPath);
      }
    } catch { /* skip */ }
  }

  if (removed > 0) log.info(`[context-engine:externalize] cleaned ${removed} expired files (ttl=${ttlDays}d)`);
  return removed;
}

export class DecayStrategy implements ContextStrategy {
  name = "decay";
  enabled: boolean;
  lastLevelChanges: LevelChange[] = [];
  private cfg: Required<Pick<DecayStrategyConfig, "mode" | "baseDecay" | "minRetainRatio" | "referenceIntervalSec">> & { levels: DecayLevel[]; tempoRange: [number, number] };
  private extCfg: Required<ExternalizeConfig>;
  private _dataDir: string | null = null;

  constructor(cfg: Partial<DecayStrategyConfig> = {}) {
    this.enabled = cfg.enabled ?? true;
    this.cfg = {
      mode: cfg.mode ?? "auto",
      levels: cfg.levels ?? DEFAULT_DECAY_LEVELS,
      baseDecay: cfg.baseDecay ?? 0.3,
      minRetainRatio: cfg.minRetainRatio ?? 0.05,
      referenceIntervalSec: cfg.referenceIntervalSec ?? 60,
      tempoRange: cfg.tempoRange ?? [0.5, 2.0],
    };
    const ext = cfg.externalize ?? {};
    this.extCfg = {
      enabled: ext.enabled ?? true,
      triggerLevel: ext.triggerLevel ?? 2,
      minTokens: ext.minTokens ?? 300,
      ttlDays: ext.ttlDays ?? 14,
      storePath: ext.storePath ?? "data/externalized",
    };
  }

  /** 設定 data 目錄（由 initContextEngine 注入） */
  setDataDir(dir: string): void { this._dataDir = dir; }

  shouldApply(_ctx: ContextBuildContext): boolean {
    return this.enabled;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    const { messages, turnIndex } = ctx;
    const tempoMultiplier = this._calcTempoMultiplier(messages);

    const result: Message[] = [];
    const changes: LevelChange[] = [];
    let removed = 0;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const age = (m.turnIndex != null) ? turnIndex - m.turnIndex : 0;
      if (age <= 0) { result.push(m); continue; }

      const currentLevel = m.compressionLevel ?? 0;
      const targetLevel = this._calcTargetLevel(age, tempoMultiplier);

      if (targetLevel >= 4) {
        const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: 4, tokensBefore: tokBefore, tokensAfter: 0 });
        removed++;
        continue;
      }

      if (targetLevel <= currentLevel) { result.push(m); continue; }

      const levelCfg = this.cfg.levels[targetLevel - 1];
      if (!levelCfg) { result.push(m); continue; }

      if (levelCfg.action === "remove") {
        const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: 4, tokensBefore: tokBefore, tokensAfter: 0 });
        removed++;
        continue;
      }

      const maxTokens = levelCfg.maxTokens ?? Infinity;
      const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);

      // 外部化：在 truncate 之前攔截，趁原文還在時存檔
      if (this.extCfg.enabled
        && this._dataDir
        && targetLevel >= this.extCfg.triggerLevel
        && tokBefore >= this.extCfg.minTokens
        && m.compressedBy !== "externalize") {
        try {
          const relPath = externalizeMessage(m, ctx.sessionKey, i, this._dataDir);
          const stub = createExternalizedStub(m, relPath, targetLevel);
          const tokAfter = estimateTokens([stub]);
          changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: targetLevel, tokensBefore: tokBefore, tokensAfter: tokAfter });
          result.push(stub);
          continue;
        } catch (err) {
          log.warn(`[context-engine:externalize] 存檔失敗，fallback truncate: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 截斷前靜默存檔：讓 AI 需要時能 read_file 取回完整原文
      let extPath: string | undefined;
      if (this.extCfg.enabled
        && this._dataDir
        && tokBefore >= this.extCfg.minTokens
        && m.compressedBy !== "externalize"
        && targetLevel < 3) {  // L3 stub 走上面的外部化路徑
        try {
          extPath = externalizeMessage(m, ctx.sessionKey, i, this._dataDir);
        } catch { /* 存檔失敗不阻塞截斷 */ }
      }

      const decayed = this._compressMessage(m, maxTokens, targetLevel, extPath);
      const tokAfter = estimateTokens([decayed]);
      if (targetLevel !== currentLevel) {
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: targetLevel, tokensBefore: tokBefore, tokensAfter: tokAfter });
      }
      result.push(decayed);
    }

    this.lastLevelChanges = changes;

    if (removed > 0) {
      log.info(`[context-engine:decay] removed ${removed} messages, ${messages.length} → ${result.length}`);
    }

    const repaired = repairToolPairing(result);
    return { ...ctx, messages: repaired, estimatedTokens: estimateTokens(repaired) };
  }

  private _calcTargetLevel(age: number, tempoMultiplier: number): number {
    const mode = this.cfg.mode;

    if (mode === "discrete") {
      return discreteLevel(age, this.cfg.levels);
    }
    if (mode === "continuous") {
      return continuousLevel(age, this.cfg.baseDecay, 1.0);
    }
    if (mode === "time-aware") {
      return continuousLevel(age, this.cfg.baseDecay, tempoMultiplier);
    }
    // auto: max(discrete, continuous with tempo)
    const d = discreteLevel(age, this.cfg.levels);
    const c = continuousLevel(age, this.cfg.baseDecay, tempoMultiplier);
    return Math.max(d, c);
  }

  private _calcTempoMultiplier(messages: Message[]): number {
    const timestamps = messages.filter(m => m.timestamp != null).map(m => m.timestamp!);
    if (timestamps.length < 2) return 1.0;

    const sorted = [...timestamps].sort((a, b) => a - b);
    let totalInterval = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalInterval += sorted[i] - sorted[i - 1];
    }
    const avgIntervalMs = totalInterval / (sorted.length - 1);
    const avgIntervalSec = avgIntervalMs / 1000;

    const raw = avgIntervalSec / this.cfg.referenceIntervalSec;
    const [min, max] = this.cfg.tempoRange;
    return Math.max(min, Math.min(max, raw));
  }

  private _compressMessage(m: Message, maxTokens: number, targetLevel: number, extPath?: string): Message {
    if (targetLevel === 3) return stubMessage(m);

    const originalTokens = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
    const pathHint = extPath ? `\n→ 完整原文：${extPath}（可用 read_file 讀取）` : "";

    if (typeof m.content === "string") {
      return {
        ...m,
        content: truncateContent(m.content, maxTokens) + pathHint,
        compressionLevel: targetLevel,
        compressedBy: extPath ? "externalize" : "decay",
        originalTokens,
      };
    }

    const compressed = truncateBlocks(m.content, maxTokens);
    // 把路徑提示附加到最後一個 text block
    if (pathHint && compressed.length > 0) {
      const last = compressed[compressed.length - 1];
      if (last.type === "text") {
        compressed[compressed.length - 1] = { ...last, text: last.text + pathHint };
      } else if (last.type === "tool_result") {
        compressed[compressed.length - 1] = { ...last, content: last.content + pathHint };
      }
    }

    return {
      ...m,
      content: compressed,
      compressionLevel: targetLevel,
      compressedBy: extPath ? "externalize" : "decay",
      originalTokens,
    };
  }
}

// ── CompactionStrategy ────────────────────────────────────────────────────────

export interface CompactionConfig {
  enabled: boolean;
  model?: string;              // CE 壓縮用 LLM model（不填則用 platform 傳入的 ceProvider）
  /** 超過此 token 數才觸發（預設 4000）。取代舊的 triggerTurns。 */
  triggerTokens: number;
  preserveRecentTurns: number; // 保留最近 N 輪不壓縮（預設 5）
}

export class CompactionStrategy implements ContextStrategy {
  name = "compaction";
  enabled: boolean;
  private cfg: CompactionConfig;

  constructor(cfg: Partial<CompactionConfig> & { triggerTurns?: number } = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      triggerTokens: cfg.triggerTokens ?? 20_000,
      preserveRecentTurns: cfg.preserveRecentTurns ?? 8,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    return this.enabled && ctx.estimatedTokens > this.cfg.triggerTokens;
  }

  async apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext> {
    if (!ceProvider) {
      log.debug("[context-engine:compaction] 無 ceProvider，改用 sliding-window 回退");
      return this._fallbackSlide(ctx);
    }

    const { messages } = ctx;
    const preserveCount = this.cfg.preserveRecentTurns * 2;  // 每 turn ≈ 2 messages
    if (messages.length <= preserveCount) return ctx;

    const toCompress = messages.slice(0, messages.length - preserveCount);
    const toKeep = messages.slice(messages.length - preserveCount);

    // system messages 不壓縮
    const sysMessages = toCompress.filter(m => (m as unknown as { role: string }).role === "system");
    const convMessages = toCompress.filter(m => (m as unknown as { role: string }).role !== "system");

    if (convMessages.length === 0) return ctx;

    // 過濾標記類訊息（stub/索引/外部化），不進摘要輸入，避免雙重失真
    const semanticMessages = convMessages.filter(m => {
      const text = typeof m.content === "string" ? m.content : getMessageText(m);
      return !text.startsWith("[工具索引")
          && !text.startsWith("[工具記錄]")  // 兼容舊格式
          && !text.startsWith("[已壓縮")
          && !text.startsWith("[📄 外部化]")
          && !text.startsWith("[user stub]")
          && !text.startsWith("[assistant stub]");
    });

    if (semanticMessages.length === 0) {
      log.debug("[context-engine:compaction] 過濾後無語意內容可摘要，跳過");
      return ctx;
    }

    try {
      // 切割上限提高：避免使用者長指令 / tool 內容被截斷導致摘要失真
      const SLICE_USER = 2000;
      const SLICE_ASSISTANT = 1500;
      const SLICE_TOOL_USE = 500;
      const SLICE_TOOL_RESULT = 800;

      const formatMsg = (m: Message): string => {
        const role = (m as unknown as { role: string }).role;
        let content: string;
        if (typeof m.content === "string") {
          content = m.content;
        } else {
          // 從 tool blocks 提取有意義的摘要文字（而非棄用 "[tool interaction]"）
          content = (m.content as Array<{ type: string; name?: string; input?: unknown; tool_use_id?: string; content?: string }>)
            .map(b => {
              if (b.type === "tool_use") {
                const params = b.input ? JSON.stringify(b.input).slice(0, SLICE_TOOL_USE) : "";
                return `[工具:${b.name}] ${params}`;
              }
              if (b.type === "tool_result") {
                const result = typeof b.content === "string" ? b.content.slice(0, SLICE_TOOL_RESULT) : "";
                return `[結果] ${result}`;
              }
              if (b.type === "text") return (b as unknown as { text: string }).text;
              return "";
            })
            .filter(Boolean)
            .join(" ");
        }
        const limit = role === "user" ? SLICE_USER : SLICE_ASSISTANT;
        return `[${role}]: ${content.slice(0, limit)}`;
      };

      const summaryPrompt = `以下是我（agent）與使用者過去的對話歷史。請用繁體中文以「我（接續工作的 agent）的視角」寫一份結構化筆記，幫助我接回後續對話時不偏離使用者意圖。

# 必填章節（缺項以「無」表示，不要省略章節）

## 使用者意圖
使用者真正想完成的事是什麼？（用使用者的話描述目標，而非我做了什麼）

## 已決策事項
雙方明確同意要採用的方案 / 拒絕的方案 / 使用者明確的偏好

## 待辦／進行中
我答應要做但還沒完成的事；目前正在進行的步驟

## 未解決問題
使用者問了但還沒得到滿意答案的事；卡住的點；待釐清的歧義

## 工具產出重點
工具呼叫的「結論」（不要列工具名稱清單；要寫從工具拿到了什麼有用資訊）

## 重要事實 / 限制
不寫下會讓我接續對話時搞錯的關鍵事實（檔案路徑、決策原因、規格限制等）

# 對話內容
${semanticMessages.map(formatMsg).join("\n")}`;

      const result = await ceProvider.stream(
        [{ role: "user", content: summaryPrompt }],
        {
          systemPrompt: "你是負責濃縮對話、讓同一個 agent 能無縫接續工作的紀錄員。寫摘要時用第一人稱（我），優先保留「使用者意圖」與「未解決問題」。不要寫成第三人稱旁觀報告，不要列工具流水帳，不要加開場白或結語。",
        },
      );

      let summaryText = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) summaryText += evt.text;
      }

      // C′ 輕量版：把使用者最近一則完整指令的原文當「意圖錨點」附在摘要後
      // 即便摘要漏了什麼，agent 仍能讀到使用者最近一次親口說的話
      const lastIntentAnchor = (() => {
        for (let i = semanticMessages.length - 1; i >= 0; i--) {
          const m = semanticMessages[i]!;
          if ((m as unknown as { role: string }).role !== "user") continue;
          const text = typeof m.content === "string" ? m.content : getMessageText(m);
          if (text.length < 50) continue;
          return text.slice(0, 800);
        }
        return null;
      })();

      const anchorBlock = lastIntentAnchor
        ? `\n\n📌 使用者最近一則完整指令（原文，未壓縮）：\n${lastIntentAnchor}`
        : "";

      const summaryMessage: Message = {
        role: "user",
        content: `[對話摘要｜多輪壓縮，非原文，可能遺漏細節]\n${summaryText.trim()}${anchorBlock}\n⚠️ 若使用者要求引用本範圍的細節，承認這是壓縮摘要、請使用者提供正確版本，不得直接引用本段文字作答。`,
      };

      const compressed = [...sysMessages, summaryMessage, ...toKeep];
      log.info(`[context-engine:compaction] 壓縮 ${messages.length} → ${compressed.length} messages`);

      return {
        ...ctx,
        messages: compressed,
        estimatedTokens: estimateTokens(compressed),
      };
    } catch (err) {
      log.warn(`[context-engine:compaction] LLM 壓縮失敗，回退：${err instanceof Error ? err.message : String(err)}`);
      return this._fallbackSlide(ctx);
    }
  }

  private _fallbackSlide(ctx: ContextBuildContext): ContextBuildContext {
    const preserve = this.cfg.preserveRecentTurns * 2;
    const sliced = repairToolPairing(ctx.messages.slice(-preserve));
    return { ...ctx, messages: sliced, estimatedTokens: estimateTokens(sliced) };
  }
}

// ── OverflowHardStopStrategy（第三段 failover）────────────────────────────────

export interface OverflowHardStopConfig {
  enabled: boolean;
  /** 超過此比例 context window → 觸發（預設 0.95） */
  hardLimitUtilization: number;
  contextWindowTokens: number;
}

export class OverflowHardStopStrategy implements ContextStrategy {
  name = "overflow-hard-stop";
  enabled: boolean;
  private cfg: OverflowHardStopConfig;
  /** 最後一次 apply 是否觸發了 hard stop */
  lastOverflowSignaled = false;

  constructor(cfg: Partial<OverflowHardStopConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      hardLimitUtilization: cfg.hardLimitUtilization ?? 0.95,
      contextWindowTokens: cfg.contextWindowTokens ?? 100_000,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    if (!this.enabled) return false;
    const hard = this.cfg.contextWindowTokens * this.cfg.hardLimitUtilization;
    return ctx.estimatedTokens > hard;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    // 緊急截斷：只保留最後 4 條 messages（system + 最近 2 輪）
    const minMessages = ctx.messages.slice(-4);
    this.lastOverflowSignaled = true;
    log.warn(`[context-engine:overflow-hard-stop] context 超硬上限 ${ctx.estimatedTokens} tokens，截斷至 ${minMessages.length} messages`);
    return { ...ctx, messages: minMessages, estimatedTokens: estimateTokens(minMessages) };
  }
}

// ── ContextEngine ─────────────────────────────────────────────────────────────

export class ContextEngine {
  private strategies = new Map<string, ContextStrategy>();
  private _ceProvider?: LLMProvider;

  setCeProvider(p: LLMProvider): void { this._ceProvider = p; }

  /** 最後一次 build 的 breakdown */
  lastBuildBreakdown: ContextBreakdown = {
    totalMessages: 0,
    estimatedTokens: 0,
    strategiesApplied: [],
  };
  lastAppliedStrategy: string | undefined;

  constructor() {
    this.register(new DecayStrategy());
    this.register(new CompactionStrategy());
    this.register(new OverflowHardStopStrategy());
  }

  register(strategy: ContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  getStrategy(name: string): ContextStrategy | undefined {
    return this.strategies.get(name);
  }

  /** 取得 context window 大小（供 nudge 計算用） */
  getContextWindowTokens(): number {
    const oh = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    return oh?.["cfg"]?.contextWindowTokens ?? 100_000;
  }

  async build(messages: Message[], opts: BuildOpts): Promise<Message[]> {
    const tokensBeforeCE = estimateTokens(messages);

    // originalMessageDigest: 壓縮前的 message 摘要
    const originalMessageDigest = messages.map((m, i) => {
      const tokens = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
      let toolName: string | undefined;
      if (typeof m.content !== "string") {
        for (const b of m.content) {
          if (b.type === "tool_use") { toolName = b.name; break; }
          if (b.type === "tool_result") { toolName = `result:${b.tool_use_id?.slice(-6) ?? "?"}`; break; }
        }
      }
      return {
        index: i,
        role: m.role,
        turnIndex: m.turnIndex ?? 0,
        originalTokens: tokens,
        currentTokens: tokens,
        compressionLevel: m.compressionLevel ?? 0,
        toolName,
      };
    });

    let ctx: ContextBuildContext = {
      messages,
      sessionKey: opts.sessionKey,
      turnIndex: opts.turnIndex,
      estimatedTokens: tokensBeforeCE,
    };

    const applied: string[] = [];
    const details: StrategyDetail[] = [];

    const order = ["decay", "compaction", "overflow-hard-stop"];
    const effectiveCeProvider = opts.ceProvider ?? this._ceProvider;

    const hookReg = await (async () => {
      try {
        const { getHookRegistry } = await import("../hooks/hook-registry.js");
        return getHookRegistry();
      } catch { return null; }
    })();

    for (const name of order) {
      const strategy = this.strategies.get(name);
      if (!strategy?.enabled) continue;
      if (strategy.shouldApply(ctx)) {
        const tokensBefore = ctx.estimatedTokens;
        const msgsBefore = ctx.messages.length;

        // PreCompaction hook (for compaction/decay)
        const compactionStart = Date.now();
        if (hookReg && (name === "compaction" || name === "decay")) {
          try {
            if (hookReg.count("PreCompaction", opts.agentId) > 0) {
              await hookReg.runPreCompaction({
                event: "PreCompaction",
                reason: name === "decay" ? "ce-decay" : "manual",
                currentTokens: tokensBefore,
                agentId: opts.agentId,
                accountId: opts.accountId,
              });
            }
          } catch { /* ignore */ }
        }

        ctx = await strategy.apply(ctx, effectiveCeProvider);
        applied.push(name);

        if (hookReg && (name === "compaction" || name === "decay")) {
          try {
            if (hookReg.count("PostCompaction", opts.agentId) > 0) {
              await hookReg.runPostCompaction({
                event: "PostCompaction",
                beforeTokens: tokensBefore,
                afterTokens: ctx.estimatedTokens,
                durationMs: Date.now() - compactionStart,
                agentId: opts.agentId,
                accountId: opts.accountId,
              });
            }
          } catch { /* ignore */ }
        }
        const detail: StrategyDetail = {
          name,
          tokensBefore,
          tokensAfter: ctx.estimatedTokens,
        };
        if (ctx.messages.length < msgsBefore) {
          detail.messagesRemoved = msgsBefore - ctx.messages.length;
        }
        // decay 專屬：附加 levelChanges
        if (name === "decay") {
          const decayStrategy = strategy as DecayStrategy;
          if (decayStrategy.lastLevelChanges.length > 0) {
            detail.levelChanges = decayStrategy.lastLevelChanges;
            detail.messagesDecayed = decayStrategy.lastLevelChanges.filter(c => c.toLevel < 4).length;
          }
        }
        details.push(detail);
        log.debug(`[context-engine] strategy=${name} applied, tokens ${tokensBefore}→${ctx.estimatedTokens}`);
      }
    }

    const overflowStrategy = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    this.lastBuildBreakdown = {
      totalMessages: ctx.messages.length,
      estimatedTokens: ctx.estimatedTokens,
      strategiesApplied: applied,
      tokensBeforeCE,
      tokensAfterCE: applied.length > 0 ? ctx.estimatedTokens : undefined,
      overflowSignaled: overflowStrategy?.lastOverflowSignaled ?? false,
      strategyDetails: details.length > 0 ? details : undefined,
      originalMessageDigest: applied.length > 0 ? originalMessageDigest : undefined,
    };
    const overflowSignaled = overflowStrategy?.lastOverflowSignaled ?? false;
    if (overflowSignaled && hookReg) {
      try {
        if (hookReg.count("ContextOverflow", opts.agentId) > 0) {
          await hookReg.runContextOverflow({
            event: "ContextOverflow",
            currentTokens: ctx.estimatedTokens,
            budgetTokens: this.getContextWindowTokens(),
            agentId: opts.agentId,
            accountId: opts.accountId,
          });
        }
      } catch { /* ignore */ }
    }
    if (overflowStrategy) overflowStrategy.lastOverflowSignaled = false;
    this.lastAppliedStrategy = applied.at(-1);

    return ctx.messages;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }
}

// ── 外部化索引（供 agent-loop turn 開始前注入）─────────────────────────────────

/**
 * 掃描 messages 中的外部化/截斷標記，產生簡潔索引字串。
 * 回傳空字串表示無外部化訊息。
 */
export function buildExternalizedIndex(messages: Message[]): string {
  const entries: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : getMessageText(m);
    // 匹配外部化 stub
    if (text.includes("[📄 外部化]")) {
      const pathMatch = text.match(/→\s*(\S*externalized\/\S+)/);
      const topicMatch = text.match(/主題：(.+?)(?:\n|$)/);
      const turnMatch = text.match(/turn\s+(\d+)/);
      if (pathMatch) {
        const turn = turnMatch ? `turn ${turnMatch[1]}` : "?";
        const topic = topicMatch ? topicMatch[1].trim() : "";
        const role = m.role;
        entries.push(`- ${turn} ${role}${topic ? `：${topic}` : ""} → ${pathMatch[1]}`);
      }
    }
    // 匹配截斷 + 路徑
    else if (text.includes("→ 完整原文：") && text.includes("externalized/")) {
      const pathMatch = text.match(/→ 完整原文：(\S*externalized\/\S+)/);
      const turnLabel = m.turnIndex != null ? `turn ${m.turnIndex}` : "?";
      if (pathMatch) {
        const preview = text.replace(/\n.*/s, "").slice(0, 60).trim();
        entries.push(`- ${turnLabel} ${m.role}：${preview} → ${pathMatch[1]}`);
      }
    }
  }
  if (entries.length === 0) return "";
  return [
    "[外部化索引] 以下訊息原文已存檔，與問題相關時用 read_file 讀取（絕對路徑）：",
    ...entries,
  ].join("\n");
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _contextEngine: ContextEngine | null = null;

export function initContextEngine(cfg?: {
  compaction?: Partial<CompactionConfig> & { model?: string };
  decay?: Partial<DecayStrategyConfig>;
  overflowHardStop?: Partial<OverflowHardStopConfig>;
  dataDir?: string;
}): ContextEngine {
  _contextEngine = new ContextEngine();

  if (cfg?.decay) {
    const decay = new DecayStrategy(cfg.decay);
    if (cfg.dataDir) decay.setDataDir(cfg.dataDir);
    _contextEngine.register(decay);
  }
  if (cfg?.compaction) {
    _contextEngine.register(new CompactionStrategy(cfg.compaction));
  }
  if (cfg?.overflowHardStop) {
    _contextEngine.register(new OverflowHardStopStrategy(cfg.overflowHardStop));
  }

  // 啟動時清理過期外部化檔案
  if (cfg?.dataDir && cfg.decay?.externalize?.enabled !== false) {
    const ttl = cfg.decay?.externalize?.ttlDays ?? 14;
    try { cleanupExternalized(cfg.dataDir, ttl); } catch { /* non-critical */ }
  }

  return _contextEngine;
}

export function getContextEngine(): ContextEngine | null {
  return _contextEngine;
}
