/**
 * @file hooks/index.ts
 * @description Hook 系統公開介面
 */

export type {
  HookEvent, HookInput, HookAction, HookDefinition, HookRuntime, HookInputMap,
} from "./types.js";
export type {
  PreToolUseInput, PostToolUseInput, SessionStartInput, SessionEndInput,
  UserMessageReceivedInput, UserPromptSubmitInput,
  PreTurnInput, PostTurnInput, PreLlmCallInput, PostLlmCallInput,
  AgentResponseReadyInput, ToolTimeoutInput,
  PreAtomWriteInput, PostAtomWriteInput, PreAtomDeleteInput, PostAtomDeleteInput,
  AtomReplaceInput, MemoryRecallInput,
  PreSubagentSpawnInput, PostSubagentCompleteInput, SubagentErrorInput,
  PreCompactionInput, PostCompactionInput, ContextOverflowInput,
  CliBridgeSpawnInput, CliBridgeSuspendInput, CliBridgeTurnInput,
  PreFileWriteInput, PreFileEditInput, PreCommandExecInput,
  FileChangedInput, FileDeletedInput,
  SafetyViolationInput, AgentErrorInput,
  ConfigReloadInput, ProviderSwitchInput,
} from "./types.js";
export { runHook } from "./hook-runner.js";
export { HookRegistry, initHookRegistry, getHookRegistry } from "./hook-registry.js";
export type { RegistryInit } from "./hook-registry.js";
export { defineHook, isDefinedHook } from "./sdk.js";
export type { HookMetadata, HookHandler, DefinedHook } from "./sdk.js";
export { HookScanner } from "./hook-scanner.js";
export type { ScanResult, ScannerOptions } from "./hook-scanner.js";
