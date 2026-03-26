/**
 * @file workflow/types.ts
 * @description 工作流引擎共用型別
 */

// ── Wisdom Engine ─────────────────────────────────────────────────────────────

export interface WisdomAdvice {
  rule: string;
  message: string;
  tokenCount: number;
}

export interface ReflectionMetrics {
  /** 同一檔案 Edit 2+ 次的比例（over-engineering 指標） */
  overEngineeringRate: number;
  /** 總 turn 數 */
  totalTurns: number;
  /** 工具呼叫次數 */
  totalToolCalls: number;
}

// ── Rut Detection ─────────────────────────────────────────────────────────────

export interface RutSignal {
  pattern: string;   // e.g. "same_file_3x:/path/to/file.ts"
  sessionId: string;
  recordedAt: string; // ISO
}

export interface RutWarning {
  pattern: string;
  count: number;
  sessions: string[];
}

// ── Oscillation ───────────────────────────────────────────────────────────────

export interface OscillationRecord {
  atom: string;
  editCount: number;
  sessionKey: string;
  lastEditAt: string;
}

// ── Fix Escalation ────────────────────────────────────────────────────────────

export interface EscalationContext {
  sessionKey: string;
  accountId: string;
  failedPrompt: string;
  errorHistory: string[];
  retryCount: number;
}

export interface EscalationAttempt {
  turnIndex: number;
  systemPromptVariant: string;
  result?: string;
  resolved: boolean;
}
