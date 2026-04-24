/**
 * @file cli-bridge/providers/provider.ts
 * @description CliProvider interface — 把 CLI-specific 邏輯（spawn args、stdin/stdout 編解碼、
 * session resume 規則）從 process.ts 抽出來，process.ts 變成 thin shell。
 *
 * 第一個實作：providers/claude.ts（從 process.ts 整段平移）
 * Phase 2 加：providers/codex.ts（codex app-server JSON-RPC）
 */

import type { CliBridgeEvent, CliProcessConfig, StdinImageBlock } from "../types.js";

/** 啟動 CLI process 前由 provider 決定的 spawn 參數 */
export interface ProviderSpawnSpec {
  /** spawn args（不含 binary 路徑；bin 由 process.ts 用 config.cliBin） */
  args: string[];
  /** 額外環境變數（會 merge 到 process.env） */
  env: Record<string, string>;
}

/** Provider 提供給 process.ts 的 IO 介面（process.ts 注入給 provider 用） */
export interface ProcessIO {
  /** 寫一行 JSON 到 CLI stdin（包含換行） */
  writeStdinLine(line: string): void;
  /** 發訊號給 child process（Claude interrupt 用 SIGINT） */
  signal(sig: NodeJS.Signals): void;
}

/** askUser callback — codex approval 等情境用 */
export interface AskUserRequest {
  /** 工具 / 操作名（例：exec_command、apply_patch） */
  tool: string;
  /** 人類可讀的摘要（會顯示到 Discord button 訊息） */
  description: string;
  /** 額外細節（例：要執行的 shell command 全文、要 apply 的 patch 內容） */
  detail?: string;
}

export type AskUserCallback = (req: AskUserRequest) => Promise<{ allowed: boolean; reason?: string }>;

/** Provider 在 init / parse 時可用的 context */
export interface ProviderContext {
  /** Emit CliBridgeEvent 給 bridge */
  emit(evt: CliBridgeEvent): void;
  /** 當前 session ID（若有） */
  sessionId?: string;
  /** 向使用者詢問審批（Discord 按鈕）；codex 的 execCommandApproval 等用 */
  askUser?: AskUserCallback;
}

/**
 * CLI Provider interface — 任何要接到 cli-bridge 框架的 CLI 都要實作這個 interface。
 *
 * Provider 負責「CLI 怎麼講話」，process.ts 負責「process 怎麼活」（spawn / kill / pipe）。
 */
export interface CliProvider {
  /** Provider 識別名 */
  readonly name: string;

  /**
   * Build spawn 參數（可能包含寫入 per-bridge config 檔的副作用）。
   * 在 spawn 前被 process.ts 呼叫一次。
   */
  buildSpawn(config: CliProcessConfig): ProviderSpawnSpec;

  /**
   * Spawn 後的初始化（例：Codex 的 initialize handshake + thread/start）。
   * Claude 不需要做事，直接 resolve。
   * 實作可呼叫 ctx.emit() 發出 session_init 等事件。
   */
  postSpawn(io: ProcessIO, ctx: ProviderContext): Promise<void>;

  /**
   * Encode + 送出 user message 到 CLI（stdin 或 RPC，由 provider 自決）。
   */
  sendUserMessage(io: ProcessIO, text: string, imageBlocks: StdinImageBlock[] | undefined, ctx: ProviderContext): void;

  /**
   * Encode + 送出 keep-alive ping。回 false 表示寫入失敗 / process 不在；回 null 代表 provider 不需要 keep-alive。
   */
  sendKeepAlive(io: ProcessIO): boolean | null;

  /**
   * Encode + 送出 control response（權限決策回覆）。
   * Claude 用 stdin control_response；Codex 第一版可 noop。
   */
  sendControlResponse(io: ProcessIO, requestId: string, allowed: boolean): void;

  /**
   * 中斷當前 turn（Claude: io.signal("SIGINT")；Codex: turn/interrupt RPC）
   */
  interrupt(io: ProcessIO, ctx: ProviderContext): void;

  /**
   * 解析一行 stdout JSON，emit 出 0-N 個 CliBridgeEvent。
   * Provider 自管 diff/串流狀態（Claude 的 lastMessageId / lastTextLength 等）。
   */
  parseStdoutLine(obj: Record<string, unknown>, ctx: ProviderContext): void;

  /**
   * 重置串流狀態（process restart / spawn 前呼叫）。
   */
  resetStreamState(): void;

  /**
   * 判斷某個 sessionId 是否可被 resume（檔案是否存在等）。
   */
  isSessionResumable(sessionId: string): boolean;
}
