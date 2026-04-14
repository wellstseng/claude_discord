/**
 * @file skills/builtin/remind.ts
 * @description 提醒/排程 skill — 動態建立 cron job
 *
 * 觸發：/remind, /reminder, /提醒, /排程, /cron
 *
 * 子命令：
 *   /remind <時間> <內容>        建立一次性提醒（at 排程）
 *   /remind every <間隔> <內容>  建立重複提醒
 *   /remind cron <expr> <內容>   建立 cron 排程
 *   /remind list                 列出目前排程
 *   /remind delete <id|name>     刪除排程
 *
 * 時間格式：
 *   15:55          → 今天 15:55（若已過則明天）
 *   15:55 +1d      → 明天 15:55
 *   2026-04-15     → ISO 日期
 *   30m / 2h / 1d  → 相對時間（從現在起）
 *
 * tier: standard
 */

import { addCronJob, removeCronJob, listCronJobs } from "../../cron.js";
import { config } from "../../core/config.js";
import type { Skill } from "../types.js";

// ── 時間解析 ─────────────────────────────────────────────────────────────────

const RELATIVE_RE = /^(\d+)\s*(m|min|h|hr|hour|d|day|s|sec)s?$/i;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;

function parseTime(input: string): { at: string; label: string } | null {
  const now = new Date();
  const tz = "Asia/Taipei";

  // 相對時間：30m, 2h, 1d
  const rel = input.match(RELATIVE_RE);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("s")) ms = n * 1000;
    else if (unit.startsWith("m")) ms = n * 60_000;
    else if (unit.startsWith("h")) ms = n * 3_600_000;
    else if (unit.startsWith("d")) ms = n * 86_400_000;
    const target = new Date(now.getTime() + ms);
    return { at: target.toISOString(), label: `${n}${rel[2]} 後` };
  }

  // HH:MM 格式
  const hm = input.match(TIME_RE);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h > 23 || m > 59) return null;
    // 用本地時區建立
    const target = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    target.setHours(h, m, 0, 0);
    // 如果已過，排到明天
    const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    if (target <= nowLocal) target.setDate(target.getDate() + 1);
    // 轉回 ISO（加上時區偏移）
    const offset = "+08:00";
    const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${offset}`;
    return { at: iso, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
  }

  // ISO 日期
  if (DATE_TIME_RE.test(input)) {
    const d = new Date(input);
    if (isNaN(d.getTime())) return null;
    return { at: d.toISOString(), label: input };
  }

  return null;
}

// 相對間隔解析（for /remind every）
function parseInterval(input: string): number | null {
  const rel = input.match(RELATIVE_RE);
  if (!rel) return null;
  const n = parseInt(rel[1], 10);
  const unit = rel[2].toLowerCase();
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("m")) return n * 60_000;
  if (unit.startsWith("h")) return n * 3_600_000;
  if (unit.startsWith("d")) return n * 86_400_000;
  return null;
}

// ── Skill 定義 ───────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "remind",
  description: "提醒/排程管理 — 建立、列出、刪除排程",
  tier: "standard",
  trigger: ["/remind", "/reminder", "/提醒", "/排程", "/cron add", "/cron list", "/cron delete"],

  async execute(ctx) {
    const args = ctx.args.trim();

    // /remind list | /cron list
    if (!args || args === "list") {
      return handleList();
    }

    // /remind delete <id|name>
    if (args.startsWith("delete ") || args.startsWith("del ") || args.startsWith("刪除 ")) {
      const target = args.replace(/^(delete|del|刪除)\s+/, "").trim();
      return handleDelete(target);
    }

    // /remind every <interval> <content>
    if (args.startsWith("every ")) {
      const rest = args.slice(6).trim();
      const parts = rest.split(/\s+/);
      if (parts.length < 2) return { text: "用法：`/remind every <間隔> <內容>`\n範例：`/remind every 1h 喝水`", isError: true };
      const interval = parseInterval(parts[0]);
      if (!interval) return { text: `無法解析間隔：\`${parts[0]}\`\n支援格式：30m, 2h, 1d`, isError: true };
      const content = parts.slice(1).join(" ");
      return handleEvery(interval, parts[0], content, ctx.channelId);
    }

    // /remind cron <expr> <content>
    if (args.startsWith("cron ")) {
      const rest = args.slice(5).trim();
      // cron 表達式至少 5 段
      const parts = rest.split(/\s+/);
      if (parts.length < 6) return { text: "用法：`/remind cron <5段expr> <內容>`\n範例：`/remind cron 0 9 * * * 早安`", isError: true };
      const expr = parts.slice(0, 5).join(" ");
      const content = parts.slice(5).join(" ");
      return handleCron(expr, content, ctx.channelId);
    }

    // /remind <時間> <內容>  — 一次性提醒
    const parts = args.split(/\s+/);
    const timeStr = parts[0];
    const content = parts.slice(1).join(" ");

    if (!content) return { text: "用法：`/remind <時間> <內容>`\n範例：`/remind 15:55 開會`\n\n時間格式：`15:55`、`30m`、`2h`、`2026-04-15`\n\n其他：`/remind list`、`/remind delete <名稱>`、`/remind every 1h 喝水`", isError: true };

    const parsed = parseTime(timeStr);
    if (!parsed) return { text: `無法解析時間：\`${timeStr}\`\n支援格式：\`15:55\`、\`30m\`、\`2h\`、\`1d\`、\`2026-04-15\``, isError: true };

    return handleAt(parsed, content, ctx.channelId);
  },
};

// ── 子命令實作 ───────────────────────────────────────────────────────────────

function handleAt(
  parsed: { at: string; label: string },
  content: string,
  channelId: string,
): { text: string } {
  if (!config.cron?.enabled) {
    return { text: "排程服務未啟用。請在 catclaw.json 設定 `cron.enabled: true` 後重啟。" };
  }

  const id = addCronJob({
    name: content.slice(0, 30),
    enabled: true,
    schedule: { kind: "at", at: parsed.at },
    action: { type: "message", channelId, text: `**提醒：** ${content}` },
    deleteAfterRun: true,
  });

  const d = new Date(parsed.at);
  const display = d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  return { text: `已建立提醒：**${content}**\n時間：${display}\nID：\`${id}\`` };
}

function handleEvery(
  intervalMs: number,
  intervalStr: string,
  content: string,
  channelId: string,
): { text: string } {
  if (!config.cron?.enabled) {
    return { text: "排程服務未啟用。請在 catclaw.json 設定 `cron.enabled: true` 後重啟。" };
  }

  const id = addCronJob({
    name: content.slice(0, 30),
    enabled: true,
    schedule: { kind: "every", everyMs: intervalMs },
    action: { type: "message", channelId, text: `**提醒：** ${content}` },
  });

  return { text: `已建立重複提醒：**${content}**\n間隔：每 ${intervalStr}\nID：\`${id}\`\n\n刪除：\`/remind delete ${id}\`` };
}

function handleCron(
  expr: string,
  content: string,
  channelId: string,
): { text: string } {
  if (!config.cron?.enabled) {
    return { text: "排程服務未啟用。請在 catclaw.json 設定 `cron.enabled: true` 後重啟。" };
  }

  const id = addCronJob({
    name: content.slice(0, 30),
    enabled: true,
    schedule: { kind: "cron", expr, tz: "Asia/Taipei" },
    action: { type: "message", channelId, text: `**排程：** ${content}` },
  });

  return { text: `已建立排程：**${content}**\nCron：\`${expr}\`\nID：\`${id}\`\n\n刪除：\`/remind delete ${id}\`` };
}

function handleList(): { text: string } {
  const jobs = listCronJobs();
  if (jobs.length === 0) return { text: "目前沒有排程。" };

  const lines = jobs.map(({ id, entry }) => {
    const sched = entry.schedule.kind === "at"
      ? `一次性 ${new Date(entry.schedule.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}`
      : entry.schedule.kind === "every"
        ? `每 ${Math.round(entry.schedule.everyMs / 60000)}min`
        : `cron \`${entry.schedule.expr}\``;
    const status = entry.enabled === false ? " (停用)" : "";
    return `- **${entry.name}**${status} — ${sched} — \`${id}\``;
  });

  return { text: `**排程列表**（${jobs.length} 個）\n${lines.join("\n")}` };
}

function handleDelete(target: string): { text: string; isError?: boolean } {
  // 先嘗試 ID 精確匹配
  if (removeCronJob(target)) {
    return { text: `已刪除排程：\`${target}\`` };
  }

  // 嘗試名稱模糊匹配
  const jobs = listCronJobs();
  const match = jobs.find(j =>
    j.entry.name.toLowerCase().includes(target.toLowerCase()) ||
    j.id.includes(target.toLowerCase())
  );

  if (match && removeCronJob(match.id)) {
    return { text: `已刪除排程：**${match.entry.name}**（\`${match.id}\`）` };
  }

  return { text: `找不到排程：\`${target}\`\n用 \`/remind list\` 查看所有排程。`, isError: true };
}
