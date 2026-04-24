/**
 * @file cli-bridge/providers/codex.ts
 * @description CodexProvider — OpenAI Codex CLI（v0.124+）的 cli-bridge provider 實作。
 *
 * Codex 用 `codex app-server` 啟動 stdio JSON-RPC 2.0 server。協議與 Claude
 * 的 NDJSON 單向 stream 完全不同：
 * - 雙向：client→server (request/notify) + server→client (request/notify)
 * - 需要 initialize handshake：先送 initialize → 等 response → 送 initialized notify
 * - Thread = Claude 的 session，由 thread/start request 產生 id
 * - User message 透過 turn/start RPC（不是 stdin NDJSON）
 * - Agent text 串流走 item/agentMessage/delta notification
 * - Approval requests 由 server-request 主動發來（execCommandApproval 等）
 *
 * Phase 2：approval 第一版用 generic auto-approve（信任模式）；Phase 3 改接 Discord 按鈕。
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, lstatSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { log } from "../../logger.js";
import type { CliBridgeEvent, CliProcessConfig, StdinImageBlock } from "../types.js";
import type { CliProvider, ProcessIO, ProviderContext, ProviderSpawnSpec } from "./provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── JSON-RPC 2.0 client ──────────────────────────────────────────────────────

type ServerRequestHandler = (id: number | string, method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

class CodexJsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
  private notifyHandler: NotificationHandler = () => {};
  private serverReqHandler: ServerRequestHandler = async () => ({});

  constructor(private io: ProcessIO, private label: string) {}

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.io.writeStdinLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.io.writeStdinLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** 由 CodexProvider.parseStdoutLine 餵入每行 stdout JSON。 */
  handleIncoming(obj: Record<string, unknown>): void {
    const id = obj["id"] as number | string | undefined;
    const method = obj["method"] as string | undefined;

    if (id != null && (obj["result"] !== undefined || obj["error"] !== undefined)) {
      // Response 給我們發過去的 request
      const numId = typeof id === "number" ? id : Number(id);
      const p = this.pending.get(numId);
      if (p) {
        this.pending.delete(numId);
        if (obj["error"] !== undefined) p.reject(obj["error"]);
        else p.resolve(obj["result"]);
      }
      return;
    }

    if (method && id != null) {
      // Server request — 我們要回 response
      void (async () => {
        try {
          const result = await this.serverReqHandler(id, method, obj["params"]);
          this.io.writeStdinLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (err) {
          this.io.writeStdinLine(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          }));
        }
      })();
      return;
    }

    if (method) {
      // Server notification
      this.notifyHandler(method, obj["params"]);
      return;
    }

    // 不認得的訊息（debug log）
    log.debug(`[cli-bridge:${this.label}] codex 未知訊息: ${JSON.stringify(obj).slice(0, 200)}`);
  }

  onNotification(handler: NotificationHandler): void {
    this.notifyHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverReqHandler = handler;
  }

  /** 拒絕所有 pending（用於 process 死亡 / restart） */
  rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      try { p.reject(new Error(reason)); } catch { /* 靜默 */ }
    }
    this.pending.clear();
  }
}

// ── CodexProvider ────────────────────────────────────────────────────────────

export class CodexProvider implements CliProvider {
  readonly name = "codex";

  private rpc: CodexJsonRpcClient | null = null;
  private threadId: string | null = null;
  private label = "";
  private savedSessionId: string | undefined;
  private currentTurnImageTmpFiles: string[] = [];

  // ── 啟動 ──────────────────────────────────────────────────────────────────

  buildSpawn(config: CliProcessConfig): ProviderSpawnSpec {
    this.label = config.label;
    this.savedSessionId = config.sessionId;

    // 寫 per-bridge CODEX_HOME（含 config.toml + symlinks），讓 catclaw-bridge-discord MCP 可用
    const codexHome = this.writeCodexHome(config);

    const env: Record<string, string> = {
      CATCLAW_BRIDGE_LABEL: config.label,
    };
    if (codexHome) env.CODEX_HOME = codexHome;
    if (config.channelId) {
      env.CATCLAW_BRIDGE_CHANNEL_ID = config.channelId;
      env.DISCORD_CHANNEL_ID = config.channelId;
    }
    if (config.sessionId && this.isSessionResumable(config.sessionId)) {
      env.CATCLAW_BRIDGE_SESSION_ID = config.sessionId;
    }

    return { args: ["app-server"], env };
  }

  async postSpawn(io: ProcessIO, ctx: ProviderContext): Promise<void> {
    this.rpc = new CodexJsonRpcClient(io, this.label);
    this.rpc.onNotification((method, params) => this.handleNotification(method, params, ctx));
    this.rpc.onServerRequest((id, method, params) => this.handleServerRequest(id, method, params));

    // 1. initialize handshake
    await this.rpc.request("initialize", {
      clientInfo: { name: "catclaw-bridge", version: "1.0.0" },
      protocolVersion: "1.0",
    });
    this.rpc.notify("initialized");
    log.info(`[cli-bridge:${this.label}] codex initialize 完成`);

    // 2. resume 或開新 thread
    if (this.savedSessionId && this.isSessionResumable(this.savedSessionId)) {
      try {
        const result = await this.rpc.request<{ thread?: { id: string } }>("thread/resume", {
          threadId: this.savedSessionId,
        });
        this.threadId = result?.thread?.id ?? this.savedSessionId;
        log.info(`[cli-bridge:${this.label}] codex thread resumed: ${this.threadId}`);
      } catch (err) {
        log.warn(`[cli-bridge:${this.label}] codex thread/resume 失敗，開新 thread: ${err instanceof Error ? err.message : String(err)}`);
        const result = await this.rpc.request<{ thread: { id: string } }>("thread/start", {});
        this.threadId = result.thread.id;
      }
    } else {
      const result = await this.rpc.request<{ thread: { id: string } }>("thread/start", {});
      this.threadId = result.thread.id;
      log.info(`[cli-bridge:${this.label}] codex thread started: ${this.threadId}`);
    }

    if (this.threadId) {
      ctx.emit({ type: "session_init", sessionId: this.threadId });
    }
  }

  // ── CODEX_HOME 寫入（per-bridge 隔離 + MCP 注入）─────────────────────────

  /**
   * 建立 per-bridge codex home，並寫 config.toml 內含 catclaw-bridge-discord MCP server。
   * 結構：
   *   $CATCLAW_CONFIG_DIR/runtime/bridges/<label>.codex/
   *     ├── auth.json (symlink → ~/.codex/auth.json)
   *     ├── sessions  (symlink → ~/.codex/sessions)
   *     └── config.toml (含 mcp_servers.catclaw_bridge_discord)
   *
   * 沒有 botToken 或 channelId → 不注入 MCP，但仍建立 home（讓 codex 不會用全域 config）
   */
  private writeCodexHome(config: CliProcessConfig): string | null {
    const label = config.label;
    const catclawDir = process.env.CATCLAW_CONFIG_DIR;
    if (!catclawDir) {
      log.warn(`[cli-bridge:${label}] CATCLAW_CONFIG_DIR 未設定，codex 走全域 ~/.codex（不注入 MCP）`);
      return null;
    }

    const homeDir = join(catclawDir, "runtime", "bridges", `${label}.codex`);
    try {
      mkdirSync(homeDir, { recursive: true });

      // Symlink auth.json + sessions（保留全域 codex login + thread .jsonl）
      this.ensureSymlink(join(homedir(), ".codex", "auth.json"), join(homeDir, "auth.json"));
      this.ensureSymlink(join(homedir(), ".codex", "sessions"), join(homeDir, "sessions"));

      // 寫 config.toml
      const configToml = this.buildCodexConfigToml(config);
      writeFileSync(join(homeDir, "config.toml"), configToml, "utf-8");
      log.debug(`[cli-bridge:${label}] codex home 已寫入 ${homeDir}`);
      return homeDir;
    } catch (err) {
      log.warn(`[cli-bridge:${label}] writeCodexHome 失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private ensureSymlink(target: string, linkPath: string): void {
    if (!existsSync(target)) return;
    try {
      // 若 link 已存在且指向正確 → noop
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) return;
        unlinkSync(linkPath);
      }
      symlinkSync(target, linkPath);
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] symlink 失敗 ${linkPath} → ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildCodexConfigToml(config: CliProcessConfig): string {
    if (!config.botToken || !config.channelId) {
      // 沒 token / channel → 空 config（仍用獨立 home，但不裝 MCP）
      return "# catclaw bridge codex home (no MCP — missing botToken or channelId)\n";
    }

    // discord-server.js 相對於 dist/cli-bridge/providers/ 位置
    const serverPath = resolvePath(__dirname, "..", "..", "mcp", "discord-server.js");

    // 用 TOML basic string + escape 雙引號 / backslash（最保險）
    const escape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

    return `# catclaw bridge codex home — auto-generated, do not edit by hand
# label: ${config.label}

[mcp_servers.catclaw_bridge_discord]
command = "node"
args = ["${escape(serverPath)}"]

[mcp_servers.catclaw_bridge_discord.env]
DISCORD_TOKEN = "${escape(config.botToken)}"
DISCORD_CHANNEL_ID = "${escape(config.channelId)}"
CATCLAW_BRIDGE_LABEL = "${escape(config.label)}"
`;
  }

  // ── stdin encode ──────────────────────────────────────────────────────────

  sendUserMessage(io: ProcessIO, text: string, imageBlocks: StdinImageBlock[] | undefined, ctx: ProviderContext): void {
    if (!this.rpc || !this.threadId) {
      throw new Error(`[cli-bridge:${this.label}] codex provider not initialized (rpc/threadId missing)`);
    }

    // 清掉上一 turn 的暫存圖檔
    this.cleanupCurrentTurnImages();

    const input: Array<{ type: string; text?: string; path?: string }> = [{ type: "text", text }];
    if (imageBlocks && imageBlocks.length > 0) {
      for (const img of imageBlocks) {
        const tmpPath = this.writeBase64ImageToTmp(img);
        if (tmpPath) {
          input.push({ type: "localImage", path: tmpPath });
          this.currentTurnImageTmpFiles.push(tmpPath);
        }
      }
    }

    // Phase 2：信任模式（trust）
    // Phase 3 會改成 "on-request" + workspaceWrite 並接 Discord 按鈕審批
    void this.rpc.request("turn/start", {
      threadId: this.threadId,
      input,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    }).catch((err: unknown) => {
      const msg = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
      log.warn(`[cli-bridge:${this.label}] codex turn/start 失敗: ${msg}`);
      ctx.emit({ type: "error", message: `turn/start failed: ${msg}` });
    });
  }

  sendKeepAlive(_io: ProcessIO): boolean | null {
    // Codex app-server 不需要 keep-alive
    return null;
  }

  sendControlResponse(_io: ProcessIO, _requestId: string, _allowed: boolean): void {
    // Codex 沒有 stdin control_response 機制；server-request 由 handleServerRequest 直接走 RPC 回應
    // bridge.ts 不會走到這裡（codex 流程不會 emit type:"control_request"）
    log.debug(`[cli-bridge:${this.label}] codex sendControlResponse called but ignored (codex uses RPC server-request)`);
  }

  interrupt(_io: ProcessIO, _ctx: ProviderContext): void {
    if (!this.rpc || !this.threadId) {
      log.warn(`[cli-bridge:${this.label}] codex interrupt: rpc/threadId 未就緒，跳過`);
      return;
    }
    void this.rpc.request("turn/interrupt", { threadId: this.threadId }).catch((err: unknown) => {
      log.warn(`[cli-bridge:${this.label}] codex turn/interrupt 失敗: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ── stdout 解析 ────────────────────────────────────────────────────────────

  resetStreamState(): void {
    // Codex 的串流狀態都在 RPC client 內，process restart 時 rpc 會被重建
    if (this.rpc) {
      this.rpc.rejectAllPending("codex provider reset");
    }
    this.rpc = null;
    this.threadId = null;
    this.cleanupCurrentTurnImages();
  }

  parseStdoutLine(obj: Record<string, unknown>, _ctx: ProviderContext): void {
    if (!this.rpc) {
      log.warn(`[cli-bridge:${this.label}] codex parseStdoutLine: rpc 尚未建立，丟棄`);
      return;
    }
    this.rpc.handleIncoming(obj);
  }

  // ── 處理 codex notification（轉成 CliBridgeEvent）─────────────────────

  private handleNotification(method: string, params: unknown, ctx: ProviderContext): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "thread/started": {
        const threadId = (p["thread"] as { id?: string } | undefined)?.id;
        if (threadId) {
          this.threadId = threadId;
          ctx.emit({ type: "session_init", sessionId: threadId });
        }
        return;
      }

      case "item/agentMessage/delta": {
        const delta = p["delta"] as string | undefined;
        if (delta) ctx.emit({ type: "text_delta", text: delta });
        return;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = p["delta"] as string | undefined;
        if (delta) ctx.emit({ type: "thinking_delta", text: delta });
        return;
      }

      case "item/started": {
        // 區分 item type：functionCall / localShellCall / mcpToolCall → tool_call
        const item = p["item"] as { type?: string; name?: string; command?: unknown[] } | undefined;
        if (!item) return;
        const itemType = item.type;
        if (itemType === "functionCall" || itemType === "mcpToolCall") {
          ctx.emit({ type: "tool_call", title: item.name ?? itemType });
        } else if (itemType === "localShellCall") {
          const cmd = Array.isArray(item.command) ? (item.command as string[]).join(" ").slice(0, 80) : "shell";
          ctx.emit({ type: "tool_call", title: `shell: ${cmd}` });
        }
        // userMessage / agentMessage / reasoning 的 started 不轉發（agentMessage 由 delta 帶內容）
        return;
      }

      case "item/completed": {
        const item = p["item"] as { type?: string; name?: string; status?: string; error?: string; durationMs?: number } | undefined;
        if (!item) return;
        const itemType = item.type;
        if (itemType === "functionCall" || itemType === "mcpToolCall" || itemType === "localShellCall") {
          ctx.emit({
            type: "tool_result",
            title: item.name ?? itemType,
            duration_ms: typeof item.durationMs === "number" ? item.durationMs : undefined,
            error: item.status === "failed" ? (item.error ?? "tool failed") : undefined,
          });
        }
        return;
      }

      case "turn/completed": {
        const turn = p["turn"] as { status?: string; error?: { message?: string } } | undefined;
        const isError = turn?.status === "failed";
        const errText = turn?.error?.message;
        ctx.emit({ type: "result", is_error: isError, text: errText });
        return;
      }

      case "error": {
        const errObj = p["error"] as { message?: string } | undefined;
        const willRetry = !!p["willRetry"];
        const msg = errObj?.message ?? "unknown error";
        if (willRetry) {
          // 重連中 — 不轉發到 Discord，只 log
          ctx.emit({ type: "status", subtype: "codex_reconnecting", raw: { message: msg } });
        } else {
          ctx.emit({ type: "error", message: msg });
        }
        return;
      }

      // 其他 notification（rateLimits / mcpServer / tokenUsage / thread/status/changed 等）→ status log
      default:
        ctx.emit({ type: "status", subtype: `codex:${method}`, raw: params });
    }
  }

  // ── Server-request handler（Phase 2 信任模式 auto-approve）─────────────

  private async handleServerRequest(_id: number | string, method: string, _params: unknown): Promise<unknown> {
    log.info(`[cli-bridge:${this.label}] codex server-request auto-approved (Phase 2 trust mode): ${method}`);
    // Phase 3 會改成依 method 走 Discord 按鈕審批
    return { decision: "approved", approved: true, allow: true, allowed: true };
  }

  // ── 圖片暫存 ──────────────────────────────────────────────────────────────

  private writeBase64ImageToTmp(img: StdinImageBlock): string | null {
    try {
      const ext = img.source.media_type === "image/png" ? ".png"
        : img.source.media_type === "image/jpeg" ? ".jpg"
        : img.source.media_type === "image/gif" ? ".gif"
        : img.source.media_type === "image/webp" ? ".webp" : ".png";
      const path = join(tmpdir(), `catclaw-codex-img-${randomUUID()}${ext}`);
      writeFileSync(path, Buffer.from(img.source.data, "base64"));
      return path;
    } catch (err) {
      log.warn(`[cli-bridge:${this.label}] writeBase64ImageToTmp 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private cleanupCurrentTurnImages(): void {
    for (const path of this.currentTurnImageTmpFiles) {
      try { unlinkSync(path); } catch { /* 靜默 */ }
    }
    this.currentTurnImageTmpFiles = [];
  }

  // ── Session resume 路徑檢查 ────────────────────────────────────────────────

  /**
   * Codex 把 thread .jsonl 存在：
   *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
   * 簡單實作：遞迴掃描 ~/.codex/sessions/ 找含 sessionId 的 .jsonl。
   */
  isSessionResumable(sessionId: string): boolean {
    try {
      const sessionsDir = join(homedir(), ".codex", "sessions");
      if (!existsSync(sessionsDir)) return false;
      return this.findSessionJsonl(sessionsDir, sessionId);
    } catch {
      return false;
    }
  }

  private findSessionJsonl(dir: string, sessionId: string, depth = 0): boolean {
    if (depth > 6) return false; // 防無限遞迴
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.findSessionJsonl(full, sessionId, depth + 1)) return true;
        } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
          return true;
        }
      }
    } catch { /* 靜默 */ }
    return false;
  }
}
