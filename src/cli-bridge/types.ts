/**
 * @file cli-bridge/types.ts
 * @description CLI Bridge 型別定義
 *
 * Claude CLI 持久 bridge 的所有共用型別。
 * CLI 透過 `--input-format stream-json --output-format stream-json` 持久模式運作，
 * CatClaw 控制 stdin/stdout，不排隊（CLI 自己管內部 queue）。
 */

// ── stdin 訊息型別（送給 CLI 的 NDJSON）────────────────────────────────────────

/** 使用者訊息 */
export interface StdinUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}

/** Keep-alive ping */
export interface StdinKeepAlive {
  type: "keep_alive";
}

/** 權限請求回覆（未來擴充用） */
export interface StdinControlResponse {
  type: "control_response";
  permission_request_id: string;
  allowed: boolean;
}

/** 所有 stdin 訊息聯集 */
export type StreamJsonMessage =
  | StdinUserMessage
  | StdinKeepAlive
  | StdinControlResponse;

// ── stdout 事件型別（從 CLI 收到的）────────────────────────────────────────────

/** CLI Bridge 事件聯集（沿用 AcpEvent 概念，擴充持久模式事件） */
export type CliBridgeEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; title: string }
  | { type: "tool_result"; title: string; duration_ms?: number }
  | { type: "session_init"; sessionId: string }
  | { type: "result"; is_error: boolean; text?: string; session_id?: string }
  | { type: "error"; message: string }
  | { type: "control_request"; requestId: string; tool: string; description: string }
  | { type: "status"; subtype: string; raw: unknown };

// ── 設定型別 ──────────────────────────────────────────────────────────────────

/** 單一 channel 的 bridge 設定 */
export interface CliBridgeChannelConfig {
  /** 識別標籤（用於 log 和 Dashboard） */
  label: string;
  /** 指定 session ID（null = 每次啟動新 session） */
  sessionId?: string | null;
  /** 跳過權限確認 */
  dangerouslySkipPermissions?: boolean;
}

/** catclaw.json 中的 cliBridge 區塊 */
export interface CliBridgeConfig {
  enabled: boolean;
  /** Claude CLI binary 路徑（預設 "claude"） */
  claudeBin?: string;
  /** CLI 工作目錄 */
  workingDir: string;
  /** 日誌目錄 */
  logDir?: string;
  /** channel ID → channel 設定 */
  channels: Record<string, CliBridgeChannelConfig>;
  /** Keep-alive 間隔毫秒（預設 60000） */
  keepAliveIntervalMs?: number;
  /** 重啟退避間隔毫秒清單（預設 [1000, 2000, 4000, 8000, 16000, 30000]） */
  restartBackoffMs?: number[];
  /** 顯示 thinking（預設 false） */
  showThinking?: boolean;
  /** Discord edit 最小間隔毫秒（rate limit 保護，預設 800） */
  editIntervalMs?: number;
}

/** CliProcess 建構參數 */
export interface CliProcessConfig {
  /** Claude CLI binary 路徑 */
  claudeBin: string;
  /** 工作目錄 */
  workingDir: string;
  /** Session ID（可選） */
  sessionId?: string;
  /** 跳過權限確認 */
  dangerouslySkipPermissions: boolean;
  /** 識別標籤 */
  label: string;
}

// ── Turn 追蹤型別 ─────────────────────────────────────────────────────────────

/** send() 回傳的 handle，用於追蹤此 turn 的事件 */
export interface TurnHandle {
  turnId: string;
  /** 監聽此 turn 的事件 */
  events: AsyncGenerator<CliBridgeEvent>;
  /** 取消此 turn（送 SIGINT） */
  abort(): void;
}

/** 完整 turn 歷程紀錄 */
export interface TurnRecord {
  turnId: string;
  startedAt: string;          // ISO 8601
  completedAt?: string;
  source: "discord" | "dashboard";
  userInput: string;
  toolCalls: Array<{ name: string; preview: string; durationMs?: number }>;
  assistantReply: string;
  discordDelivery: "success" | "failed" | "pending" | "skipped";
  discordMessageId?: string;
  failedReason?: string;
}

// ── 日誌型別 ──────────────────────────────────────────────────────────────────

/** stdout 日誌條目 */
export interface StdoutLogEntry {
  ts: string;           // ISO 8601
  turnId?: string;
  event: CliBridgeEvent;
  raw?: string;         // 原始 JSON 行（debug 用）
}

/** Bridge 狀態 */
export type BridgeStatus = "idle" | "busy" | "dead" | "restarting";
