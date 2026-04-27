/**
 * @file core/event-bus.ts
 * @description CatClaw 事件匯流排 — Node.js EventEmitter 封裝，強型別事件定義
 *
 * 仿 OpenClaw internal hooks，所有子系統透過 EventBus 溝通，不直接互相 import。
 * 事件定義對應架構文件第 11 節。
 */

import { EventEmitter } from "node:events";

// ── 事件 payload 型別 ────────────────────────────────────────────────────────

export interface TurnContext {
  accountId: string;
  channelId: string;
  sessionKey: string;
  prompt: string;
  projectId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  params: unknown;
}

export interface ToolResult {
  result?: unknown;
  error?: string;
  fileModified?: boolean;
  modifiedPath?: string;
}

export interface AtomFragment {
  name: string;
  path: string;
  content: string;
  score?: number;
}

export interface KnowledgeItem {
  content: string;
  type: string;
  confidence: string;
}

export type MemoryLayer = "global" | "project" | "account";

export interface RutWarning {
  pattern: string;
  count: number;
  sessions: string[];
}

export interface TaskUiPayload {
  id: string;
  subject: string;
  status: string;
  description?: string;
  blockedBy: string[];
}

// ── 事件清單（型別安全定義）─────────────────────────────────────────────────

/** CatClaw 平台全域事件，對應架構文件第 11 節 */
export interface CatClawEvents {
  // ── 平台生命週期 ──
  "platform:startup":    [];
  "platform:shutdown":   [];

  // ── Session ──
  "session:created":     [sessionId: string, accountId: string];
  "session:idle":        [sessionId: string, idleMs: number];
  "session:end":         [sessionId: string];

  // ── Turn ──
  "turn:before":         [ctx: TurnContext];
  "turn:after":          [ctx: TurnContext, response: string];
  "turn:queued":         [sessionKey: string, accountId: string];
  "turn:started":        [sessionKey: string, accountId: string];

  // ── Tool ──
  "tool:before":         [call: ToolCall];
  "tool:after":          [call: ToolCall, result: ToolResult];
  "tool:error":          [call: ToolCall, error: Error];

  // ── Provider ──
  "provider:error":      [providerId: string, error: Error];
  "provider:rateLimit":  [providerId: string, retryAfterMs: number];

  // ── 檔案 ──
  "file:modified":       [path: string, tool: string, accountId: string];
  "file:read":           [path: string, accountId: string];

  // ── 記憶 ──
  "memory:recalled":     [atoms: AtomFragment[], layer: MemoryLayer];
  "memory:extracted":    [items: KnowledgeItem[]];
  "memory:written":      [atom: string, layer: MemoryLayer];
  "memory:promoted":     [atom: string, from: string, to: string];
  "memory:archived":     [atom: string, score: number];

  // ── 工作流 ──
  "workflow:rut":        [warnings: RutWarning[]];
  "workflow:oscillation":[atom: string, count: number];
  "workflow:sync_needed":[files: string[]];

  // ── 排程 / Skill ──
  "cron:executed":       [jobId: string];
  "skill:invoked":       [skillName: string, accountId: string];

  // ── Subagent ──
  "subagent:completed":  [parentSessionKey: string, runId: string, label: string, result: string];
  "subagent:failed":     [parentSessionKey: string, runId: string, label: string, error: string];

  // ── Task UI ──
  "task:ui":             [channelId: string, tasks: TaskUiPayload[]];

  // ── 帳號 ──
  "account:created":     [accountId: string];
  "account:linked":      [accountId: string, platform: string];

  // ── Context Engineering ──
  "context:compressed":  [sessionKey: string];

  // ── Log Monitor ──
  "log:error":           [snapshot: { timestamp: string; message: string; context: string; snapshotPath: string }];

  // ── Health Monitor（component-level fail-loud + escalation）──
  "health:startup":      [results: Array<{ name: string; ok: boolean; detail: string }>];
  "health:degraded":     [name: string, error: string];
  "health:critical":     [name: string, error: string];
  "health:recovered":    [name: string];
}

// ── EventBus 實作 ─────────────────────────────────────────────────────────

type EventKey = keyof CatClawEvents;
type EventPayload<K extends EventKey> = CatClawEvents[K];

/**
 * 強型別 EventBus，包裝 Node.js EventEmitter
 * 提供 on/off/emit 三個主要方法
 */
class CatClawEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 提高上限避免偵測到 memory leak 警告（大量模組訂閱時）
    this.emitter.setMaxListeners(100);
  }

  /** 訂閱事件 */
  on<K extends EventKey>(event: K, listener: (...args: EventPayload<K>) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** 取消訂閱 */
  off<K extends EventKey>(event: K, listener: (...args: EventPayload<K>) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** 單次訂閱（觸發一次後自動移除） */
  once<K extends EventKey>(event: K, listener: (...args: EventPayload<K>) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** 發送事件（同步） */
  emit<K extends EventKey>(event: K, ...args: EventPayload<K>): boolean {
    return this.emitter.emit(event, ...args);
  }
}

// ── 全域單例 ─────────────────────────────────────────────────────────────────

/** 平台全域 EventBus 單例，所有模組共用 */
export const eventBus = new CatClawEventBus();
