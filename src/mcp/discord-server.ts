/**
 * @file mcp/discord-server.ts
 * @description CatClaw MCP Discord Tool Server
 *
 * 讓 Claude CLI session 能透過 MCP tool 執行 Discord 操作。
 * 協議：stdio JSON-RPC 2.0（MCP standard）
 * 認證：DISCORD_TOKEN 環境變數（由 acp.ts 注入）
 * 安全：存取範圍由 Bot Token 的 Discord 權限決定
 *
 * Action 分類：
 *   Messaging: send, read, edit, delete, fetchMessage, react, reactions,
 *              threadCreate, threadList, threadReply,
 *              pinMessage, unpinMessage, listPins, searchMessages, poll
 *   Guild:     memberInfo, roleInfo, roleAdd, roleRemove,
 *              channelInfo, channelList, channelCreate, channelEdit, channelDelete, channelMove,
 *              categoryCreate, categoryEdit, categoryDelete,
 *              channelPermissionSet, channelPermissionRemove,
 *              emojiList, eventList, eventCreate
 *   Moderation: timeout, kick, ban
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  StringSelectMenuBuilder,
  type ButtonInteraction, type StringSelectMenuInteraction,
  type Message, type TextChannel, type ThreadChannel,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN ?? "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? "";
const BRIDGE_LABEL = process.env.CATCLAW_BRIDGE_LABEL ?? "bridge";
const API = "https://discord.com/api/v10";
const PERMISSION_TIMEOUT_MS = Number(process.env.CATCLAW_PERMISSION_TIMEOUT_MS ?? 600_000); // 預設 10 分鐘

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
  if (res.status === 204) return { ok: true };
  const data = await res.json() as unknown;
  if (!res.ok) throw new Error(`Discord ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * 正規化本地路徑：處理 file:// URI、Windows 雙 drive letter、leading slash 等 AI 常見錯誤輸入。
 *
 * 已知失敗模式：
 *   - `file:///C:/path` → 之前的 `replace(/^file:\/\//, "")` 留下 `/C:/path`，Node fs 在 Windows
 *     把 `/C:/` 解析成 `C:\C:\`（drive root + 剩下），導致 `ENOENT: C:\C:\path\to\file`
 *   - `C:\C:\path` → AI 自己產生的雙 drive letter
 *
 * 不用 `fileURLToPath`：該 API 的 Windows-path 判定取決於執行 OS，在 macOS 上跑也會看到
 * `file:///C:/...` 被當 posix → 回傳 `/C:/...`（= 錯誤結果）。直接 pattern 判斷跨平台穩定。
 */
function normalizeLocalPath(rawPath: string): string {
  // 1) Windows file URI：file:///C:/path 或 file:///C:\path（字元：drive letter + `:`）
  const winFileUri = /^file:\/\/\/?([A-Za-z]:)(.*)$/i.exec(rawPath);
  if (winFileUri) {
    try {
      return winFileUri[1] + decodeURIComponent(winFileUri[2]);
    } catch {
      return winFileUri[1] + winFileUri[2];
    }
  }
  // 2) Posix file URI：file:///Users/... → 用原生 fileURLToPath
  if (/^file:\/\//i.test(rawPath)) {
    try {
      return fileURLToPath(rawPath);
    } catch {
      return rawPath.replace(/^file:\/\/\/?/i, "/");
    }
  }
  // 3) leading slash + drive letter：`/C:/path` 或 `/C:\path`（Node fs Windows 會誤解成 `C:\C:\`）
  if (/^\/[A-Za-z]:[\\/]/.test(rawPath)) return rawPath.slice(1);
  // 4) 雙 drive letter：`C:\C:\path` 或 `C:/C:/path`
  return rawPath.replace(/^([A-Za-z]):[\\/](?=[A-Za-z]:[\\/])/, "");
}

/** 由副檔名推斷 mime type（Discord attachment 預期有 type，用 octet-stream fallback） */
function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "mp4": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    case "pdf": return "application/pdf";
    case "json": return "application/json";
    case "txt": case "md": case "log": return "text/plain";
    case "html": case "htm": return "text/html";
    case "css": return "text/css";
    case "js": case "mjs": case "cjs": return "application/javascript";
    case "ts": case "tsx": return "application/typescript";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

async function discordUpload(channelId: string, rawPath: string, content?: string): Promise<void> {
  const filePath = normalizeLocalPath(rawPath);
  const buf = readFileSync(filePath);
  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
  const mime = guessMimeType(filename);
  const form = new FormData();
  if (content) form.append("payload_json", JSON.stringify({ content }));
  // 給 Blob 顯式 type — Discord 對某些 channel/權限會檢查 attachment content-type
  form.append("files[0]", new Blob([buf], { type: mime }), filename);

  // 用 Headers 物件包 Authorization：node fetch (undici) 在 multipart 路徑有時會吞掉
  // 純物件形式的 header；用 Headers 物件可確保不被覆寫。Content-Type 不指定，讓
  // fetch 自動帶 multipart boundary。
  const headers = new Headers();
  headers.set("Authorization", `Bot ${TOKEN}`);
  headers.set("User-Agent", "CatClaw/1.0");

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    // 上傳失敗時印詳細 debug 資訊，方便排查 401（token 錯/缺權限）vs 400（格式）等
    const tokenPrefix = TOKEN ? TOKEN.slice(0, 8) + "..." : "(empty)";
    process.stderr.write(
      `[catclaw-discord] upload FAIL status=${res.status} ${res.statusText} ` +
      `channel=${channelId} file=${filename} size=${buf.length} mime=${mime} ` +
      `token=${tokenPrefix} body=${JSON.stringify(data).slice(0, 200)}\n`,
    );
    throw new Error(`Discord upload ${res.status}: ${JSON.stringify(data)}`);
  }
}

// ── Param helpers ────────────────────────────────────────────────────────────

type P = Record<string, unknown>;

function str(p: P, key: string, required = false): string | undefined {
  const v = p[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new Error(`缺少必要參數: ${key}`);
  return undefined;
}

function num(p: P, key: string): number | undefined {
  const v = p[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return parseInt(v, 10);
  return undefined;
}

function strArr(p: P, key: string): string[] | undefined {
  const v = p[key];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

function channelId(p: P): string {
  const id = str(p, "channelId") ?? str(p, "to")?.replace(/^channel:/, "");
  if (!id) throw new Error("缺少 channelId 或 to");
  return id;
}

function guildId(p: P): string {
  return str(p, "guildId", true)!;
}

// ── Tool 執行 ─────────────────────────────────────────────────────────────────

async function runTool(p: P): Promise<string> {
  const action = str(p, "action", true)!;

  switch (action) {

    // ═══════════════════════════════════════════════════════════════════════════
    // Messaging
    // ═══════════════════════════════════════════════════════════════════════════

    case "send": {
      const ch = channelId(p);
      if (p.media) {
        // 路徑正規化交給 discordUpload 內部的 normalizeLocalPath
        await discordUpload(ch, String(p.media), str(p, "message"));
        return "訊息 + 檔案已送出";
      }
      let text = str(p, "message") ?? "";
      const replyTo = str(p, "replyTo");
      while (text.length > 0) {
        const body: Record<string, unknown> = { content: text.slice(0, 2000) };
        if (replyTo && text === (str(p, "message") ?? "")) {
          body.message_reference = { message_id: replyTo };
        }
        await discordFetch("POST", `/channels/${ch}/messages`, body);
        text = text.slice(2000);
      }
      return "訊息已送出";
    }

    case "read": {
      const ch = channelId(p);
      const limit = num(p, "limit") ?? 10;
      const before = str(p, "before");
      const after = str(p, "after");
      let qs = `limit=${limit}`;
      if (before) qs += `&before=${before}`;
      if (after) qs += `&after=${after}`;
      const msgs = await discordFetch("GET", `/channels/${ch}/messages?${qs}`);
      return JSON.stringify(msgs);
    }

    case "fetchMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const msg = await discordFetch("GET", `/channels/${ch}/messages/${msgId}`);
      return JSON.stringify(msg);
    }

    case "edit": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch("PATCH", `/channels/${ch}/messages/${msgId}`, { content: str(p, "message") });
      return "訊息已編輯";
    }

    case "delete": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch("DELETE", `/channels/${ch}/messages/${msgId}`);
      return "訊息已刪除";
    }

    case "react": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const emoji = str(p, "emoji", true)!;
      const remove = p.remove === true;
      if (remove) {
        await discordFetch("DELETE", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}/@me`);
        return "Reaction 已移除";
      }
      await discordFetch("PUT", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}/@me`);
      return "Reaction 已加";
    }

    case "reactions": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      const emoji = str(p, "emoji", true)!;
      const limit = num(p, "limit") ?? 25;
      const users = await discordFetch("GET", `/channels/${ch}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}?limit=${limit}`);
      return JSON.stringify(users);
    }

    // ── Thread ──

    case "threadCreate": {
      const ch = channelId(p);
      const name = str(p, "name", true)!;
      const msgId = str(p, "messageId");
      const content = str(p, "message");
      const autoArchiveMinutes = num(p, "autoArchiveMinutes");

      if (msgId) {
        // 從既有訊息建立 thread
        const r = await discordFetch("POST", `/channels/${ch}/messages/${msgId}/threads`, {
          name,
          auto_archive_duration: autoArchiveMinutes ?? 1440,
        }) as { id: string };
        if (content) await discordFetch("POST", `/channels/${r.id}/messages`, { content });
        return `Thread 建立完成（從訊息），ID: ${r.id}`;
      }
      // 無 messageId → 先發導引訊息再從該訊息建立 thread（讓主頻出現導引）
      const guideContent = content ?? `📌 ${name}`;
      const guideMsg = await discordFetch("POST", `/channels/${ch}/messages`, {
        content: guideContent,
      }) as { id: string };
      const r = await discordFetch("POST", `/channels/${ch}/messages/${guideMsg.id}/threads`, {
        name,
        auto_archive_duration: autoArchiveMinutes ?? 1440,
      }) as { id: string };
      return `Thread 建立完成（含主頻導引），ID: ${r.id}`;
    }

    case "threadList": {
      const gid = guildId(p);
      const active = await discordFetch("GET", `/guilds/${gid}/threads/active`);
      return JSON.stringify(active);
    }

    case "threadReply": {
      const ch = channelId(p); // thread ID
      const content = str(p, "message", true)!;
      const replyTo = str(p, "replyTo");
      const body: Record<string, unknown> = { content };
      if (replyTo) body.message_reference = { message_id: replyTo };
      const msg = await discordFetch("POST", `/channels/${ch}/messages`, body);
      return JSON.stringify(msg);
    }

    // ── Pin ──

    case "pinMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch("PUT", `/channels/${ch}/pins/${msgId}`);
      return "訊息已釘選";
    }

    case "unpinMessage": {
      const ch = channelId(p);
      const msgId = str(p, "messageId", true)!;
      await discordFetch("DELETE", `/channels/${ch}/pins/${msgId}`);
      return "訊息已取消釘選";
    }

    case "listPins": {
      const ch = channelId(p);
      const pins = await discordFetch("GET", `/channels/${ch}/pins`);
      return JSON.stringify(pins);
    }

    // ── Search ──

    case "searchMessages": {
      const gid = guildId(p);
      const content = str(p, "content", true)!;
      const ch = str(p, "channelId");
      const authorId = str(p, "authorId");
      const limit = num(p, "limit") ?? 25;
      let qs = `content=${encodeURIComponent(content)}&limit=${limit}`;
      if (ch) qs += `&channel_id=${ch}`;
      if (authorId) qs += `&author_id=${authorId}`;
      const results = await discordFetch("GET", `/guilds/${gid}/messages/search?${qs}`);
      return JSON.stringify(results);
    }

    // ── Poll ──

    case "poll": {
      const ch = channelId(p);
      const question = str(p, "question", true)!;
      const answers = strArr(p, "answers");
      if (!answers?.length) throw new Error("poll 需要 answers 陣列");
      const durationHours = num(p, "durationHours") ?? 24;
      const allowMultiselect = p.allowMultiselect === true;
      const content = str(p, "message");
      const body: Record<string, unknown> = {
        poll: {
          question: { text: question },
          answers: answers.map(a => ({ poll_media: { text: a } })),
          duration: durationHours,
          allow_multiselect: allowMultiselect,
        },
      };
      if (content) body.content = content;
      await discordFetch("POST", `/channels/${ch}/messages`, body);
      return "Poll 已建立";
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Guild
    // ═══════════════════════════════════════════════════════════════════════════

    case "memberInfo": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const member = await discordFetch("GET", `/guilds/${gid}/members/${userId}`);
      return JSON.stringify(member);
    }

    case "roleInfo": {
      const gid = guildId(p);
      const roles = await discordFetch("GET", `/guilds/${gid}/roles`);
      return JSON.stringify(roles);
    }

    case "roleAdd": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const roleId = str(p, "roleId", true)!;
      await discordFetch("PUT", `/guilds/${gid}/members/${userId}/roles/${roleId}`);
      return "Role 已新增";
    }

    case "roleRemove": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const roleId = str(p, "roleId", true)!;
      await discordFetch("DELETE", `/guilds/${gid}/members/${userId}/roles/${roleId}`);
      return "Role 已移除";
    }

    case "emojiList": {
      const gid = guildId(p);
      const emojis = await discordFetch("GET", `/guilds/${gid}/emojis`);
      return JSON.stringify(emojis);
    }

    case "channelInfo": {
      const ch = channelId(p);
      const channel = await discordFetch("GET", `/channels/${ch}`);
      return JSON.stringify(channel);
    }

    case "channelList": {
      const gid = guildId(p);
      const channels = await discordFetch("GET", `/guilds/${gid}/channels`);
      return JSON.stringify(channels);
    }

    case "channelCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const type = num(p, "type") ?? 0; // 0=text, 2=voice, 4=category, 13=stage, 15=forum
      const parentId = str(p, "parentId");
      const topic = str(p, "topic");
      const position = num(p, "position");
      const body: Record<string, unknown> = { name, type };
      if (parentId) body.parent_id = parentId;
      if (topic) body.topic = topic;
      if (position !== undefined) body.position = position;
      const channel = await discordFetch("POST", `/guilds/${gid}/channels`, body);
      return JSON.stringify(channel);
    }

    case "channelEdit": {
      const ch = channelId(p);
      const body: Record<string, unknown> = {};
      const name = str(p, "name");
      const topic = str(p, "topic");
      const position = num(p, "position");
      const parentId = str(p, "parentId");
      const nsfw = p.nsfw;
      const rateLimitPerUser = num(p, "rateLimitPerUser");
      const archived = p.archived;
      const locked = p.locked;
      const autoArchiveDuration = num(p, "autoArchiveDuration");
      if (name) body.name = name;
      if (topic !== undefined) body.topic = topic;
      if (position !== undefined) body.position = position;
      if (parentId !== undefined) body.parent_id = parentId;
      if (typeof nsfw === "boolean") body.nsfw = nsfw;
      if (rateLimitPerUser !== undefined) body.rate_limit_per_user = rateLimitPerUser;
      if (typeof archived === "boolean") body.archived = archived;
      if (typeof locked === "boolean") body.locked = locked;
      if (autoArchiveDuration !== undefined) body.auto_archive_duration = autoArchiveDuration;
      const channel = await discordFetch("PATCH", `/channels/${ch}`, body);
      return JSON.stringify(channel);
    }

    case "channelDelete": {
      const ch = channelId(p);
      await discordFetch("DELETE", `/channels/${ch}`);
      return "Channel 已刪除";
    }

    case "channelMove": {
      const gid = guildId(p);
      const ch = str(p, "channelId", true)!;
      const parentId = str(p, "parentId");
      const position = num(p, "position");
      const body: Record<string, unknown> = { id: ch };
      if (parentId !== undefined) body.parent_id = parentId;
      if (position !== undefined) body.position = position;
      await discordFetch("PATCH", `/guilds/${gid}/channels`, [body]);
      return "Channel 已移動";
    }

    case "categoryCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const position = num(p, "position");
      const body: Record<string, unknown> = { name, type: 4 };
      if (position !== undefined) body.position = position;
      const category = await discordFetch("POST", `/guilds/${gid}/channels`, body);
      return JSON.stringify(category);
    }

    case "categoryEdit": {
      const catId = str(p, "categoryId", true)!;
      const body: Record<string, unknown> = {};
      const name = str(p, "name");
      const position = num(p, "position");
      if (name) body.name = name;
      if (position !== undefined) body.position = position;
      const category = await discordFetch("PATCH", `/channels/${catId}`, body);
      return JSON.stringify(category);
    }

    case "categoryDelete": {
      const catId = str(p, "categoryId", true)!;
      await discordFetch("DELETE", `/channels/${catId}`);
      return "Category 已刪除";
    }

    case "channelPermissionSet": {
      const ch = channelId(p);
      const targetId = str(p, "targetId", true)!;
      const targetType = str(p, "targetType") === "member" ? 1 : 0; // 0=role, 1=member
      const allow = str(p, "allow");
      const deny = str(p, "deny");
      await discordFetch("PUT", `/channels/${ch}/permissions/${targetId}`, {
        type: targetType,
        allow: allow ?? "0",
        deny: deny ?? "0",
      });
      return "權限已設定";
    }

    case "channelPermissionRemove": {
      const ch = channelId(p);
      const targetId = str(p, "targetId", true)!;
      await discordFetch("DELETE", `/channels/${ch}/permissions/${targetId}`);
      return "權限已移除";
    }

    case "eventList": {
      const gid = guildId(p);
      const events = await discordFetch("GET", `/guilds/${gid}/scheduled-events`);
      return JSON.stringify(events);
    }

    case "eventCreate": {
      const gid = guildId(p);
      const name = str(p, "name", true)!;
      const startTime = str(p, "startTime", true)!;
      const endTime = str(p, "endTime");
      const description = str(p, "description");
      const ch = str(p, "channelId");
      const location = str(p, "location");
      const entityTypeRaw = str(p, "entityType");
      const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
      const body: Record<string, unknown> = {
        name,
        scheduled_start_time: startTime,
        entity_type: entityType,
        privacy_level: 2,
      };
      if (description) body.description = description;
      if (endTime) body.scheduled_end_time = endTime;
      if (ch) body.channel_id = ch;
      if (entityType === 3 && location) body.entity_metadata = { location };
      const event = await discordFetch("POST", `/guilds/${gid}/scheduled-events`, body);
      return JSON.stringify(event);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Moderation
    // ═══════════════════════════════════════════════════════════════════════════

    case "timeout": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const durationMinutes = num(p, "durationMinutes");
      const reason = str(p, "reason");
      let until: string | null = null;
      if (durationMinutes && durationMinutes > 0) {
        until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      }
      const headers: Record<string, string> = {};
      if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
      await discordFetch("PATCH", `/guilds/${gid}/members/${userId}`, {
        communication_disabled_until: until,
      });
      return until ? `使用者已禁言至 ${until}` : "禁言已解除";
    }

    case "kick": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const reason = str(p, "reason");
      const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      await discordFetch("DELETE", `/guilds/${gid}/members/${userId}${qs}`);
      return "使用者已被踢出";
    }

    case "ban": {
      const gid = guildId(p);
      const userId = str(p, "userId", true)!;
      const reason = str(p, "reason");
      const deleteMessageDays = num(p, "deleteMessageDays");
      const body: Record<string, unknown> = {};
      if (deleteMessageDays) body.delete_message_days = deleteMessageDays;
      const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      await discordFetch("PUT", `/guilds/${gid}/bans/${userId}${qs}`, body);
      return "使用者已被封禁";
    }

    default:
      throw new Error(`不支援的 action: ${action}`);
  }
}

// ── Permission Prompt Tool (Discord 按鈕審批) ────────────────────────────────

let _client: Client | null = null;
let _clientReady: Promise<Client> | null = null;

function getDiscordClient(): Promise<Client> {
  if (_clientReady) return _clientReady;
  if (!TOKEN) return Promise.reject(new Error("DISCORD_TOKEN not set"));
  _client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  _clientReady = new Promise<Client>((resolve, reject) => {
    _client!.once(Events.ClientReady, () => resolve(_client!));
    _client!.once(Events.Error, reject);
    _client!.login(TOKEN).catch(reject);
  });
  return _clientReady;
}

async function fetchPermissionChannel(): Promise<TextChannel | ThreadChannel> {
  if (!CHANNEL_ID) throw new Error("DISCORD_CHANNEL_ID not set");
  const client = await getDiscordClient();
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch || !ch.isTextBased() || !("send" in ch)) {
    throw new Error(`Channel ${CHANNEL_ID} not text-based or sendable`);
  }
  return ch as TextChannel | ThreadChannel;
}

interface PermissionInput {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

function splitPlanForDiscord(content: string, limit = 1900): string[] {
  if (content.length <= limit) return [content];
  const SAFE = limit - 20;
  const out: string[] = [];
  let pos = 0;
  while (pos < content.length) {
    if (content.length - pos <= limit) { out.push(content.slice(pos)); break; }
    let cut = content.lastIndexOf("\n", pos + SAFE);
    if (cut <= pos + Math.floor(SAFE / 2)) cut = pos + SAFE;
    out.push(content.slice(pos, cut));
    pos = cut;
    if (content[pos] === "\n") pos++;
  }
  return out;
}

async function handleExitPlanMode(p: PermissionInput): Promise<PermissionResult> {
  const channel = await fetchPermissionChannel();
  const plan = String(p.input.plan ?? "(no plan content)");
  const head = `📋 **Plan 待審批** (bridge: \`${BRIDGE_LABEL}\`)`;
  await channel.send(head);
  const parts = splitPlanForDiscord(plan, 1900);
  for (let i = 0; i < parts.length - 1; i++) {
    await channel.send(parts[i]!);
  }
  const lastContent = (parts[parts.length - 1] ?? "(empty plan)").slice(0, 1900);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("plan-approve").setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("plan-reject").setLabel("Reject").setStyle(ButtonStyle.Danger),
  );
  const promptMsg = await channel.send({ content: lastContent, components: [row] }) as Message;

  try {
    const interaction = await promptMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => !i.user.bot,
      time: PERMISSION_TIMEOUT_MS,
    });
    const approved = interaction.customId === "plan-approve";
    await interaction.update({
      content: lastContent + `\n\n→ ${approved ? "✅ Approved" : "❌ Rejected"} by ${interaction.user.username}`,
      components: [],
    });
    if (approved) return { behavior: "allow", updatedInput: p.input };
    return { behavior: "deny", message: "使用者拒絕 plan", interrupt: true };
  } catch {
    await promptMsg.edit({ content: lastContent + "\n\n→ ⏰ Timeout (auto-deny)", components: [] }).catch(() => {});
    return { behavior: "deny", message: `${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s 內無回應`, interrupt: true };
  }
}

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; value?: string; description?: string }>;
  multiSelect?: boolean;
}

async function handleAskUserQuestion(p: PermissionInput): Promise<PermissionResult> {
  const channel = await fetchPermissionChannel();
  const questions = (p.input.questions as AskQuestion[] | undefined) ?? [];
  const collected: Record<string, string> = { ...((p.input.answers as Record<string, string>) ?? {}) };

  for (const q of questions) {
    if (collected[q.question]) continue;
    const opts = (q.options ?? []).slice(0, 25);
    if (opts.length < 2) {
      return { behavior: "deny", message: `AskUserQuestion 選項不足: ${q.question}`, interrupt: true };
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      .setPlaceholder((q.header ?? "選擇答案").slice(0, 100))
      .addOptions(opts.map(o => ({
        label: String(o.label).slice(0, 100),
        value: String(o.value ?? o.label).slice(0, 100),
        description: o.description ? String(o.description).slice(0, 100) : undefined,
      })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const promptText = `❓ **${String(q.header ?? "Question").slice(0, 80)}** (bridge: \`${BRIDGE_LABEL}\`)\n${String(q.question)}`.slice(0, 1900);
    const promptMsg = await channel.send({ content: promptText, components: [row] }) as Message;

    try {
      const interaction = await promptMsg.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i: StringSelectMenuInteraction) => !i.user.bot,
        time: PERMISSION_TIMEOUT_MS,
      });
      const answer = interaction.values[0] ?? "";
      collected[q.question] = answer;
      await interaction.update({
        content: promptText + `\n\n→ ${interaction.user.username}: **${answer}**`,
        components: [],
      });
    } catch {
      await promptMsg.edit({ content: promptText + "\n\n→ ⏰ Timeout", components: [] }).catch(() => {});
      return { behavior: "deny", message: `使用者未在 ${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s 內回答 "${q.question}"`, interrupt: true };
    }
  }

  return { behavior: "allow", updatedInput: { ...p.input, answers: collected } };
}

async function handleGenericPermission(p: PermissionInput): Promise<PermissionResult> {
  const channel = await fetchPermissionChannel();
  const inputPreview = JSON.stringify(p.input, null, 2);
  const truncated = inputPreview.length > 1500 ? inputPreview.slice(0, 1500) + "\n...(truncated)" : inputPreview;
  const content = `🔐 **權限請求** (bridge: \`${BRIDGE_LABEL}\`)\n工具：\`${p.tool_name}\`\n\`\`\`json\n${truncated}\n\`\`\``.slice(0, 1900);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("perm-allow").setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("perm-deny").setLabel("Deny").setStyle(ButtonStyle.Danger),
  );
  const promptMsg = await channel.send({ content, components: [row] }) as Message;

  try {
    const interaction = await promptMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => !i.user.bot,
      time: PERMISSION_TIMEOUT_MS,
    });
    const approved = interaction.customId === "perm-allow";
    await interaction.update({
      content: content + `\n\n→ ${approved ? "✅ Approved" : "❌ Denied"} by ${interaction.user.username}`,
      components: [],
    });
    if (approved) return { behavior: "allow", updatedInput: p.input };
    return { behavior: "deny", message: `使用者拒絕 ${p.tool_name}`, interrupt: true };
  } catch {
    await promptMsg.edit({ content: content + "\n\n→ ⏰ Timeout (auto-deny)", components: [] }).catch(() => {});
    return { behavior: "deny", message: `${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s 內無回應`, interrupt: true };
  }
}

async function runPermissionTool(args: P): Promise<PermissionResult> {
  const tool_name = str(args, "tool_name", true)!;
  const input = (args.input as Record<string, unknown>) ?? {};
  const tool_use_id = str(args, "tool_use_id");
  const p: PermissionInput = { tool_name, input, tool_use_id };

  if (tool_name === "ExitPlanMode") return handleExitPlanMode(p);
  if (tool_name === "AskUserQuestion") return handleAskUserQuestion(p);
  return handleGenericPermission(p);
}

const REQUEST_PERMISSION_TOOL = {
  name: "request_permission",
  description: [
    "處理 Claude CLI 的權限請求（與 --permission-prompt-tool 配合）。",
    "會在 bridge 綁定的 Discord 頻道顯示按鈕讓使用者 Approve/Deny。",
    "ExitPlanMode → 顯示 plan 預覽 + Approve/Reject。",
    "AskUserQuestion → 渲染 select menu 收集答案塞回 updatedInput.answers。",
    "其他 tool → 顯示 tool name + input JSON + Approve/Deny。",
    `${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s 內無回應 → deny + interrupt（中斷整個 turn）。`,
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "請求權限的 tool 名稱" },
      input: { type: "object", description: "tool 的輸入參數" },
      tool_use_id: { type: "string", description: "本次 tool use 的唯一 ID（選填）" },
    },
    required: ["tool_name", "input"],
  },
};

// ── MCP Tool Schema ──────────────────────────────────────────────────────────

const ALL_ACTIONS = [
  // Messaging
  "send", "read", "fetchMessage", "edit", "delete",
  "react", "reactions",
  "threadCreate", "threadList", "threadReply",
  "pinMessage", "unpinMessage", "listPins",
  "searchMessages", "poll",
  // Guild
  "memberInfo", "roleInfo", "roleAdd", "roleRemove",
  "emojiList",
  "channelInfo", "channelList", "channelCreate", "channelEdit", "channelDelete", "channelMove",
  "categoryCreate", "categoryEdit", "categoryDelete",
  "channelPermissionSet", "channelPermissionRemove",
  "eventList", "eventCreate",
  // Moderation
  "timeout", "kick", "ban",
];

const TOOL = {
  name: "discord",
  description: [
    "執行 Discord 操作。",
    "Messaging: send/read/fetchMessage/edit/delete/react/reactions/threadCreate/threadList/threadReply/pinMessage/unpinMessage/listPins/searchMessages/poll",
    "Guild: memberInfo/roleInfo/roleAdd/roleRemove/emojiList/channelInfo/channelList/channelCreate/channelEdit/channelDelete/channelMove/categoryCreate/categoryEdit/categoryDelete/channelPermissionSet/channelPermissionRemove/eventList/eventCreate",
    "Moderation: timeout/kick/ban",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action:     { type: "string", enum: ALL_ACTIONS, description: "要執行的操作" },
      // Common
      channelId:  { type: "string", description: "頻道 ID" },
      to:         { type: "string", description: "channel:<id>（channelId 的替代寫法）" },
      guildId:    { type: "string", description: "伺服器 ID（guild action 必填）" },
      messageId:  { type: "string", description: "訊息 ID" },
      message:    { type: "string", description: "訊息內容" },
      // Messaging
      media:      { type: "string", description: "file:///path/to/file（附件）" },
      replyTo:    { type: "string", description: "回覆目標訊息 ID" },
      emoji:      { type: "string", description: "Emoji（react/reactions 用）" },
      remove:     { type: "boolean", description: "移除 reaction（react 用）" },
      limit:      { type: "number", description: "筆數上限" },
      before:     { type: "string", description: "在此訊息 ID 之前（read 分頁）" },
      after:      { type: "string", description: "在此訊息 ID 之後（read 分頁）" },
      // Thread
      name:       { type: "string", description: "名稱（thread/channel/category/event/emoji）" },
      autoArchiveMinutes: { type: "number", description: "Thread 自動封存分鐘數" },
      // Pin / Search
      content:    { type: "string", description: "搜尋內容（searchMessages 用）" },
      authorId:   { type: "string", description: "作者 ID（searchMessages 用）" },
      // Poll
      question:   { type: "string", description: "投票問題" },
      answers:    { type: "array", items: { type: "string" }, description: "投票選項" },
      durationHours: { type: "number", description: "投票持續時數" },
      allowMultiselect: { type: "boolean", description: "允許多選" },
      // Guild
      userId:     { type: "string", description: "使用者 ID" },
      roleId:     { type: "string", description: "角色 ID" },
      type:       { type: "number", description: "頻道類型（0=text, 2=voice, 4=category, 13=stage, 15=forum）" },
      parentId:   { type: "string", description: "父分類 ID" },
      topic:      { type: "string", description: "頻道主題" },
      position:   { type: "number", description: "排序位置" },
      nsfw:       { type: "boolean", description: "NSFW 標記" },
      rateLimitPerUser: { type: "number", description: "慢速模式秒數" },
      archived:   { type: "boolean", description: "封存狀態" },
      locked:     { type: "boolean", description: "鎖定狀態" },
      autoArchiveDuration: { type: "number", description: "自動封存時間（分鐘）" },
      categoryId: { type: "string", description: "分類 ID（categoryEdit/Delete 用）" },
      // Permission
      targetId:   { type: "string", description: "權限目標 ID（role 或 member）" },
      targetType: { type: "string", enum: ["role", "member"], description: "權限目標類型" },
      allow:      { type: "string", description: "允許的權限位元（bitfield）" },
      deny:       { type: "string", description: "拒絕的權限位元（bitfield）" },
      // Event
      startTime:  { type: "string", description: "開始時間 ISO 8601" },
      endTime:    { type: "string", description: "結束時間 ISO 8601" },
      description:{ type: "string", description: "描述" },
      location:   { type: "string", description: "地點（external event 用）" },
      entityType: { type: "string", enum: ["voice", "stage", "external"], description: "活動類型" },
      // Moderation
      durationMinutes: { type: "number", description: "禁言時長（分鐘），0=解除" },
      reason:     { type: "string", description: "原因（moderation audit log）" },
      deleteMessageDays: { type: "number", description: "刪除訊息天數（ban 用）" },
    },
    required: ["action"],
  },
};

// ── MCP stdio JSON-RPC 2.0 ────────────────────────────────────────────────────

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
          serverInfo: { name: "catclaw-discord", version: "2.0.0" },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        send(id, { tools: [TOOL, REQUEST_PERMISSION_TOOL] });
        break;

      case "tools/call": {
        const p = params as { name: string; arguments: P };
        if (p.name === "request_permission") {
          try {
            const result = await runPermissionTool(p.arguments);
            send(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
          } catch (err) {
            const fallback = { behavior: "deny", message: `permission tool error: ${err instanceof Error ? err.message : String(err)}`, interrupt: true };
            send(id, { content: [{ type: "text", text: JSON.stringify(fallback) }], isError: true });
          }
          break;
        }
        if (p.name !== "discord" && p.name !== "message") {
          sendErr(id, -32601, `Unknown tool: ${p.name}`);
          break;
        }
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

rl.on("close", async () => {
  try { await _client?.destroy(); } catch { /* ignore */ }
  process.exit(0);
});
