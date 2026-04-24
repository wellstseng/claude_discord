/**
 * @file cli-bridge/types.ts
 * @description CLI Bridge 型別定義
 *
 * Claude CLI 持久 bridge 的所有共用型別。
 * CLI 透過 `--input-format stream-json --output-format stream-json` 持久模式運作，
 * CatClaw 控制 stdin/stdout，不排隊（CLI 自己管內部 queue）。
 */

// ── stdin 訊息型別（送給 CLI 的 NDJSON）────────────────────────────────────────

/** stdin 文字區塊 */
export interface StdinTextBlock {
  type: "text";
  text: string;
}

/** stdin 圖片區塊（base64 編碼，符合 Anthropic API 格式） */
export interface StdinImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

export type StdinContentBlock = StdinTextBlock | StdinImageBlock;

/** 使用者訊息 */
export interface StdinUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | StdinContentBlock[];
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
  | { type: "tool_result"; title: string; duration_ms?: number; error?: string }
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
  /** 指定 session ID（null = 自動產生 cli:ch:{channelId}） */
  sessionId?: string | null;
  /** 跳過權限確認 */
  dangerouslySkipPermissions?: boolean;
  /** 需要 @mention 才回覆（預設 false） */
  requireMention?: boolean;
  /** 最近一次自動附加到頻道名的尾綴（下次變更時用於移除舊尾綴，避免累加） */
  autoNameSuffix?: string | null;
}

/** Provider 類型（決定 spawn 哪個 CLI binary 與用什麼 protocol） */
export type CliProviderName = "claude" | "codex";

/** 單一 CLI Bridge 實例設定 */
export interface CliBridgeConfig {
  enabled: boolean;
  /** 識別標籤（全域唯一） */
  label: string;
  /** CLI provider 類型（預設 "claude" 向後相容） */
  provider?: CliProviderName;
  /** Claude CLI binary 路徑（預設 "claude"，僅 provider=claude 用到） */
  claudeBin?: string;
  /** Codex CLI binary 路徑（預設 "codex"，僅 provider=codex 用到） */
  codexBin?: string;
  /** CLI 工作目錄 */
  workingDir: string;
  /** 日誌目錄 */
  logDir?: string;
  /** channel ID → channel 設定 */
  channels: Record<string, CliBridgeChannelConfig>;
  /** 獨立 Discord Bot Token（有 → 獨立 Client，沒有 → 主 bot fallback） */
  botToken?: string;
  /** Keep-alive 間隔毫秒（預設 0 = 不送 ping） */
  keepAliveIntervalMs?: number;
  /** 重啟退避間隔毫秒清單（預設 [1000, 2000, 4000, 8000, 16000, 30000]） */
  restartBackoffMs?: number[];
  /** Turn idle 超時毫秒（預設 300000 = 5 分鐘，設 0 關閉） */
  turnTimeoutMs?: number;
  /** 超時行為："ask" = Discord 按鈕讓使用者選（預設）| "interrupt" = 自動 SIGINT | "warn" = 僅通知 | "restart" = 重啟 process */
  turnTimeoutAction?: "ask" | "interrupt" | "warn" | "restart";
  /** 顯示 thinking（預設 false） */
  showThinking?: boolean;
  /** Discord edit 最小間隔毫秒（rate limit 保護，預設 800） */
  editIntervalMs?: number;
  /** 中間推理文字顯示方式（tool 之間的文字）：
   *  "normal" = 原樣顯示（舊行為），"quote" = 引用區塊（預設），
   *  "spoiler" = 摺疊，"none" = 不顯示 */
  showIntermediateText?: "normal" | "quote" | "spoiler" | "none";
  /** 閒置超過此毫秒後自動卸載 CLI process（預設 0 = 不卸載） */
  idleSuspendMs?: number;
  /** Graceful shutdown 等待 pending turns 完成的上限（預設 30000ms） */
  shutdownDrainTimeoutMs?: number;
}

/** catclaw.json 中的 cliBridges 區塊（陣列，每個 entry 一個獨立 CLI） */
export type CliBridgesConfig = CliBridgeConfig[];

/** CliProcess 建構參數 */
export interface CliProcessConfig {
  /** Provider 類型（決定 instantiate 哪個 CliProvider） */
  provider: CliProviderName;
  /** CLI binary 路徑（依 provider 由 bridge 決定 — claudeBin / 未來 codexBin） */
  cliBin: string;
  /** 工作目錄 */
  workingDir: string;
  /** Session ID（可選） */
  sessionId?: string;
  /** 跳過權限確認 */
  dangerouslySkipPermissions: boolean;
  /** 識別標籤 */
  label: string;
  /** CLI Bridge 專屬 Discord bot token（注入 catclaw-bridge-discord MCP，用 bridge 自己的 bot） */
  botToken?: string;
  /** 綁定的 Discord channel ID（env + MCP DISCORD_ALLOWED_CHANNELS） */
  channelId?: string;
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
export type BridgeStatus = "idle" | "busy" | "dead" | "restarting" | "suspended";
