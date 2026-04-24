/**
 * @file cli-bridge/providers/claude.ts
 * @description ClaudeProvider — 把 Claude CLI 持久 stream-json 模式的邏輯封裝成 CliProvider。
 *
 * 從 process.ts 整段平移過來（Phase 1 純抽象搬家，0 行為變化）：
 * - Spawn args（`-p --input-format stream-json --output-format stream-json --verbose ...`）
 * - per-bridge MCP config 寫入（catclaw-bridge-discord）
 * - Stdin NDJSON encode（user / keep_alive / control_response）
 * - Stdout NDJSON parse（system/init / assistant / result / tool_use_summary / control_request）
 * - Assistant 訊息的 diff 串流（text / thinking / tool_use blocks）
 * - Session JSONL 存在性檢查（`~/.claude/projects/<slug>/<sid>.jsonl`）
 */

import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log } from "../../logger.js";
import type { CliBridgeEvent, CliProcessConfig, StdinImageBlock } from "../types.js";
import type { CliProvider, ProcessIO, ProviderContext, ProviderSpawnSpec } from "./provider.js";

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

// ── ClaudeProvider ─────────────────────────────────────────────────────────────

export class ClaudeProvider implements CliProvider {
  readonly name = "claude";

  // 串流 diff 追蹤狀態（per-instance，process restart 時 resetStreamState 清掉）
  private lastMessageId = "";
  private lastTextLength = 0;
  private lastThinkingLength = 0;
  private lastToolCount = 0;

  // ── 啟動 ──────────────────────────────────────────────────────────────────

  buildSpawn(config: CliProcessConfig): ProviderSpawnSpec {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    ];

    // 互斥分支：dangerouslySkipPermissions 與 --permission-prompt-tool 不可共存
    // - true：信任模式，沿用舊行為直接放行
    // - false（預設）：走 MCP request_permission tool → Discord 按鈕審批
    if (config.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
      log.warn(`[cli-bridge:${config.label}] dangerouslySkipPermissions=true（fail-open，所有 tool 直接放行）`);
    } else {
      args.push("--permission-prompt-tool", "mcp__catclaw-bridge-discord__request_permission");
    }

    // --resume 前先驗證 .jsonl 是否還在 ~/.claude/projects/*/；
    // 若不在，跳過 --resume 讓 CLI 開新 session（避免 "No conversation found" 死循環）
    let effectiveSessionId: string | undefined = config.sessionId;
    if (config.sessionId && !this.isSessionResumable(config.sessionId)) {
      log.warn(`[cli-bridge:${config.label}] session ${config.sessionId} 的 .jsonl 不存在，跳過 --resume 改用新 session`);
      effectiveSessionId = undefined;
    }
    if (effectiveSessionId) {
      args.push("--resume", effectiveSessionId);
    }

    // 寫入 per-bridge MCP config：catclaw-bridge-discord 用 bridge 自己的 bot token
    const mcpConfigPath = this.writeMcpConfig(config);
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    // 注入 bridge runtime env（讓 CLI 內可以 echo $CATCLAW_BRIDGE_* 查證部署資訊）
    const env: Record<string, string> = {};
    env.CATCLAW_BRIDGE_LABEL = config.label;
    if (config.channelId) {
      env.CATCLAW_BRIDGE_CHANNEL_ID = config.channelId;
      // request_permission 用：MCP server 啟動 Discord Gateway 後要 fetch 哪個頻道發按鈕
      env.DISCORD_CHANNEL_ID = config.channelId;
    }
    if (effectiveSessionId) env.CATCLAW_BRIDGE_SESSION_ID = effectiveSessionId;

    return { args, env };
  }

  async postSpawn(_io: ProcessIO, _ctx: ProviderContext): Promise<void> {
    // Claude 不需要握手；session_init 由 stdout 的 system/init event 觸發
  }

  // ── session .jsonl 檢查 ──────────────────────────────────────────────────

  /**
   * 檢查 Claude CLI 的 session .jsonl 是否還存在。
   * Claude CLI 將 session 存在 `~/.claude/projects/<slug>/<sid>.jsonl`，
   * slug 會因 Claude 版本不同而略有差異，直接掃描所有 project 子目錄最穩。
   */
  isSessionResumable(sid: string): boolean {
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
  private writeMcpConfig(config: CliProcessConfig): string | null {
    const label = config.label;
    if (!config.botToken || !config.channelId) {
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

      // discord-server.js 相對於 dist/cli-bridge/providers/ 位置
      const serverPath = resolvePath(__dirname, "..", "..", "mcp", "discord-server.js");

      const mcpConfig = {
        mcpServers: {
          "catclaw-bridge-discord": {
            command: "node",
            args: [serverPath],
            env: {
              DISCORD_TOKEN: config.botToken,
              // request_permission tool 需要知道要在哪個頻道發審批按鈕
              DISCORD_CHANNEL_ID: config.channelId,
              CATCLAW_BRIDGE_LABEL: config.label,
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

  // ── stdin encode ──────────────────────────────────────────────────────────

  sendUserMessage(io: ProcessIO, text: string, imageBlocks: StdinImageBlock[] | undefined, _ctx: ProviderContext): void {
    const content = imageBlocks && imageBlocks.length > 0
      ? [{ type: "text" as const, text }, ...imageBlocks]
      : text;
    const msg = { type: "user" as const, message: { role: "user" as const, content } };
    io.writeStdinLine(JSON.stringify(msg));
  }

  sendKeepAlive(io: ProcessIO): boolean | null {
    try {
      io.writeStdinLine(JSON.stringify({ type: "keep_alive" }));
      return true;
    } catch {
      return false;
    }
  }

  sendControlResponse(io: ProcessIO, requestId: string, allowed: boolean): void {
    io.writeStdinLine(JSON.stringify({
      type: "control_response",
      permission_request_id: requestId,
      allowed,
    }));
  }

  interrupt(io: ProcessIO, _ctx: ProviderContext): void {
    io.signal("SIGINT");
  }

  // ── stdout 解析 ────────────────────────────────────────────────────────────

  resetStreamState(): void {
    this.lastMessageId = "";
    this.lastTextLength = 0;
    this.lastThinkingLength = 0;
    this.lastToolCount = 0;
  }

  /**
   * 解析一行 stdout JSON object，emit 0-N 個 CliBridgeEvent。
   *
   * Claude assistant 訊息的 diff 是有狀態的：
   * - thinking 增量先 emit
   * - 然後 text 增量
   * - 然後 tool_use 增量（且若 text 與 tool 同時出現，先 text 再 tool）
   *
   * 原版 process.ts 在 parseAssistantEvent 內直接 this.emit("event", ...) 多次，這裡改為 ctx.emit。
   */
  parseStdoutLine(obj: Record<string, unknown>, ctx: ProviderContext): void {
    const type = obj["type"] as string | undefined;

    // ── system/init：取得 session_id ──
    if (type === "system" && obj["subtype"] === "init") {
      const sid = obj["session_id"] as string | undefined;
      if (sid) ctx.emit({ type: "session_init", sessionId: sid });
      return;
    }

    // ── assistant：串流文字 + 工具呼叫（diff 模式，可能 emit 多個 event）──
    if (type === "assistant") {
      this.parseAssistantEvent(obj, ctx);
      return;
    }

    // ── result：turn 結束 ──
    if (type === "result") {
      const isError = !!obj["is_error"];
      const sessionId = obj["session_id"] as string | undefined;
      const resultText = typeof obj["result"] === "string" ? obj["result"] as string : undefined;
      ctx.emit({ type: "result", is_error: isError, text: resultText, session_id: sessionId });
      return;
    }

    // ── tool_use_summary：工具結果摘要 ──
    if (type === "tool_use_summary") {
      const name = (obj["tool_name"] ?? obj["name"] ?? "unknown") as string;
      const error = obj["error"] as string | undefined;
      const durationMs = typeof obj["duration_ms"] === "number" ? obj["duration_ms"] as number : undefined;
      ctx.emit({ type: "tool_result", title: name, duration_ms: durationMs, error: error || undefined });
      return;
    }

    // ── control_request：權限請求 ──
    if (type === "control_request") {
      ctx.emit({
        type: "control_request",
        requestId: obj["id"] as string ?? "",
        tool: obj["tool"] as string ?? "",
        description: obj["description"] as string ?? "",
      });
      return;
    }

    // 其他事件靜默記錄
    if (type) {
      ctx.emit({ type: "status", subtype: type, raw: obj });
    }
  }

  private parseAssistantEvent(obj: Record<string, unknown>, ctx: ProviderContext): void {
    // Subagent（Task tool 內部）的 assistant 訊息不轉發到 Discord —
    // 主 agent 已透過 Task tool_call 告知有 subagent 在跑，subagent 內部敘述屬於實作細節。
    if (obj["parent_tool_use_id"]) return;

    const msg = obj["message"] as AssistantMessage | undefined;
    if (!msg?.content) return;

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
      ctx.emit({ type: "thinking_delta", text: delta });
    }

    // text diff
    const fullText = msg.content
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");

    let textDelta: CliBridgeEvent | null = null;
    if (fullText.length > this.lastTextLength) {
      const delta = fullText.slice(this.lastTextLength);
      this.lastTextLength = fullText.length;
      textDelta = { type: "text_delta", text: delta };
    }

    // tool_use blocks — 先 emit text_delta 再 emit tool_call，確保順序正確
    const toolBlocks = msg.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length > this.lastToolCount) {
      // 如果同時有 text delta，先 emit 它
      if (textDelta) {
        ctx.emit(textDelta);
        textDelta = null;
      }
      for (let i = this.lastToolCount; i < toolBlocks.length; i++) {
        ctx.emit({ type: "tool_call", title: toolBlocks[i]!.name ?? "unknown" });
      }
      this.lastToolCount = toolBlocks.length;
    }

    // 若沒被 tool 提前 emit 出去，這裡 emit
    if (textDelta) {
      ctx.emit(textDelta);
    }
  }
}
