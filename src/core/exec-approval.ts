/**
 * @file core/exec-approval.ts
 * @description 執行指令 DM 確認機制
 *
 * 流程：
 *   agent-loop 偵測到 run_command → createApproval() 建立 pending
 *   → 呼叫端送 DM（含 approvalId + 指令內容）
 *   → 使用者回覆 ✅ <id> 或 ❌ <id>
 *   → discord.ts 呼叫 resolveApproval()
 *   → createApproval() 的 Promise resolve(true/false)
 */

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface PendingApproval {
  approvalId: string;
  command: string;
  channelId: string;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── Store ────────────────────────────────────────────────────────────────────

const _pending = new Map<string, PendingApproval>();

/**
 * 建立一個等待確認的 pending entry，回傳 Promise<boolean>。
 *
 * @param command 要執行的指令（顯示給使用者看）
 * @param channelId 觸發此 turn 的頻道 ID
 * @param timeoutMs 超時毫秒（到時自動 resolve(false)）
 * @returns [approvalId, Promise<boolean>]
 */
export function createApproval(
  command: string,
  channelId: string,
  timeoutMs: number,
): [string, Promise<boolean>] {
  const approvalId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const promise = new Promise<boolean>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      _pending.delete(approvalId);
      resolve(false);
    }, timeoutMs);

    _pending.set(approvalId, { approvalId, command, channelId, resolve, timeoutHandle });
  });

  return [approvalId, promise];
}

/**
 * 解析使用者回覆，回傳是否找到對應 pending。
 *
 * @param approvalId 確認碼
 * @param approved true = 允許, false = 拒絕
 * @returns 找到並解析回傳 true，找不到回傳 false
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const entry = _pending.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  _pending.delete(approvalId);
  entry.resolve(approved);
  return true;
}

/**
 * 解析 DM 訊息文字，嘗試找出 ✅/❌ + approvalId 格式。
 * 支援：「✅ ABC123」「❌ ABC123」「✅ABC123」（不分大小寫）
 *
 * @returns { approved: boolean, approvalId: string } | null
 */
export function parseApprovalReply(text: string): { approved: boolean; approvalId: string } | null {
  const match = text.trim().match(/^([✅❌])\s*([A-Z0-9]{6})$/i);
  if (!match) return null;
  return {
    approved: match[1] === "✅",
    approvalId: match[2].toUpperCase(),
  };
}

/** 目前等待中的數量（debug 用） */
export function pendingCount(): number {
  return _pending.size;
}
