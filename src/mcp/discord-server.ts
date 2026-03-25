/**
 * @file mcp/discord-server.ts
 * @description CatClaw MCP Discord Tool Server — Phase 0 過渡橋接
 *
 * 讓 Claude CLI session 能透過 MCP tool 執行 Discord 操作。
 * 支援 action：send / thread-create / read / react / edit / delete
 *
 * ⚠️ 此模組為 Phase 0 過渡方案，S4/S5 HTTP API + 原生 Tool 系統完成後可移除。
 *    移除時需同步清理：acp.ts 的 .mcp.json 寫入邏輯 + workspace/.mcp.json
 *
 * 協議：stdio JSON-RPC 2.0（MCP standard）
 * 認證：DISCORD_TOKEN 環境變數（由 acp.ts 注入）
 * 安全：DISCORD_ALLOWED_CHANNELS 環境變數（逗號分隔），空白表示不限
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const TOKEN = process.env.DISCORD_TOKEN ?? "";
const ALLOWED = new Set(
  (process.env.DISCORD_ALLOWED_CHANNELS ?? "").split(",").filter(Boolean)
);
const API = "https://discord.com/api/v10";

// ── Discord REST ─────────────────────────────────────────────────────────────

async function discordFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "CatClaw/1.0",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as unknown;
  if (!res.ok) throw new Error(`Discord ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function discordUpload(channelId: string, filePath: string, content?: string): Promise<void> {
  const buf = readFileSync(filePath);
  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
  const form = new FormData();
  if (content) form.append("payload_json", JSON.stringify({ content }));
  form.append("files[0]", new Blob([buf]), filename);
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": "CatClaw/1.0" },
    body: form,
  });
  const data = await res.json() as unknown;
  if (!res.ok) throw new Error(`Discord upload ${res.status}: ${JSON.stringify(data)}`);
}

// ── Tool 執行 ─────────────────────────────────────────────────────────────────

interface MsgParams {
  action: string;
  to?: string;
  channelId?: string;
  message?: string;
  media?: string;
  threadName?: string;
  messageId?: string;
  emoji?: string;
  limit?: number;
}

async function runTool(p: MsgParams): Promise<string> {
  const channelId = p.channelId ?? p.to?.replace(/^channel:/, "");

  // channel allowlist
  if (channelId && ALLOWED.size > 0 && !ALLOWED.has(channelId)) {
    throw new Error(`Channel ${channelId} 不在允許清單`);
  }

  switch (p.action) {
    case "send": {
      if (!channelId) throw new Error("send 需要 channelId 或 to");
      if (p.media) {
        await discordUpload(channelId, p.media.replace(/^file:\/\//, ""), p.message);
        return "訊息 + 檔案已送出";
      }
      let text = p.message ?? "";
      while (text.length > 0) {
        await discordFetch("POST", `/channels/${channelId}/messages`, { content: text.slice(0, 2000) });
        text = text.slice(2000);
      }
      return "訊息已送出";
    }
    case "thread-create": {
      if (!channelId) throw new Error("thread-create 需要 channelId");
      if (!p.threadName) throw new Error("thread-create 需要 threadName");
      const r = await discordFetch("POST", `/channels/${channelId}/threads`, {
        name: p.threadName,
        message: { content: p.message ?? "" },
      }) as { id: string };
      return `Thread 建立完成，ID: ${r.id}`;
    }
    case "read": {
      if (!channelId) throw new Error("read 需要 channelId");
      const msgs = await discordFetch("GET", `/channels/${channelId}/messages?limit=${p.limit ?? 10}`);
      return JSON.stringify(msgs);
    }
    case "react": {
      if (!channelId || !p.messageId || !p.emoji) throw new Error("react 需要 channelId / messageId / emoji");
      await discordFetch("PUT", `/channels/${channelId}/messages/${p.messageId}/reactions/${encodeURIComponent(p.emoji)}/@me`);
      return "Reaction 已加";
    }
    case "edit": {
      if (!channelId || !p.messageId) throw new Error("edit 需要 channelId / messageId");
      await discordFetch("PATCH", `/channels/${channelId}/messages/${p.messageId}`, { content: p.message });
      return "訊息已編輯";
    }
    case "delete": {
      if (!channelId || !p.messageId) throw new Error("delete 需要 channelId / messageId");
      await discordFetch("DELETE", `/channels/${channelId}/messages/${p.messageId}`);
      return "訊息已刪除";
    }
    default:
      throw new Error(`不支援的 action: ${p.action}`);
  }
}

// ── MCP stdio JSON-RPC 2.0 ────────────────────────────────────────────────────

const TOOL = {
  name: "message",
  description: "執行 Discord 操作（send / thread-create / read / react / edit / delete）",
  inputSchema: {
    type: "object",
    properties: {
      action:     { type: "string", enum: ["send", "thread-create", "read", "react", "edit", "delete"] },
      to:         { type: "string", description: "channel:<id>" },
      channelId:  { type: "string" },
      message:    { type: "string" },
      media:      { type: "string", description: "file:///path/to/file" },
      threadName: { type: "string" },
      messageId:  { type: "string" },
      emoji:      { type: "string" },
      limit:      { type: "number" },
    },
    required: ["action"],
  },
};

function send(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function sendErr(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { id?: unknown; method: string; params?: unknown };
  try { msg = JSON.parse(trimmed) as typeof msg; }
  catch { return; }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        send(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "catclaw-discord", version: "1.0.0" },
        });
        break;

      case "notifications/initialized":
        break; // notification, no response

      case "tools/list":
        send(id, { tools: [TOOL] });
        break;

      case "tools/call": {
        const p = params as { name: string; arguments: MsgParams };
        if (p.name !== "message") { sendErr(id, -32601, `Unknown tool: ${p.name}`); break; }
        try {
          const text = await runTool(p.arguments);
          send(id, { content: [{ type: "text", text }] });
        } catch (err) {
          send(id, { content: [{ type: "text", text: `錯誤：${err instanceof Error ? err.message : String(err)}` }], isError: true });
        }
        break;
      }

      default:
        if (id !== undefined) sendErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) sendErr(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

rl.on("close", () => process.exit(0));
