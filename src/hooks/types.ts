/**
 * @file hooks/types.ts
 * @description Hook 系統型別定義
 *
 * Hook = 在 agent-loop / memory / cli-bridge / platform 關鍵時機點執行的腳本。
 * 兩種掛載方式：
 * - 目錄約定：~/.catclaw/workspace/hooks/*.ts（全域）+ agents/{id}/hooks/*.ts（agent）
 * - Config 覆蓋：catclaw.json.hooks[] / agentConfig.hooks[]（覆寫 enabled / timeout / filter）
 *
 * Runtime：依副檔名分派
 * - .ts → bunx tsx hook-runtime.ts <script>
 * - .js / .mjs → node <script>
 * - .sh / .bat / .ps1 → shell
 * - 純字串 command → shell
 */

// ── Hook Event 類型（共 34 事件）──────────────────────────────────────────────

export type HookEvent =
  // Lifecycle (4)
  | "PreToolUse" | "PostToolUse"
  | "SessionStart" | "SessionEnd"
  // Turn / Message (8)
  | "UserMessageReceived" | "UserPromptSubmit"
  | "PreTurn" | "PostTurn"
  | "PreLlmCall" | "PostLlmCall"
  | "AgentResponseReady"
  | "ToolTimeout"
  // Memory / Atom (6)
  | "PreAtomWrite" | "PostAtomWrite"
  | "PreAtomDelete" | "PostAtomDelete"
  | "AtomReplace"
  | "MemoryRecall"
  // Subagent (3)
  | "PreSubagentSpawn" | "PostSubagentComplete" | "SubagentError"
  // Context / Compaction (3)
  | "PreCompaction" | "PostCompaction" | "ContextOverflow"
  // CLI Bridge (3)
  | "CliBridgeSpawn" | "CliBridgeSuspend" | "CliBridgeTurn"
  // File System / Command (3)
  | "PreFileWrite" | "PreFileEdit" | "PreCommandExec"
  // File Watcher (2)
  | "FileChanged" | "FileDeleted"
  // Error / Safety (2)
  | "SafetyViolation" | "AgentError"
  // Platform (2)
  | "ConfigReload" | "ProviderSwitch";

// ── Hook 輸入（寫入 stdin 的 JSON）─────────────────────────────────────────

interface BaseInput {
  /** 觸發 agent ID（global hook 也會收到） */
  agentId?: string;
  /** Session 識別 */
  sessionKey?: string;
  /** Discord channel（若有） */
  channelId?: string;
  /** 帳號識別 */
  accountId?: string;
}

// Lifecycle ───────────────────────────────────────────────────────────────────

export interface PreToolUseInput extends BaseInput {
  event: "PreToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  toolTier: string;
}

export interface PostToolUseInput extends BaseInput {
  event: "PostToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  toolResult: { result?: unknown; error?: string };
  durationMs: number;
}

export interface SessionStartInput extends BaseInput {
  event: "SessionStart";
}

export interface SessionEndInput extends BaseInput {
  event: "SessionEnd";
  turnCount: number;
}

// Turn / Message ──────────────────────────────────────────────────────────────

export interface UserMessageReceivedInput extends BaseInput {
  event: "UserMessageReceived";
  source: "discord" | "dashboard" | "cli-bridge" | "subagent" | "cron";
  text: string;
  attachments?: { name: string; type?: string; size?: number }[];
  user?: string;
}

export interface UserPromptSubmitInput extends BaseInput {
  event: "UserPromptSubmit";
  prompt: string;
  injectedContext?: string[];
}

export interface PreTurnInput extends BaseInput {
  event: "PreTurn";
  turnIndex: number;
  pendingInput?: string;
}

export interface PostTurnInput extends BaseInput {
  event: "PostTurn";
  turnIndex: number;
  toolCallCount: number;
  durationMs: number;
}

export interface PreLlmCallInput extends BaseInput {
  event: "PreLlmCall";
  model: string;
  provider: string;
  promptTokens?: number;
  messageCount: number;
}

export interface PostLlmCallInput extends BaseInput {
  event: "PostLlmCall";
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  finishReason?: string;
}

export interface AgentResponseReadyInput extends BaseInput {
  event: "AgentResponseReady";
  text: string;
  destination: "discord" | "dashboard" | "subagent" | "cli-bridge";
}

export interface ToolTimeoutInput extends BaseInput {
  event: "ToolTimeout";
  toolName: string;
  toolParams: Record<string, unknown>;
  timeoutMs: number;
}

// Memory / Atom ───────────────────────────────────────────────────────────────

export interface PreAtomWriteInput extends BaseInput {
  event: "PreAtomWrite";
  atomPath: string;
  scope: "global" | "agent";
  content: string;
}

export interface PostAtomWriteInput extends BaseInput {
  event: "PostAtomWrite";
  atomPath: string;
  scope: "global" | "agent";
  bytesWritten: number;
}

export interface PreAtomDeleteInput extends BaseInput {
  event: "PreAtomDelete";
  atomPath: string;
  scope: "global" | "agent";
  reason?: string;
}

export interface PostAtomDeleteInput extends BaseInput {
  event: "PostAtomDelete";
  atomPath: string;
  scope: "global" | "agent";
}

export interface AtomReplaceInput extends BaseInput {
  event: "AtomReplace";
  atomPath: string;
  scope: "global" | "agent";
  oldContent: string;
  newContent: string;
}

export interface MemoryRecallInput extends BaseInput {
  event: "MemoryRecall";
  query: string;
  hitCount: number;
  durationMs: number;
}

// Subagent ────────────────────────────────────────────────────────────────────

export interface PreSubagentSpawnInput extends BaseInput {
  event: "PreSubagentSpawn";
  subagentId: string;
  parentAgentId: string;
  task: string;
}

export interface PostSubagentCompleteInput extends BaseInput {
  event: "PostSubagentComplete";
  subagentId: string;
  parentAgentId: string;
  durationMs: number;
  success: boolean;
}

export interface SubagentErrorInput extends BaseInput {
  event: "SubagentError";
  subagentId: string;
  parentAgentId: string;
  error: string;
}

// Context / Compaction ────────────────────────────────────────────────────────

export interface PreCompactionInput extends BaseInput {
  event: "PreCompaction";
  reason: "ce-decay" | "context-overflow" | "manual";
  currentTokens?: number;
  budgetTokens?: number;
}

export interface PostCompactionInput extends BaseInput {
  event: "PostCompaction";
  beforeTokens?: number;
  afterTokens?: number;
  durationMs: number;
}

export interface ContextOverflowInput extends BaseInput {
  event: "ContextOverflow";
  currentTokens: number;
  budgetTokens: number;
}

// CLI Bridge ──────────────────────────────────────────────────────────────────

export interface CliBridgeSpawnInput extends BaseInput {
  event: "CliBridgeSpawn";
  bridgeLabel: string;
  cwd: string;
  resumedSessionId?: string;
}

export interface CliBridgeSuspendInput extends BaseInput {
  event: "CliBridgeSuspend";
  bridgeLabel: string;
  idleMs: number;
}

export interface CliBridgeTurnInput extends BaseInput {
  event: "CliBridgeTurn";
  bridgeLabel: string;
  turnId: string;
  durationMs: number;
}

// File System / Command ───────────────────────────────────────────────────────

export interface PreFileWriteInput extends BaseInput {
  event: "PreFileWrite";
  path: string;
  bytes: number;
}

export interface PreFileEditInput extends BaseInput {
  event: "PreFileEdit";
  path: string;
  oldString: string;
  newString: string;
}

export interface PreCommandExecInput extends BaseInput {
  event: "PreCommandExec";
  command: string;
  cwd?: string;
}

// Error / Safety ──────────────────────────────────────────────────────────────

export interface SafetyViolationInput extends BaseInput {
  event: "SafetyViolation";
  rule: string;
  detail: string;
  toolName?: string;
}

export interface AgentErrorInput extends BaseInput {
  event: "AgentError";
  error: string;
  stack?: string;
  phase: "tool" | "llm" | "memory" | "platform" | "other";
}

// File Watcher ────────────────────────────────────────────────────────────────

export interface FileChangedInput extends BaseInput {
  event: "FileChanged";
  /** 變更的檔案絕對路徑 */
  filePath: string;
  /** config 中的 label（e.g. "obsidian"） */
  watchLabel: string;
  /** 變更類型 */
  changeType: "create" | "modify";
}

export interface FileDeletedInput extends BaseInput {
  event: "FileDeleted";
  /** 刪除的檔案絕對路徑 */
  filePath: string;
  /** config 中的 label */
  watchLabel: string;
}

// Platform ────────────────────────────────────────────────────────────────────

export interface ConfigReloadInput extends BaseInput {
  event: "ConfigReload";
  changedKeys: string[];
}

export interface ProviderSwitchInput extends BaseInput {
  event: "ProviderSwitch";
  fromProvider: string;
  toProvider: string;
  reason: "failover" | "manual" | "routing";
}

// 統一聯集 ───────────────────────────────────────────────────────────────────

export type HookInput =
  | PreToolUseInput | PostToolUseInput | SessionStartInput | SessionEndInput
  | UserMessageReceivedInput | UserPromptSubmitInput
  | PreTurnInput | PostTurnInput | PreLlmCallInput | PostLlmCallInput
  | AgentResponseReadyInput | ToolTimeoutInput
  | PreAtomWriteInput | PostAtomWriteInput | PreAtomDeleteInput | PostAtomDeleteInput
  | AtomReplaceInput | MemoryRecallInput
  | PreSubagentSpawnInput | PostSubagentCompleteInput | SubagentErrorInput
  | PreCompactionInput | PostCompactionInput | ContextOverflowInput
  | CliBridgeSpawnInput | CliBridgeSuspendInput | CliBridgeTurnInput
  | PreFileWriteInput | PreFileEditInput | PreCommandExecInput
  | FileChangedInput | FileDeletedInput
  | SafetyViolationInput | AgentErrorInput
  | ConfigReloadInput | ProviderSwitchInput;

/** Event 名稱 → 對應 Input 型別映射（給 SDK defineHook 使用） */
export type HookInputMap = {
  PreToolUse: PreToolUseInput;
  PostToolUse: PostToolUseInput;
  SessionStart: SessionStartInput;
  SessionEnd: SessionEndInput;
  UserMessageReceived: UserMessageReceivedInput;
  UserPromptSubmit: UserPromptSubmitInput;
  PreTurn: PreTurnInput;
  PostTurn: PostTurnInput;
  PreLlmCall: PreLlmCallInput;
  PostLlmCall: PostLlmCallInput;
  AgentResponseReady: AgentResponseReadyInput;
  ToolTimeout: ToolTimeoutInput;
  PreAtomWrite: PreAtomWriteInput;
  PostAtomWrite: PostAtomWriteInput;
  PreAtomDelete: PreAtomDeleteInput;
  PostAtomDelete: PostAtomDeleteInput;
  AtomReplace: AtomReplaceInput;
  MemoryRecall: MemoryRecallInput;
  PreSubagentSpawn: PreSubagentSpawnInput;
  PostSubagentComplete: PostSubagentCompleteInput;
  SubagentError: SubagentErrorInput;
  PreCompaction: PreCompactionInput;
  PostCompaction: PostCompactionInput;
  ContextOverflow: ContextOverflowInput;
  CliBridgeSpawn: CliBridgeSpawnInput;
  CliBridgeSuspend: CliBridgeSuspendInput;
  CliBridgeTurn: CliBridgeTurnInput;
  PreFileWrite: PreFileWriteInput;
  PreFileEdit: PreFileEditInput;
  PreCommandExec: PreCommandExecInput;
  FileChanged: FileChangedInput;
  FileDeleted: FileDeletedInput;
  SafetyViolation: SafetyViolationInput;
  AgentError: AgentErrorInput;
  ConfigReload: ConfigReloadInput;
  ProviderSwitch: ProviderSwitchInput;
};

// ── Hook 輸出（從 stdout 讀取的 JSON）──────────────────────────────────────

export type HookAction =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; params?: Record<string, unknown>; result?: unknown; data?: Record<string, unknown> }
  | { action: "passthrough" };

// ── Hook Runtime（執行器分派）────────────────────────────────────────────────

export type HookRuntime = "auto" | "node" | "ts" | "shell";

// ── Hook 定義（檔案 metadata 或 config 覆蓋）────────────────────────────────

export interface HookDefinition {
  /** Hook 名稱（用於 log 識別；若由 scanner 載入則自動取自檔名） */
  name: string;
  /** 觸發事件 */
  event: HookEvent;
  /** 執行的 shell command（與 scriptPath 二擇一） */
  command?: string;
  /** 執行的腳本路徑（與 command 二擇一；副檔名決定 runtime） */
  scriptPath?: string;
  /** Runtime 強制指定（預設 auto，由副檔名推斷） */
  runtime?: HookRuntime;
  /** 超時毫秒（預設 5000） */
  timeoutMs?: number;
  /** 只在指定 tool 時觸發（PreToolUse / PostToolUse / ToolTimeout / PreCommandExec 專用） */
  toolFilter?: string[];
  /** 是否啟用（預設 true） */
  enabled?: boolean;
  /** 作用域：global = 所有 agent；agent = 特定 agent（由 scanner 載入時賦值） */
  scope?: "global" | "agent";
  /** Agent ID（scope=agent 時必填，由 scanner 載入時賦值） */
  agentId?: string;
}
