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

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** ACP event 類型聯集 */
export type AcpEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; title: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "status"; raw: unknown }
  | { type: "session_init"; sessionId: string };

// ── 型別守衛（解析 claude stream-json 用） ───────────────────────────────────

/** claude stream-json 的 content block 型別 */
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
}

/** claude stream-json 的 assistant message 型別 */
interface AssistantMessage {
  id: string;
  content: ContentBlock[];
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 執行一輪 Claude 對話，以 AsyncGenerator 串流 AcpEvent
 *
 * @param sessionId 上次對話的 session ID（首次為 null）
 * @param text 使用者輸入文字
 * @param cwd Claude session 工作目錄（spawn cwd）
 * @param claudeCmd claude binary 路徑
 * @param signal AbortSignal，用於取消進行中的 turn
 * @yields AcpEvent（session_init / text_delta / tool_call / done / error / status）
 */
export async function* runClaudeTurn(
  sessionId: string | null,
  text: string,
  cwd: string,
  claudeCmd: string,
  signal?: AbortSignal
): AsyncGenerator<AcpEvent> {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  // 有上次 session → --resume 延續對話上下文
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // prompt 作為 positional argument
  args.push(text);

  console.log(`[DEBUG:acp] spawn: ${claudeCmd} ${args.join(" ")}`);

  // NOTE: stdin 設 "ignore"，prompt 已透過 positional argument 傳入，不需要 stdin
  const proc = spawn(claudeCmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  console.log(`[DEBUG:acp] process spawned, pid=${proc.pid}`);

  // 處理 AbortSignal：SIGTERM → 250ms → SIGKILL
  const abortHandler = () => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
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
  let lastToolCount = 0;

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    const raw = chunk.toString();
    console.log(`[DEBUG:acp] stdout chunk (${raw.length} bytes): ${raw.slice(0, 200)}`);
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
          lastToolCount = 0;
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

  proc.stderr.on("data", (chunk: Buffer) => {
    console.log(`[DEBUG:acp] stderr: ${chunk.toString().slice(0, 200)}`);
  });

  proc.on("close", (code) => {
    console.log(`[DEBUG:acp] process closed, code=${code}`);
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

    // 非正常退出（且非使用者取消）→ 補 error event
    if (code !== 0 && !signal?.aborted) {
      push({ type: "error", message: `claude 異常退出（exit ${code}）` });
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
