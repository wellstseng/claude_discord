/**
 * @file hooks/hook-registry.ts
 * @description Hook Registry — 載入、索引、鏈式執行 32 個事件
 *
 * 兩層結構：
 * - global：所有 agent 都跑
 * - byAgent：特定 agent 才跑
 *
 * 執行語意：
 * - blocking（Pre*）：global → agent，第一個 block 中止；modify 鏈式改參數
 * - modifying（Post*）：agent → global，modify 鏈式改 result/data
 * - observer：所有 hook fire-and-await 並行，錯誤只 log
 */

import { log } from "../logger.js";
import { runHook } from "./hook-runner.js";
import type {
  HookDefinition, HookEvent, HookAction, HookInput,
  PreToolUseInput, PostToolUseInput,
  SessionStartInput, SessionEndInput,
  PreAtomWriteInput, PostAtomWriteInput, PreAtomDeleteInput, PostAtomDeleteInput,
  AtomReplaceInput, MemoryRecallInput,
  PreSubagentSpawnInput, PostSubagentCompleteInput, SubagentErrorInput,
  PreCompactionInput, PostCompactionInput, ContextOverflowInput,
  CliBridgeSpawnInput, CliBridgeSuspendInput, CliBridgeTurnInput,
  PreFileWriteInput, PreFileEditInput, PreCommandExecInput,
  FileChangedInput, FileDeletedInput,
  SafetyViolationInput, AgentErrorInput,
  ConfigReloadInput, ProviderSwitchInput,
  UserMessageReceivedInput, UserPromptSubmitInput,
  PreTurnInput, PostTurnInput, PreLlmCallInput, PostLlmCallInput,
  AgentResponseReadyInput, ToolTimeoutInput,
} from "./types.js";

interface IndexedHooks {
  global: Map<HookEvent, HookDefinition[]>;
  byAgent: Map<string, Map<HookEvent, HookDefinition[]>>;
}

export interface RegistryInit {
  global: HookDefinition[];
  byAgent?: Map<string, HookDefinition[]>;
}

export class HookRegistry {
  private hooks: IndexedHooks = { global: new Map(), byAgent: new Map() };

  constructor(init: RegistryInit) {
    this._index(init);
  }

  reload(init: RegistryInit): void {
    this._index(init);
    const total = init.global.length + Array.from(init.byAgent?.values() ?? []).reduce((s, l) => s + l.length, 0);
    log.info(`[hook-registry] 重新載入 ${total} 個 hooks（global=${init.global.length}, agents=${init.byAgent?.size ?? 0}）`);
  }

  private _index(init: RegistryInit): void {
    this.hooks.global.clear();
    this.hooks.byAgent.clear();
    for (const def of init.global) {
      if (def.enabled === false) continue;
      const list = this.hooks.global.get(def.event) ?? [];
      list.push(def);
      this.hooks.global.set(def.event, list);
    }
    for (const [agentId, defs] of init.byAgent ?? new Map()) {
      const eventMap = new Map<HookEvent, HookDefinition[]>();
      for (const def of defs) {
        if (def.enabled === false) continue;
        const list = eventMap.get(def.event) ?? [];
        list.push(def);
        eventMap.set(def.event, list);
      }
      if (eventMap.size > 0) this.hooks.byAgent.set(agentId, eventMap);
    }
  }

  /** 列出所有註冊的 hooks（供 hook_list tool 使用） */
  listAll(): { global: HookDefinition[]; byAgent: Record<string, HookDefinition[]> } {
    const globalAll: HookDefinition[] = [];
    for (const list of this.hooks.global.values()) globalAll.push(...list);
    const byAgent: Record<string, HookDefinition[]> = {};
    for (const [agentId, eventMap] of this.hooks.byAgent.entries()) {
      const list: HookDefinition[] = [];
      for (const defs of eventMap.values()) list.push(...defs);
      byAgent[agentId] = list;
    }
    return { global: globalAll, byAgent };
  }

  count(event: HookEvent, agentId?: string): number {
    const g = this.hooks.global.get(event)?.length ?? 0;
    const a = agentId ? (this.hooks.byAgent.get(agentId)?.get(event)?.length ?? 0) : 0;
    return g + a;
  }

  /** 取得某事件依執行順序（依 mode）排序的 hook 清單，且過濾 toolFilter */
  private _resolve(
    event: HookEvent,
    agentId: string | undefined,
    order: "global-first" | "agent-first",
    toolName?: string,
  ): HookDefinition[] {
    const g = this.hooks.global.get(event) ?? [];
    const a = agentId ? (this.hooks.byAgent.get(agentId)?.get(event) ?? []) : [];
    const ordered = order === "global-first" ? [...g, ...a] : [...a, ...g];
    if (!toolName) return ordered;
    return ordered.filter(h => !h.toolFilter || h.toolFilter.length === 0 || h.toolFilter.includes(toolName));
  }

  // ── 通用鏈式執行 ────────────────────────────────────────────────────────

  /** Blocking 鏈：第一個 block 即中止，modify 鏈式改參數 */
  private async _runBlocking<T extends HookInput>(
    hooks: HookDefinition[],
    input: T,
    paramsKey: keyof T,
  ): Promise<{ blocked: false; modified: T } | { blocked: true; reason: string }> {
    let current = { ...input };
    for (const hook of hooks) {
      const res = await runHook(hook, current);
      log.debug(`[hook-registry] ${input.event} "${hook.name}" → ${res.action}`);
      if (res.action === "block") {
        return { blocked: true, reason: (res as { reason: string }).reason ?? `Hook "${hook.name}" 阻擋` };
      }
      if (res.action === "modify") {
        const mod = res as { params?: Record<string, unknown>; data?: Record<string, unknown> };
        const target = current as unknown as Record<string, unknown>;
        if (mod.params && paramsKey in current) {
          target[paramsKey as string] = mod.params;
        }
        if (mod.data) {
          for (const [k, v] of Object.entries(mod.data)) {
            target[k] = v;
          }
        }
      }
    }
    return { blocked: false, modified: current };
  }

  /** Modifying 鏈：依序執行，modify 改 result，不可 block */
  private async _runModifying<T extends HookInput, R>(
    hooks: HookDefinition[],
    input: T,
    initialResult: R,
    resultExtractor: (action: HookAction) => R | undefined,
  ): Promise<R> {
    let result = initialResult;
    for (const hook of hooks) {
      const res = await runHook(hook, input);
      log.debug(`[hook-registry] ${input.event} "${hook.name}" → ${res.action}`);
      if (res.action === "modify") {
        const r = resultExtractor(res);
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  /** Observer：並行 fire-and-await，錯誤只 log */
  private async _runObserver(hooks: HookDefinition[], input: HookInput): Promise<void> {
    await Promise.all(hooks.map(async (hook) => {
      try {
        await runHook(hook, input);
      } catch (err) {
        log.warn(`[hook-registry] observer "${hook.name}" 失敗: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }

  // ── PreToolUse / PostToolUse ────────────────────────────────────────────

  async runPreToolUse(input: PreToolUseInput): Promise<
    | { blocked: false; params: Record<string, unknown> }
    | { blocked: true; reason: string }
  > {
    const hooks = this._resolve("PreToolUse", input.agentId, "global-first", input.toolName);
    if (hooks.length === 0) return { blocked: false, params: input.toolParams };
    const r = await this._runBlocking(hooks, input, "toolParams");
    if (r.blocked) return r;
    return { blocked: false, params: r.modified.toolParams };
  }

  async runPostToolUse(input: PostToolUseInput): Promise<{ result?: unknown; error?: string }> {
    const hooks = this._resolve("PostToolUse", input.agentId, "agent-first", input.toolName);
    if (hooks.length === 0) return input.toolResult;
    return this._runModifying(hooks, input, input.toolResult, (a) => {
      if (a.action !== "modify") return undefined;
      const mod = a as { result?: unknown };
      if (mod.result === undefined) return undefined;
      return { ...input.toolResult, result: mod.result };
    });
  }

  // ── Lifecycle observers ─────────────────────────────────────────────────

  async runSessionStart(input: SessionStartInput): Promise<void> {
    return this._runObserver(this._resolve("SessionStart", input.agentId, "global-first"), input);
  }
  async runSessionEnd(input: SessionEndInput): Promise<void> {
    return this._runObserver(this._resolve("SessionEnd", input.agentId, "global-first"), input);
  }

  // ── Turn / Message ──────────────────────────────────────────────────────

  async runUserMessageReceived(input: UserMessageReceivedInput): Promise<{ blocked: boolean; text: string; reason?: string }> {
    const hooks = this._resolve("UserMessageReceived", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false, text: input.text };
    const r = await this._runBlocking(hooks, input, "text");
    if (r.blocked) return { blocked: true, text: input.text, reason: r.reason };
    return { blocked: false, text: r.modified.text };
  }

  async runUserPromptSubmit(input: UserPromptSubmitInput): Promise<{ blocked: boolean; prompt: string; reason?: string }> {
    const hooks = this._resolve("UserPromptSubmit", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false, prompt: input.prompt };
    const r = await this._runBlocking(hooks, input, "prompt");
    if (r.blocked) return { blocked: true, prompt: input.prompt, reason: r.reason };
    return { blocked: false, prompt: r.modified.prompt };
  }

  async runPreTurn(input: PreTurnInput): Promise<void> {
    return this._runObserver(this._resolve("PreTurn", input.agentId, "global-first"), input);
  }
  async runPostTurn(input: PostTurnInput): Promise<void> {
    return this._runObserver(this._resolve("PostTurn", input.agentId, "global-first"), input);
  }
  async runPreLlmCall(input: PreLlmCallInput): Promise<void> {
    return this._runObserver(this._resolve("PreLlmCall", input.agentId, "global-first"), input);
  }
  async runPostLlmCall(input: PostLlmCallInput): Promise<void> {
    return this._runObserver(this._resolve("PostLlmCall", input.agentId, "global-first"), input);
  }

  async runAgentResponseReady(input: AgentResponseReadyInput): Promise<{ blocked: boolean; text: string; reason?: string }> {
    const hooks = this._resolve("AgentResponseReady", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false, text: input.text };
    const r = await this._runBlocking(hooks, input, "text");
    if (r.blocked) return { blocked: true, text: input.text, reason: r.reason };
    return { blocked: false, text: r.modified.text };
  }

  async runToolTimeout(input: ToolTimeoutInput): Promise<void> {
    return this._runObserver(this._resolve("ToolTimeout", input.agentId, "global-first", input.toolName), input);
  }

  // ── Memory / Atom ───────────────────────────────────────────────────────

  async runPreAtomWrite(input: PreAtomWriteInput): Promise<{ blocked: boolean; content: string; reason?: string }> {
    const hooks = this._resolve("PreAtomWrite", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false, content: input.content };
    const r = await this._runBlocking(hooks, input, "content");
    if (r.blocked) return { blocked: true, content: input.content, reason: r.reason };
    return { blocked: false, content: r.modified.content };
  }
  async runPostAtomWrite(input: PostAtomWriteInput): Promise<void> {
    return this._runObserver(this._resolve("PostAtomWrite", input.agentId, "global-first"), input);
  }
  async runPreAtomDelete(input: PreAtomDeleteInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreAtomDelete", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "reason");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }
  async runPostAtomDelete(input: PostAtomDeleteInput): Promise<void> {
    return this._runObserver(this._resolve("PostAtomDelete", input.agentId, "global-first"), input);
  }
  async runAtomReplace(input: AtomReplaceInput): Promise<void> {
    return this._runObserver(this._resolve("AtomReplace", input.agentId, "global-first"), input);
  }
  async runMemoryRecall(input: MemoryRecallInput): Promise<void> {
    return this._runObserver(this._resolve("MemoryRecall", input.agentId, "global-first"), input);
  }

  // ── Subagent ────────────────────────────────────────────────────────────

  async runPreSubagentSpawn(input: PreSubagentSpawnInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreSubagentSpawn", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "task");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }
  async runPostSubagentComplete(input: PostSubagentCompleteInput): Promise<void> {
    return this._runObserver(this._resolve("PostSubagentComplete", input.agentId, "global-first"), input);
  }
  async runSubagentError(input: SubagentErrorInput): Promise<void> {
    return this._runObserver(this._resolve("SubagentError", input.agentId, "global-first"), input);
  }

  // ── Context / Compaction ────────────────────────────────────────────────

  async runPreCompaction(input: PreCompactionInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreCompaction", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "reason");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }
  async runPostCompaction(input: PostCompactionInput): Promise<void> {
    return this._runObserver(this._resolve("PostCompaction", input.agentId, "global-first"), input);
  }
  async runContextOverflow(input: ContextOverflowInput): Promise<void> {
    return this._runObserver(this._resolve("ContextOverflow", input.agentId, "global-first"), input);
  }

  // ── CLI Bridge ──────────────────────────────────────────────────────────

  async runCliBridgeSpawn(input: CliBridgeSpawnInput): Promise<void> {
    return this._runObserver(this._resolve("CliBridgeSpawn", input.agentId, "global-first"), input);
  }
  async runCliBridgeSuspend(input: CliBridgeSuspendInput): Promise<void> {
    return this._runObserver(this._resolve("CliBridgeSuspend", input.agentId, "global-first"), input);
  }
  async runCliBridgeTurn(input: CliBridgeTurnInput): Promise<void> {
    return this._runObserver(this._resolve("CliBridgeTurn", input.agentId, "global-first"), input);
  }

  // ── File / Command ──────────────────────────────────────────────────────

  async runPreFileWrite(input: PreFileWriteInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreFileWrite", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "path");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }
  async runPreFileEdit(input: PreFileEditInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreFileEdit", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "path");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }
  async runPreCommandExec(input: PreCommandExecInput): Promise<{ blocked: boolean; reason?: string }> {
    const hooks = this._resolve("PreCommandExec", input.agentId, "global-first");
    if (hooks.length === 0) return { blocked: false };
    const r = await this._runBlocking(hooks, input, "command");
    if (r.blocked) return { blocked: true, reason: r.reason };
    return { blocked: false };
  }

  // ── Error / Safety ──────────────────────────────────────────────────────

  async runSafetyViolation(input: SafetyViolationInput): Promise<void> {
    return this._runObserver(this._resolve("SafetyViolation", input.agentId, "global-first"), input);
  }
  async runAgentError(input: AgentErrorInput): Promise<void> {
    return this._runObserver(this._resolve("AgentError", input.agentId, "global-first"), input);
  }

  // ── File Watcher ────────────────────────────────────────────────────────

  async runFileChanged(input: FileChangedInput): Promise<void> {
    const { getFileWatcher } = await import("./file-watcher.js");
    const fw = getFileWatcher();
    fw?.enterHookContext();
    try {
      return this._runObserver(this._resolve("FileChanged", input.agentId, "global-first"), input);
    } finally {
      fw?.leaveHookContext();
    }
  }
  async runFileDeleted(input: FileDeletedInput): Promise<void> {
    const { getFileWatcher } = await import("./file-watcher.js");
    const fw = getFileWatcher();
    fw?.enterHookContext();
    try {
      return this._runObserver(this._resolve("FileDeleted", input.agentId, "global-first"), input);
    } finally {
      fw?.leaveHookContext();
    }
  }

  // ── Platform ────────────────────────────────────────────────────────────

  async runConfigReload(input: ConfigReloadInput): Promise<void> {
    return this._runObserver(this._resolve("ConfigReload", input.agentId, "global-first"), input);
  }
  async runProviderSwitch(input: ProviderSwitchInput): Promise<void> {
    return this._runObserver(this._resolve("ProviderSwitch", input.agentId, "global-first"), input);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _hookRegistry: HookRegistry | null = null;

export function initHookRegistry(init: RegistryInit): HookRegistry {
  _hookRegistry = new HookRegistry(init);
  return _hookRegistry;
}

export function getHookRegistry(): HookRegistry | null {
  return _hookRegistry;
}
