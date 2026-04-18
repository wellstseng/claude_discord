/**
 * @file cli-bridge/process.ts
 * @description CliProcess — 持久 Claude CLI child process 封裝
 *
 * 封裝一個長期存活的 `claude -p --input-format stream-json --output-format stream-json` process。
 * stdin 送 NDJSON，stdout 解析為 CliBridgeEvent 透過 EventEmitter 發出。
 *
 * 與 acp.ts 的差異：
 * - acp.ts：one-shot spawn，prompt 作為 positional arg，AsyncGenerator 消費
 * - CliProcess：持久 process，訊息透過 stdin 送，EventEmitter 持續監聽
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { CliProcessConfig, StreamJsonMessage, CliBridgeEvent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── stdout 解析輔助型別 ────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
}

interface AssistantMessage {
  id: string;
  content: ContentBlock[];
}

// ── CliProcess ──────────────────────────────────────────────────────────────────

export interface CliProcessEvents {
  event: [CliBridgeEvent];
  close: [code: number | null];
  error: [err: Error];
  /** 原始 stdout 行（debug / logging 用） */
  raw: [line: string];
}

export class CliProcess extends EventEmitter<CliProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";

  // 串流 diff 追蹤（同 acp.ts 邏輯）
  private lastMessageId = "";
  private lastTextLength = 0;
  private lastThinkingLength = 0;
  private lastToolCount = 0;

  /** 最近一次 stderr 輸出（供 bridge 偵測啟動失敗原因） */
  lastStderr = "";

  constructor(private config: CliProcessConfig) {
    super();
  }

  // ── 啟動 ──────────────────────────────────────────────────────────────────

  async spawn(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      throw new Error(`[cli-bridge:${this.config.label}] process 已在執行中`);
    }

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    ];

    // 互斥分支：dangerouslySkipPermissions 與 --permission-prompt-tool 不可共存
    // - true：信任模式，沿用舊行為直接放行
    // - false（預設）：走 MCP request_permission tool → Discord 按鈕審批
    if (this.config.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
      log.warn(`[cli-bridge:${this.config.label}] dangerouslySkipPermissions=true（fail-open，所有 tool 直接放行）`);
    } else {
      args.push("--permission-prompt-tool", "mcp__catclaw-bridge-discord__request_permission");
    }

    if (this.config.sessionId) {
      // --resume 前先驗證 .jsonl 是否還在 ~/.claude/projects/*/；
      // 若不在，跳過 --resume 讓 CLI 開新 session（避免 "No conversation found" 死循環）
      if (this.sessionJsonlExists(this.config.sessionId)) {
        args.push("--resume", this.config.sessionId);
      } else {
        log.warn(`[cli-bridge:${this.config.label}] session ${this.config.sessionId} 的 .jsonl 不存在，跳過 --resume 改用新 session`);
        this.config.sessionId = undefined;
      }
    }

    // 寫入 per-bridge MCP config：catclaw-bridge-discord 用 bridge 自己的 bot token
    const mcpConfigPath = this.writeMcpConfig();
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    const label = this.config.label;
    log.info(`[cli-bridge:${label}] spawn: ${this.config.claudeBin} ${args.join(" ")}`);

    // 注入 bridge runtime env（讓 CLI 內可以 echo $CATCLAW_BRIDGE_* 查證部署資訊）
    const bridgeEnv: Record<string, string> = { ...process.env as Record<string, string> };
    bridgeEnv.CATCLAW_BRIDGE_LABEL = this.config.label;
    if (this.config.channelId) {
      bridgeEnv.CATCLAW_BRIDGE_CHANNEL_ID = this.config.channelId;
      // request_permission 用：MCP server 啟動 Discord Gateway 後要 fetch 哪個頻道發按鈕
      bridgeEnv.DISCORD_CHANNEL_ID = this.config.channelId;
    }
    if (this.config.sessionId) bridgeEnv.CATCLAW_BRIDGE_SESSION_ID = this.config.sessionId;

    this.proc = spawn(this.config.claudeBin, args, {
      cwd: this.config.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: bridgeEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    log.info(`[cli-bridge:${label}] process spawned, pid=${this.proc.pid}`);

    // 重置 diff 追蹤
    this.resetDiffState();

    // ── stdout 監聽 ──
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    // ── stderr 監聽 ──
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        log.debug(`[cli-bridge:${label}] stderr: ${text.slice(0, 200)}`);
        this.lastStderr = text;
      }
    });

    // ── process 結束 ──
    this.proc.on("close", (code) => {
      log.info(`[cli-bridge:${label}] process closed, code=${code}`);
      // 沖出 buffer 殘留
      this.flushBuffer();
      this.proc = null;
      this.emit("close", code);
    });

    this.proc.on("error", (err) => {
      log.error(`[cli-bridge:${label}] process error: ${err.message}`);
      this.emit("error", err);
    });

    // 等待 process 實際啟動（等第一個 stdout 或短暫 delay）
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (!this.alive) {
      throw new Error(`[cli-bridge:${label}] process 啟動失敗`);
    }
  }

  // ── session .jsonl 檢查 ──────────────────────────────────────────────────

  /**
   * 檢查 Claude CLI 的 session .jsonl 是否還存在。
   * Claude CLI 將 session 存在 `~/.claude/projects/<slug>/<sid>.jsonl`，
   * slug 會因 Claude 版本不同而略有差異，直接掃描所有 project 子目錄最穩。
   */
  private sessionJsonlExists(sid: string): boolean {
    try {
      const projectsDir = join(homedir(), ".claude", "projects");
      if (!existsSync(projectsDir)) return false;
      const target = `${sid}.jsonl`;
      for (const sub of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        if (existsSync(join(projectsDir, sub.name, target))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── MCP config 寫入 ──────────────────────────────────────────────────────

  /**
   * 寫入 per-bridge MCP config 檔，供 `claude --mcp-config` 載入。
   * 讓 CLI 內可以用 `mcp__catclaw-bridge-discord__*` 工具操作 Discord，
   * 且走 bridge 自己的 bot token（不會撞官方 plugin 的跨 bot 權限問題）。
   *
   * 路徑：`$CATCLAW_CONFIG_DIR/runtime/bridges/{label}.mcp.json`（不污染 workingDir）
   * 沒 botToken 或 channelId → 跳過，不載入 MCP。
   */
  private writeMcpConfig(): string | null {
    const label = this.config.label;
    if (!this.config.botToken || !this.config.channelId) {
      log.debug(`[cli-bridge:${label}] 無 botToken/channelId，跳過 MCP 注入`);
      return null;
    }

    const catclawDir = process.env.CATCLAW_CONFIG_DIR;
    if (!catclawDir) {
      log.warn(`[cli-bridge:${label}] CATCLAW_CONFIG_DIR 未設定，跳過 MCP 注入`);
      return null;
    }

    try {
      const runtimeDir = join(catclawDir, "runtime", "bridges");
      mkdirSync(runtimeDir, { recursive: true });

      // discord-server.js 相對於 dist/cli-bridge/ 位置
      const serverPath = resolvePath(__dirname, "..", "mcp", "discord-server.js");

      const mcpConfig = {
        mcpServers: {
          "catclaw-bridge-discord": {
            command: "node",
            args: [serverPath],
            env: {
              DISCORD_TOKEN: this.config.botToken,
              // request_permission tool 需要知道要在哪個頻道發審批按鈕
              DISCORD_CHANNEL_ID: this.config.channelId,
              CATCLAW_BRIDGE_LABEL: this.config.label,
            },
          },
        },
      };

      const mcpConfigPath = join(runtimeDir, `${label}.mcp.json`);
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      log.debug(`[cli-bridge:${label}] MCP config 已寫入 ${mcpConfigPath}`);
      return mcpConfigPath;
    } catch (err) {
      log.warn(`[cli-bridge:${label}] 寫入 MCP config 失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ── stdin 送訊息 ──────────────────────────────────────────────────────────

  send(msg: StreamJsonMessage): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error(`[cli-bridge:${this.config.label}] stdin 不可寫入（process 未啟動或已關閉）`);
    }
    const line = JSON.stringify(msg) + "\n";
    this.proc.stdin.write(line);
    log.debug(`[cli-bridge:${this.config.label}] stdin: ${line.trim().slice(0, 100)}`);
  }

  // ── 優雅關閉 ──────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    const label = this.config.label;
    if (!this.proc || this.proc.killed) {
      log.debug(`[cli-bridge:${label}] shutdown: process 已不在`);
      return;
    }

    log.info(`[cli-bridge:${label}] shutdown: 關閉 stdin`);

    // Step 1: 關閉 stdin（EOF → CLI 優雅結束）
    this.proc.stdin?.end();

    // Step 2: 等待 process 結束（最多 5s）
    const closed = await this.waitForClose(5000);
    if (closed) return;

    // Step 3: SIGTERM
    log.info(`[cli-bridge:${label}] shutdown: SIGTERM`);
    this.killProcess("SIGTERM");

    const terminated = await this.waitForClose(3000);
    if (terminated) return;

    // Step 4: SIGKILL
    log.warn(`[cli-bridge:${label}] shutdown: SIGKILL`);
    this.killProcess("SIGKILL");
    await this.waitForClose(2000);
  }

  // ── 中斷當前 turn ────────────────────────────────────────────────────────

  sendInterrupt(): void {
    if (!this.proc || this.proc.killed) return;
    log.info(`[cli-bridge:${this.config.label}] sending SIGINT`);
    this.killProcess("SIGINT");
  }

  // ── 健康檢查 ──────────────────────────────────────────────────────────────

  ping(): boolean {
    if (!this.alive) return false;
    try {
      this.send({ type: "keep_alive" });
      return true;
    } catch {
      return false;
    }
  }

  // ── 狀態查詢 ──────────────────────────────────────────────────────────────

  get alive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  // ── stdout 解析（沿用 acp.ts diff 邏輯）─────────────────────────────────

  private handleStdoutChunk(chunk: Buffer): void {
    const raw = chunk.toString();
    this.buffer += raw;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      this.emit("raw", trimmed);

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // 非 JSON 行（debug log）
      }

      const event = this.parseStdoutEvent(obj);
      if (event) {
        this.emit("event", event);
      }
    }
  }

  private parseStdoutEvent(obj: Record<string, unknown>): CliBridgeEvent | null {
    const type = obj["type"] as string | undefined;

    // ── system/init：取得 session_id ──
    if (type === "system" && obj["subtype"] === "init") {
      const sid = obj["session_id"] as string | undefined;
      if (sid) {
        return { type: "session_init", sessionId: sid };
      }
      return null;
    }

    // ── assistant：串流文字 + 工具呼叫（diff 模式）──
    if (type === "assistant") {
      return this.parseAssistantEvent(obj);
    }

    // ── result：turn 結束 ──
    if (type === "result") {
      const isError = !!obj["is_error"];
      const sessionId = obj["session_id"] as string | undefined;
      const resultText = typeof obj["result"] === "string" ? obj["result"] as string : undefined;
      return { type: "result", is_error: isError, text: resultText, session_id: sessionId };
    }

    // ── tool_use_summary：工具結果摘要 ──
    if (type === "tool_use_summary") {
      const name = (obj["tool_name"] ?? obj["name"] ?? "unknown") as string;
      return { type: "tool_result", title: name };
    }

    // ── control_request：權限請求 ──
    if (type === "control_request") {
      return {
        type: "control_request",
        requestId: obj["id"] as string ?? "",
        tool: obj["tool"] as string ?? "",
        description: obj["description"] as string ?? "",
      };
    }

    // 其他事件靜默記錄
    if (type) {
      return { type: "status", subtype: type, raw: obj };
    }

    return null;
  }

  private parseAssistantEvent(obj: Record<string, unknown>): CliBridgeEvent | null {
    // Subagent（Task tool 內部）的 assistant 訊息不轉發到 Discord —
    // 主 agent 已透過 Task tool_call 告知有 subagent 在跑，subagent 內部敘述屬於實作細節。
    if (obj["parent_tool_use_id"]) return null;

    const msg = obj["message"] as AssistantMessage | undefined;
    if (!msg?.content) return null;

    // 新 message（不同 turn）→ 重置 diff 追蹤
    if (msg.id !== this.lastMessageId) {
      this.lastMessageId = msg.id;
      this.lastTextLength = 0;
      this.lastThinkingLength = 0;
      this.lastToolCount = 0;
    }

    // thinking diff
    const fullThinking = msg.content
      .filter(b => b.type === "thinking")
      .map(b => b.thinking ?? "")
      .join("");

    if (fullThinking.length > this.lastThinkingLength) {
      const delta = fullThinking.slice(this.lastThinkingLength);
      this.lastThinkingLength = fullThinking.length;
      // 先 emit thinking，再繼續檢查 text
      this.emit("event", { type: "thinking_delta", text: delta });
    }

    // text diff
    const fullText = msg.content
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");

    if (fullText.length > this.lastTextLength) {
      const delta = fullText.slice(this.lastTextLength);
      this.lastTextLength = fullText.length;
      return { type: "text_delta", text: delta };
    }

    // tool_use blocks
    const toolBlocks = msg.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length > this.lastToolCount) {
      for (let i = this.lastToolCount; i < toolBlocks.length; i++) {
        this.emit("event", { type: "tool_call", title: toolBlocks[i]!.name ?? "unknown" });
      }
      this.lastToolCount = toolBlocks.length;
    }

    return null;
  }

  private flushBuffer(): void {
    if (!this.buffer.trim()) return;
    try {
      const obj = JSON.parse(this.buffer.trim()) as Record<string, unknown>;
      const event = this.parseStdoutEvent(obj);
      if (event) {
        this.emit("event", event);
      }
    } catch {
      // 非 JSON，忽略
    }
    this.buffer = "";
  }

  private resetDiffState(): void {
    this.lastMessageId = "";
    this.lastTextLength = 0;
    this.lastThinkingLength = 0;
    this.lastToolCount = 0;
    this.buffer = "";
  }

  // ── 內部輔助 ──────────────────────────────────────────────────────────────

  private killProcess(sig: NodeJS.Signals): void {
    if (!this.proc?.pid) return;
    try {
      // detached 模式下殺 process group
      if (process.platform !== "win32") {
        process.kill(-this.proc.pid, sig);
      } else {
        this.proc.kill(sig);
      }
    } catch {
      try { this.proc.kill(sig); } catch { /* 靜默 */ }
    }
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("close", onClose);
    });
  }
}
