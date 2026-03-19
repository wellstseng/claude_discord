/**
 * @file config.ts
 * @description 環境變數讀取與驗證
 *
 * 從 process.env 讀取所有設定，進行型別轉換與驗證，
 * export 單一 BridgeConfig 物件供其他模組使用。
 * 缺少必填欄位時直接拋出錯誤，讓問題在啟動時立即浮現。
 */

/** 觸發模式：mention = 需 @mention bot；all = 白名單頻道內所有訊息 */
export type TriggerMode = "mention" | "all";

/** 全域設定物件型別 */
export interface BridgeConfig {
  /** Discord Bot Token（必填） */
  discordToken: string;
  /** 訊息觸發模式，預設 "mention" */
  triggerMode: TriggerMode;
  /** 允許回應的頻道 ID 集合，空集合表示全部允許 */
  allowedChannelIds: Set<string>;
  /** Claude session 工作目錄（spawn cwd），預設 $HOME */
  claudeCwd: string;
  /** claude CLI binary 路徑，預設 "claude" */
  claudeCommand: string;
  /** Debounce 毫秒數，同一人連續訊息的合併等待時間，預設 500 */
  debounceMs: number;
  /** Claude 回應超時毫秒數，超時自動 kill process，預設 300000（5 分鐘） */
  turnTimeoutMs: number;
}

/**
 * 從環境變數載入並驗證設定
 * @returns 完整的 BridgeConfig 物件
 * @throws 若 DISCORD_BOT_TOKEN 未設定
 * @throws 若 TRIGGER_MODE 為非法值
 */
function loadConfig(): BridgeConfig {
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) {
    throw new Error("DISCORD_BOT_TOKEN 環境變數必填，請設定後再啟動");
  }

  // 驗證 TRIGGER_MODE 只接受已知值
  const rawTriggerMode = process.env.TRIGGER_MODE ?? "mention";
  if (rawTriggerMode !== "mention" && rawTriggerMode !== "all") {
    throw new Error(
      `TRIGGER_MODE 必須是 "mention" 或 "all"，收到："${rawTriggerMode}"`
    );
  }
  const triggerMode: TriggerMode = rawTriggerMode;

  // ALLOWED_CHANNEL_IDS 為逗號分隔字串，空字串或未設定 → 空集合（全部允許）
  const rawChannelIds = process.env.ALLOWED_CHANNEL_IDS ?? "";
  const allowedChannelIds = new Set(
    rawChannelIds
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

  const claudeCwd = process.env.CLAUDE_CWD || process.env.HOME || "/";

  const claudeCommand = process.env.CLAUDE_COMMAND || "claude";

  // NOTE: DEBOUNCE_MS 需轉 int，非數字時 fallback 500
  const rawDebounce = parseInt(process.env.DEBOUNCE_MS ?? "500", 10);
  const debounceMs = isNaN(rawDebounce) ? 500 : rawDebounce;

  // NOTE: TURN_TIMEOUT_MS 需轉 int，非數字時 fallback 300000（5 分鐘）
  const rawTimeout = parseInt(process.env.TURN_TIMEOUT_MS ?? "300000", 10);
  const turnTimeoutMs = isNaN(rawTimeout) ? 300_000 : rawTimeout;

  return {
    discordToken,
    triggerMode,
    allowedChannelIds,
    claudeCwd,
    claudeCommand,
    debounceMs,
    turnTimeoutMs,
  };
}

/** 全域設定單例，啟動時載入一次 */
export const config: BridgeConfig = loadConfig();
