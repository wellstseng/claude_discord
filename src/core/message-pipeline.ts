/**
 * @file core/message-pipeline.ts
 * @description 統一訊息處理管線 — 所有平台（Discord / Web Chat / Cron）共用
 *
 * 管線步驟（可選模組由 PipelineInput 開關控制）：
 *   1. Trace 建立
 *   2. Memory Recall
 *   3. Mode Extras 載入
 *   4. Intent Detection + Module Filter
 *   5. System Prompt 組裝（prompt-assembler）
 *   6. Prompt Assembly Trace
 *   7. Provider Selection Trace
 *   8. Inbound History
 *   9. Session Memory opts 組裝
 *  10. Context End Trace
 *
 * 呼叫端只需提供平台專屬參數，管線自動跑完共用邏輯。
 */

import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import { MessageTrace, type TraceCategory } from "./message-trace.js";
import { assembleSystemPrompt, detectIntent, getModulesForIntent, type AssembleTraceOutput } from "./prompt-assembler.js";
import { getPlatformMemoryEngine, getPlatformMemoryRoot } from "./platform.js";
import { sanitizeMemoryText } from "../memory/context-builder.js";
import { config, type ModePreset, type BridgeConfig } from "./config.js";
import type { LLMProvider } from "../providers/base.js";
import type { MessageTrace as MessageTraceType } from "./message-trace.js";

// ── 輸入型別 ─────────────────────────────────────────────────────────────────

export interface PipelineInput {
  /** 使用者訊息 */
  prompt: string;

  /** 平台識別 */
  platform: "discord" | "api" | "cron";

  /** 頻道 ID */
  channelId: string;

  /** 帳號 ID */
  accountId: string;

  /** 已選定的 LLM Provider */
  provider: LLMProvider;

  /** 已存在的 trace（有的話直接沿用，不新建） */
  trace?: MessageTraceType;

  /** Trace 分類（僅在未傳入 trace 時使用，預設依 platform 自動對應） */
  traceCategory?: TraceCategory;

  /** 專案 ID（可選） */
  projectId?: string;

  /** 使用者角色 */
  role?: string;

  /** 是否為群組頻道 */
  isGroupChannel?: boolean;

  /** 說話者顯示名稱 */
  speakerDisplay?: string;

  /** 模式名稱 */
  modeName?: string;

  /** 模式 preset */
  modePreset?: ModePreset;

  /** 已啟用的 MCP server 名稱 */
  activeMcpServers?: string[];

  // ── 模組開關 ──────────────────────────────────────────────────────────────

  /** 記憶 Recall（預設 true） */
  memoryRecall?: boolean;

  /** Inbound History（預設 false）— 傳入 channelId 和 config 即可 */
  inboundHistory?: boolean;

  /** Session Memory（預設 true） */
  sessionMemory?: boolean;

  /** Mode Extras — 載入 workspace/prompts/*.md（預設 false） */
  modeExtras?: boolean;

  // ── 平台專屬注入 ──────────────────────────────────────────────────────────

  /** 對話場景標籤（比照 OpenClaw ConversationLabel）
   *  Discord guild: "Guild名 #頻道名 channel id:頻道ID"
   *  DM: "username user id:userId"
   *  API/dashboard: "dashboard channel id:channelId"
   */
  conversationLabel?: string;

  /** Channel system prompt override（Discord /system 指令設定） */
  channelOverride?: string;

  /** 額外的 extra blocks（呼叫端自行組裝） */
  additionalExtraBlocks?: Array<{ name: string; content: string }>;
}

// ── 輸出型別 ─────────────────────────────────────────────────────────────────

export interface PipelineResult {
  /** 組裝完成的 system prompt */
  systemPrompt: string;

  /** Message Trace 實例（傳入 agentLoop） */
  trace: MessageTraceType;

  /** 記憶注入的原始文字（用於 promptBreakdownHints） */
  memoryContext?: string;

  /** Channel override 原始文字（用於 promptBreakdownHints） */
  channelOverride?: string;

  /** Mode extras 原始文字（用於 promptBreakdownHints） */
  modeExtras?: string;

  /** Assembler 模組追蹤 */
  assemblerTrace: AssembleTraceOutput;

  /** Intent 偵測結果 */
  intent: string;

  /** Inbound History context（注入到 agentLoop messages 層） */
  inboundContext?: string;

  /** Session Memory 選項（直接展開到 agentLoopOpts） */
  sessionMemoryOpts?: {
    enabled: boolean;
    intervalTurns: number;
    maxHistoryTurns: number;
    memoryDir: string;
  };

  /** promptBreakdownHints（直接傳入 agentLoopOpts） */
  promptBreakdownHints: {
    memoryContext?: string;
    channelOverride?: string;
    modeExtras?: string;
    assemblerModules?: string[];
    assemblerSegments?: Array<{ name: string; content: string }>;
  };
}

// ── 平台 → TraceCategory 對應 ───────────────────────────────────────────────

const PLATFORM_TRACE_CATEGORY: Record<string, TraceCategory> = {
  discord: "discord",
  api: "api",
  cron: "cron",
};

// ── 管線主函式 ───────────────────────────────────────────────────────────────

export async function runMessagePipeline(input: PipelineInput): Promise<PipelineResult> {
  const {
    prompt: rawPrompt,
    platform,
    channelId,
    accountId,
    provider,
    projectId,
    role = "guest",
    isGroupChannel = false,
    speakerDisplay,
    modeName = "normal",
    modePreset = { thinking: null },
    activeMcpServers,
    memoryRecall: enableMemoryRecall = true,
    inboundHistory: enableInboundHistory = false,
    sessionMemory: enableSessionMemory = true,
    modeExtras: enableModeExtras = false,
    channelOverride,
    additionalExtraBlocks,
  } = input;

  // Memory Fence：使用者訊息進入 pipeline 時砍假冒 <memory-context> 標籤
  // 防止下游組裝後 LLM 把假 fence 內容當系統檢索結果處理
  const prompt = sanitizeMemoryText(rawPrompt);

  const traceCategory = input.traceCategory ?? PLATFORM_TRACE_CATEGORY[platform] ?? "api";
  const logPrefix = `[${platform}]`;

  // ── 1. Trace（沿用或建立） ───────────────────────────────────────────────
  const trace = input.trace ?? MessageTrace.create(randomUUID(), channelId, accountId, traceCategory);
  trace.recordContextStart();

  // ── 2. Memory Recall ───────────────────────────────────────────────────────
  // 先看 session-level frozen snapshot（preparedAt session 開場時）。命中即用，保 prompt cache。
  // session 開場第一個 turn 在 SessionStart hook 內已先建立 snapshot；後續 turn 直接讀。
  // 若 snapshot 不存在（罕見：snapshot 失敗 / 子 agent / API 直連無 session）→ fallback 跑 live recall。
  let systemPromptFromMemory = "";
  const sessionKey = `${platform}:ch:${channelId}`;
  const { getFrozenMaterials } = await import("./session-snapshot.js");
  const frozenForSession = getFrozenMaterials(sessionKey);
  if (frozenForSession?.memoryContextBlock) {
    systemPromptFromMemory = frozenForSession.memoryContextBlock;
    trace.recordMemoryRecall({
      durationMs: 0,
      fragmentCount: 0,        // snapshot 內已不分 fragment（已組為 block）
      atomNames: [],
      injectedTokens: Math.ceil(systemPromptFromMemory.length / 4),
      vectorSearch: false,
      degraded: false,
      blindSpot: false,
      hits: [],
      source: "frozen-snapshot",
    });
    log.debug(`${logPrefix} 記憶從 frozen snapshot 注入（preparedAt=${frozenForSession.preparedAt}）`);
  } else if (enableMemoryRecall) {
    const memEngine = getPlatformMemoryEngine();
    if (memEngine) {
      const recallStartMs = Date.now();
      try {
        const recallResult = await memEngine.recall(prompt, {
          accountId,
          projectId,
          channelId,
        });
        if (recallResult.fragments.length > 0) {
          const ctx = memEngine.buildContext(recallResult.fragments, prompt, recallResult.blindSpot);
          systemPromptFromMemory = ctx.text;
          log.debug(`${logPrefix} 記憶注入 ${recallResult.fragments.length} 個 atom (${ctx.tokenCount} tokens)`);
          trace.recordMemoryRecall({
            durationMs: Date.now() - recallStartMs,
            fragmentCount: recallResult.fragments.length,
            atomNames: recallResult.fragments.map(f => f.atom.name),
            injectedTokens: ctx.tokenCount,
            vectorSearch: !recallResult.degraded,
            degraded: recallResult.degraded,
            blindSpot: recallResult.blindSpot,
            hits: recallResult.fragments.map(f => ({
              name: f.atom.name,
              layer: f.layer,
              score: Math.round(f.score * 1000) / 1000,
              matchedBy: f.matchedBy,
            })),
            source: "live",
          });
        } else {
          trace.recordMemoryRecall({
            durationMs: Date.now() - recallStartMs,
            fragmentCount: 0,
            atomNames: [],
            injectedTokens: 0,
            vectorSearch: !recallResult.degraded,
            degraded: recallResult.degraded,
            blindSpot: recallResult.blindSpot,
            hits: [],
            source: "live",
          });
        }
      } catch (err) {
        log.debug(`${logPrefix} 記憶 recall 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 3. Mode Extras ─────────────────────────────────────────────────────────
  let modeExtrasBlock = "";
  if (enableModeExtras && modePreset.systemPromptExtras?.length) {
    const { resolveWorkspaceDir } = await import("./config.js");
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const promptsDir = join(resolveWorkspaceDir(), "prompts");
    const extras: string[] = [];
    for (const name of modePreset.systemPromptExtras) {
      const p = join(promptsDir, `${name}.md`);
      if (existsSync(p)) {
        try { extras.push(readFileSync(p, "utf-8")); } catch { /* skip */ }
      }
    }
    if (extras.length > 0) modeExtrasBlock = extras.join("\n\n");
  }

  // ── 4. Intent Detection + Module Filter ────────────────────────────────────
  const intent = detectIntent(prompt);
  const moduleFilter = getModulesForIntent(intent);
  log.debug(`${logPrefix} Intent: ${intent}, modules: ${moduleFilter ? moduleFilter.join(",") : "all"}`);

  // ── 5. System Prompt 組裝 ──────────────────────────────────────────────────
  const assemblerTrace: AssembleTraceOutput = { modulesActive: [], modulesSkipped: [], segments: [] };

  const _extraRaw: Array<[string, string | undefined]> = [
    ["memory-recall", systemPromptFromMemory || undefined],
    ["channel-override", channelOverride || undefined],
    ["mode-extras", modeExtrasBlock || undefined],
  ];
  if (additionalExtraBlocks) {
    for (const blk of additionalExtraBlocks) {
      _extraRaw.push([blk.name, blk.content || undefined]);
    }
  }
  const extraBlocks: string[] = [];
  const extraBlockNames: string[] = [];
  for (const [name, blk] of _extraRaw) {
    if (blk) { extraBlocks.push(blk); extraBlockNames.push(name); }
  }

  const systemPrompt = assembleSystemPrompt({
    role: role as any,
    mode: modePreset,
    modeName,
    workspaceDir: undefined,
    isGroupChannel,
    speakerDisplay,
    accountId,
    speakerRole: role,
    activeMcpServers,
    conversationLabel: input.conversationLabel,
    extraBlocks,
    extraBlockNames,
    moduleFilter,
    traceOutput: assemblerTrace,
    // Frozen Snapshot for Prompt Cache：後續 turn 各 module 短路讀凍結值，
    // 第一個 turn frozenForSession 為 null → 走原邏輯（同時當作 snapshot 種子）。
    frozenMaterials: frozenForSession ?? undefined,
  });

  // ── 6. Trace: Prompt Assembly ──────────────────────────────────────────────
  trace.recordPromptAssembly({
    intent,
    modulesActive: assemblerTrace.modulesActive,
    modulesSkipped: assemblerTrace.modulesSkipped,
    extraBlocks: extraBlocks.map(b => b.slice(0, 40)),
    agentLoopBlocks: [],
  });

  // ── 7. Trace: Provider Selection ───────────────────────────────────────────
  trace.recordProviderSelection({
    providerId: provider.id,
    providerType: provider.name,
    model: provider.modelId,
  });

  // ── 8. Inbound History ─────────────────────────────────────────────────────
  let inboundContext: string | undefined;
  if (enableInboundHistory) {
    const { getInboundHistoryStore } = await import("../discord/inbound-history.js");
    const { getBootAgentId } = await import("./agent-loader.js");
    const inboundStore = getInboundHistoryStore();
    const inboundCfg = config.inboundHistory;
    if (inboundStore && inboundCfg?.enabled !== false) {
      try {
        const agentScope = `agent:${getBootAgentId()}`;
        const ctx = await inboundStore.consumeForInjection(
          channelId,
          {
            enabled: true,
            fullWindowHours: inboundCfg?.fullWindowHours ?? 24,
            decayWindowHours: inboundCfg?.decayWindowHours ?? 168,
            bucketBTokenCap: inboundCfg?.bucketBTokenCap ?? 600,
            decayIITokenCap: inboundCfg?.decayIITokenCap ?? 300,
            inject: { enabled: inboundCfg?.inject?.enabled ?? false },
          },
          undefined,
          agentScope,
        );
        if (ctx) {
          inboundContext = ctx.text;
          trace.recordInboundHistory({
            entriesCount: ctx.entriesCount,
            bucketA: ctx.bucketA,
            bucketB: ctx.bucketB,
            tokens: Math.ceil(ctx.text.length / 4),
            decayIIApplied: false,
          });
        }
      } catch (err) {
        log.debug(`${logPrefix} inbound-history inject 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 9. Session Memory opts ─────────────────────────────────────────────────
  let sessionMemoryOpts: PipelineResult["sessionMemoryOpts"];
  if (enableSessionMemory) {
    const memoryRoot = getPlatformMemoryRoot();
    if (memoryRoot && config.memory?.sessionMemory?.enabled !== false) {
      sessionMemoryOpts = {
        enabled: true,
        intervalTurns: config.memory?.sessionMemory?.intervalTurns ?? 10,
        maxHistoryTurns: config.memory?.sessionMemory?.maxHistoryTurns ?? 15,
        memoryDir: memoryRoot,
      };
    }
  }

  // ── 10. Trace: Context End ─────────────────────────────────────────────────
  {
    const sysTokens = Math.ceil((systemPrompt?.length ?? 0) / 4);
    trace.recordContextEnd({
      systemPromptTokens: sysTokens,
      historyTokens: 0,
      historyMessageCount: 0,
      totalContextTokens: sysTokens,
    });
  }

  // ── 組裝 promptBreakdownHints ──────────────────────────────────────────────
  const promptBreakdownHints: PipelineResult["promptBreakdownHints"] = {
    memoryContext: systemPromptFromMemory || undefined,
    channelOverride: channelOverride || undefined,
    modeExtras: modeExtrasBlock || undefined,
    assemblerModules: assemblerTrace.modulesActive,
    assemblerSegments: assemblerTrace.segments,
  };

  return {
    systemPrompt,
    trace,
    memoryContext: systemPromptFromMemory || undefined,
    channelOverride: channelOverride || undefined,
    modeExtras: modeExtrasBlock || undefined,
    assemblerTrace,
    intent,
    inboundContext,
    sessionMemoryOpts,
    promptBreakdownHints,
  };
}
