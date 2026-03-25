/**
 * @file acp.ts
 * @description Claude CLI 串流對話實作
 *
 * 直接 spawn `claude -p --output-format stream-json` 進行對話，
 * 以 AsyncGenerator 串流 AcpEvent 給上層消費。
 *
 * 與原始 acpx 設計的差異：
 * - 無需 `sessions ensure`，session 由 claude CLI 內建管理
 * - 首次對話不帶 --resume，從 system/init event 取得 session_id
 * - 後續對話帶 --resume <session_id> 延續上下文
 * - 使用 --include-partial-messages 實現串流（累積文字 diff 為 delta）
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import { resolveWorkspaceDir, resolveClaudeBin } from "./config.js";
import { buildSkillsPrompt } from "./skills/registry.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** ACP event 類型聯集 */
export type AcpEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; title: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "status"; raw: unknown }
  | { type: "session_init"; sessionId: string }
  | { type: "timeout_warning"; elapsedSec: number };

// ── 型別守衛（解析 claude stream-json 用） ───────────────────────────────────

/** claude stream-json 的 content block 型別 */
interface ContentBlock {
  type: string;
  text?: string;
  /** thinking block 的推理文字 */
  thinking?: string;
  name?: string;
  id?: string;
}

/** claude stream-json 的 assistant message 型別 */
interface AssistantMessage {
  id: string;
  content: ContentBlock[];
}

// ── 錯誤分類 ────────────────────────────────────────────────────────────────

/**
 * 從 stderr 和 exit code 推測錯誤原因，產生使用者可讀的訊息
 *
 * @param stderr stderr 輸出尾段
 * @param code process exit code
 * @returns 錯誤描述
 */
function classifyError(stderr: string, code: number | null): string {
  const lower = stderr.toLowerCase();

  if (lower.includes("overloaded") || lower.includes("529"))
    return "Claude API 過載（overloaded），請稍後再試";
  if (lower.includes("rate") && lower.includes("limit"))
    return "Claude API 速率限制（rate limit），請稍後再試";
  if (lower.includes("502") || lower.includes("bad gateway"))
    return "Claude API 連線失敗（502 Bad Gateway）";
  if (lower.includes("503") || lower.includes("service unavailable"))
    return "Claude API 暫時無法使用（503）";
  if (lower.includes("timeout") || lower.includes("etimedout"))
    return "Claude API 連線逾時";
  if (lower.includes("econnreset") || lower.includes("econnrefused"))
    return "Claude API 連線中斷";
  if (lower.includes("authentication") || lower.includes("401") || lower.includes("unauthorized"))
    return "Claude API 認證失敗";

  return `claude 異常退出（exit ${code}）${stderr ? `：${stderr.slice(-100)}` : ""}`;
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 執行一輪 Claude 對話，以 AsyncGenerator 串流 AcpEvent
 *
 * cwd 和 claudeCmd 從環境變數取得，不再由呼叫方傳入。
 *
 * @param sessionId 上次對話的 session ID（首次為 null）
 * @param text 使用者輸入文字
 * @param channelId Discord channel ID（傳給 Claude CLI 做為環境變數，用於重啟回報）
 * @param signal AbortSignal，用於取消進行中的 turn
 * @yields AcpEvent（session_init / text_delta / tool_call / done / error / status）
 */
export async function* runClaudeTurn(
  sessionId: string | null,
  text: string,
  channelId: string,
  signal?: AbortSignal
): AsyncGenerator<AcpEvent> {
  // cwd 和 binary 路徑統一從環境變數取得，不依賴 config.json
  const cwd = resolveWorkspaceDir();
  const claudeCmd = resolveClaudeBin();

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  // ── System Prompt（AGENTS.md）──────────────────────────────────────────────
  // 從 workspace 根目錄讀取 AGENTS.md 作為 system prompt
  // 檔案不存在時跳過，不強制（讓 Claude 用預設行為）
  const agentsPath = join(cwd, "AGENTS.md");
  let systemPrompt = "";
  if (existsSync(agentsPath)) {
    try {
      systemPrompt = readFileSync(agentsPath, "utf-8");
      log.debug(`[acp] 載入 AGENTS.md: ${agentsPath} (${systemPrompt.length} 字)`);
    } catch (err) {
      log.warn(`[acp] 讀取 AGENTS.md 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 注入 Prompt-type Skill 系統提示
  const skillsPrompt = buildSkillsPrompt();
  if (skillsPrompt) {
    systemPrompt += skillsPrompt;
    log.debug(`[acp] 注入 skills prompt (+${skillsPrompt.length} 字)`);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  // 有上次 session → --resume 延續對話上下文
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // prompt 作為 positional argument
  args.push(text);

  log.debug(`[acp] spawn: ${claudeCmd} ${args.join(" ")}`);

  // NOTE: stdin 設 "ignore"，prompt 已透過 positional argument 傳入，不需要 stdin
  // 傳遞 CATCLAW_CHANNEL_ID 讓 Claude CLI 知道當前頻道，用於重啟回報
  const proc = spawn(claudeCmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CATCLAW_CHANNEL_ID: channelId },
    windowsHide: true,
    // Windows: detached 會觸發 CREATE_NEW_CONSOLE，與 windowsHide 衝突造成閃視窗，不使用
    // Unix: detached=true 讓 process.kill(-pid) 可殺整個 process group
    detached: process.platform !== "win32",
  });
  // detached 但不 unref()，確保父程序仍追蹤子程序生命週期

  log.debug(`[acp] process spawned, pid=${proc.pid}`);

  // 處理 AbortSignal：SIGTERM → 250ms → SIGKILL
  // detached 模式下用 process.kill(-pid) 殺整個 process group
  const killProc = (sig: NodeJS.Signals) => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      proc.kill(sig);  // fallback: 直接殺
    }
  };
  const abortHandler = () => {
    killProc("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) killProc("SIGKILL");
    }, 250);
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  // 用 queue 把 stdout 的非同步事件轉成可 yield 的序列
  const eventQueue: Array<AcpEvent | null> = []; // null = 結束信號
  let resolveNext: (() => void) | null = null;

  const push = (event: AcpEvent | null) => {
    eventQueue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  // ── 串流 diff 狀態 ──
  // claude --include-partial-messages 輸出的 assistant 事件是累積文字，非 delta
  // 需要 diff 前後文字長度，提取新增部分作為 text_delta
  let lastMessageId = "";
  let lastTextLength = 0;
  let lastThinkingLength = 0;
  let lastToolCount = 0;

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    const raw = chunk.toString();
    if (process.env.ACP_TRACE) log.debug(`[acp] stdout chunk (${raw.length} bytes): ${raw.slice(0, 200)}`);
    buffer += raw;
    const lines = buffer.split("\n");
    // 最後一個可能是不完整行，保留在 buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // 非 JSON 行（例如 debug log）直接略過
        continue;
      }

      const type = obj["type"] as string | undefined;

      // ── system/init：取得 session_id ──
      if (type === "system" && obj["subtype"] === "init") {
        const sid = obj["session_id"] as string | undefined;
        if (sid) {
          push({ type: "session_init", sessionId: sid });
        }
        continue;
      }

      // ── assistant：串流文字 + 工具呼叫 ──
      if (type === "assistant") {
        const msg = obj["message"] as AssistantMessage | undefined;
        if (!msg?.content) continue;

        // 新 message（不同 turn）→ 重置 diff 追蹤
        if (msg.id !== lastMessageId) {
          lastMessageId = msg.id;
          lastTextLength = 0;
          lastThinkingLength = 0;
          lastToolCount = 0;
        }

        // 提取 thinking block（推理過程），用 diff 只 yield 新增部分
        const fullThinking = msg.content
          .filter((b) => b.type === "thinking")
          .map((b) => b.thinking ?? "")
          .join("");

        if (fullThinking.length > lastThinkingLength) {
          push({
            type: "thinking_delta",
            text: fullThinking.slice(lastThinkingLength),
          });
          lastThinkingLength = fullThinking.length;
        }

        // 提取所有 text block 合成完整文字
        const fullText = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");

        // diff：只 yield 新增的部分
        if (fullText.length > lastTextLength) {
          push({
            type: "text_delta",
            text: fullText.slice(lastTextLength),
          });
          lastTextLength = fullText.length;
        }

        // 檢查新的 tool_use block
        const toolBlocks = msg.content.filter(
          (b) => b.type === "tool_use"
        );
        if (toolBlocks.length > lastToolCount) {
          for (let i = lastToolCount; i < toolBlocks.length; i++) {
            push({
              type: "tool_call",
              title: toolBlocks[i].name ?? "unknown tool",
            });
          }
          lastToolCount = toolBlocks.length;
        }

        continue;
      }

      // ── result：turn 結束 ──
      if (type === "result") {
        if (obj["is_error"]) {
          push({
            type: "error",
            message: (obj["result"] as string) ?? "Claude CLI 回傳錯誤",
          });
        }
        push({ type: "done" });
        continue;
      }

      // 其他 event（hook_started, hook_response, rate_limit_event 等）靜默忽略
    }
  });

  // 收集 stderr 用於錯誤診斷（只保留最後 500 字元）
  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (process.env.ACP_TRACE) log.debug(`[acp] stderr: ${text.slice(0, 200)}`);
    stderrTail = (stderrTail + text).slice(-500);
  });

  proc.on("close", (code) => {
    log.debug(`[acp] process closed, code=${code}`);
    // 沖出 buffer 殘留的最後一行
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim()) as Record<string, unknown>;
        if (obj["type"] === "result") {
          if (obj["is_error"]) {
            push({
              type: "error",
              message: (obj["result"] as string) ?? "Claude CLI 回傳錯誤",
            });
          }
          push({ type: "done" });
        }
      } catch {
        // 非 JSON，忽略
      }
    }

    if (signal?.aborted) {
      // Abort（timeout）→ 補 error event 讓上層清理 typing indicator
      push({ type: "error", message: "回應逾時，已取消" });
    } else if (code !== 0) {
      // 從 stderr 嘗試分類錯誤原因
      const hint = classifyError(stderrTail, code);
      push({ type: "error", message: hint });
    }

    push(null); // 結束信號
    signal?.removeEventListener("abort", abortHandler);
  });

  proc.on("error", (err) => {
    push({ type: "error", message: `無法啟動 claude：${err.message}` });
    push(null);
    signal?.removeEventListener("abort", abortHandler);
  });

  // Generator 主迴圈：等待 eventQueue 有資料再 yield
  while (true) {
    if (eventQueue.length === 0) {
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }

    const event = eventQueue.shift();
    if (event === null) break;
    if (event === undefined) continue;

    yield event;

    if (event.type === "done") break;
  }
}
