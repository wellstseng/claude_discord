/**
 * @file memory/session-memory.ts
 * @description 對話中自動抄筆記（參考 Claude Code SessionMemory）
 *
 * 觸發：每 intervalTurns 輪（預設 10）
 * 萃取：最近 maxHistoryTurns 輪 → Ollama haiku → 摘要筆記
 * 儲存：{memoryDir}/_session_notes/{channelId}.md（覆寫，保留最新）
 * 注入：turn 開始前讀取並前置到 system prompt
 */

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { log } from "../logger.js";
import type { Message } from "../providers/base.js";

export interface SessionMemoryOpts {
  enabled: boolean;
  intervalTurns: number;   // 每幾輪觸發一次萃取（預設 10）
  maxHistoryTurns: number; // 送給 LLM 的最近 N 輪（預設 15）
}

const SESSION_NOTES_DIR = "_session_notes";

const EXTRACT_SYSTEM = `你是對話筆記員。讀取以下對話，整理出下一個 session 最需要知道的重點。
輸出格式（繁體中文，簡潔）：
## 進行中
- （正在做什麼，還沒完成的事）
## 最近決策
- （做了什麼選擇或決定）
## 關鍵資訊
- （重要的數值、路徑、設定、名稱）
每個 section 最多 3 條，每條一行。無內容就省略整個 section。`;

function notePath(memoryDir: string, channelId: string): string {
  return join(memoryDir, SESSION_NOTES_DIR, `${channelId.slice(-8)}.md`);
}

/** 取得目前頻道的筆記內容（供 system prompt 注入） */
export function getSessionNote(memoryDir: string, channelId: string): string | null {
  const p = notePath(memoryDir, channelId);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** 每 intervalTurns 輪 fire-and-forget 萃取一次筆記 */
export async function checkAndSaveNote(
  channelId: string,
  turnCount: number,
  messages: Message[],
  memoryDir: string,
  opts: SessionMemoryOpts
): Promise<void> {
  if (!opts.enabled) return;
  if (turnCount === 0 || turnCount % opts.intervalTurns !== 0) return;

  // 取最近 maxHistoryTurns 輪（每輪 2 條：user + assistant）
  const recent = messages.slice(-(opts.maxHistoryTurns * 2));
  if (recent.length < 4) return;  // 太短，不值得萃取

  const dialogue = recent
    .filter(m => ["user", "assistant"].includes((m as {role:string}).role))
    .map(m => {
      const r = (m as {role:string; content:unknown}).role;
      const c = typeof (m as {content:unknown}).content === "string"
        ? ((m as {content:string}).content).slice(0, 500)
        : "[tool result]";
      return `${r === "user" ? "使用者" : "助手"}：${c}`;
    })
    .join("\n");

  try {
    const { getOllamaClient } = await import("../ollama/client.js");
    const client = getOllamaClient();
    const note = await client.chat(
      [{ role: "user", content: dialogue }],
      { system: EXTRACT_SYSTEM, timeout: 15_000 }
    );
    if (!note.trim()) return;

    const p = notePath(memoryDir, channelId);
    mkdirSync(dirname(p), { recursive: true });
    const header = `# 對話筆記（${new Date().toISOString().slice(0, 16).replace("T", " ")}）\n\n`;
    writeFileSync(p, header + note.trim(), "utf-8");
    log.info(`[session-memory] 筆記已更新 channel=${channelId.slice(-8)} turns=${turnCount}`);
  } catch (err) {
    log.debug(`[session-memory] 萃取失敗（靜默）：${err instanceof Error ? err.message : String(err)}`);
  }
}
