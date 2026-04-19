/**
 * @file skills/builtin/remind.ts → cron skill
 * @description 排程管理 skill — 動態建立/管理 cron job
 *
 * 觸發：/cron, /排程, /remind, /提醒
 *
 * 子命令：
 *   /cron list                                列出所有排程
 *   /cron delete <id|name>                    刪除排程
 *   /cron enable <id>                         啟用排程
 *   /cron disable <id>                        停用排程
 *
 *   /cron add at <time> <action> <content>    一次性排程
 *   /cron add every <interval> <action> <content>  重複排程
 *   /cron add expr <5段cron> <action> <content>    cron 表達式排程
 *
 *   快捷：/cron <time> <content>              等同 /cron add at <time> msg <content>
 *
 * action 類型：
 *   msg <text>            發送訊息到當前頻道
 *   exec <command>        執行 shell 指令（stdout 回報到當前頻道）
 *   claude <prompt>       Claude ACP turn（回覆到當前頻道）
 *   agent <task>          Subagent 執行（完成後通知當前頻道）
 *
 * 時間格式：
 *   15:55          → 今天 15:55（若已過則明天）
 *   15:55 +1d      → 明天 15:55
 *   2026-04-15     → ISO 日期
 *   30m / 2h / 1d  → 相對時間（從現在起）
 *
 * tier: standard
 */

import { addCronJob, removeCronJob, listCronJobs, updateCronJob } from "../../cron.js";
import type { CronJobEntry } from "../../cron.js";
import { config } from "../../core/config.js";
import type { CronAction } from "../../core/config.js";
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
    const target = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    target.setHours(h, m, 0, 0);
    const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    if (target <= nowLocal) target.setDate(target.getDate() + 1);
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

/** 相對間隔解析（for every） */
function parseInterval(input: string): { ms: number; label: string } | null {
  const rel = input.match(RELATIVE_RE);
  if (!rel) return null;
  const n = parseInt(rel[1], 10);
  const unit = rel[2].toLowerCase();
  let ms = 0;
  if (unit.startsWith("s")) ms = n * 1000;
  else if (unit.startsWith("m")) ms = n * 60_000;
  else if (unit.startsWith("h")) ms = n * 3_600_000;
  else if (unit.startsWith("d")) ms = n * 86_400_000;
  return { ms, label: `${n}${rel[2]}` };
}

/** 是否看起來像時間（用於快捷語法偵測） */
function looksLikeTime(s: string): boolean {
  return RELATIVE_RE.test(s) || TIME_RE.test(s) || DATE_TIME_RE.test(s);
}

// ── Action 類型關鍵字 ────────────────────────────────────────────────────────

const ACTION_KEYWORDS = ["msg", "exec", "claude", "agent"] as const;
type ActionKeyword = typeof ACTION_KEYWORDS[number];

function isActionKeyword(s: string): s is ActionKeyword {
  return (ACTION_KEYWORDS as readonly string[]).includes(s.toLowerCase());
}

/** 從 action keyword + content 組合出 CronAction */
function buildAction(keyword: ActionKeyword, content: string, channelId: string): CronAction {
  switch (keyword) {
    case "msg":
      return { type: "message", channelId, text: content };
    case "exec":
      return { type: "exec", command: content, channelId };
    case "claude":
      return { type: "claude-acp", channelId, prompt: content };
    case "agent":
      return { type: "subagent", task: content, notify: `discord:ch:${channelId}` };
  }
}

/** action 類型的顯示名稱 */
function actionLabel(keyword: ActionKeyword): string {
  switch (keyword) {
    case "msg": return "訊息";
    case "exec": return "指令";
    case "claude": return "Claude";
    case "agent": return "Subagent";
  }
}

// ── Skill 定義 ───────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "cron",
  description: "排程管理 — 建立、列出、刪除、啟停排程（支援 msg/exec/claude/agent 動作）",
  tier: "standard",
  trigger: ["/cron", "/排程", "/remind", "/提醒"],

  async execute(ctx) {
    const args = ctx.args.trim();
    const agentId = ctx.agentId;

    // ── 無參數 or list ──
    if (!args || args === "list") {
      return handleList(agentId);
    }

    // ── delete ──
    if (/^(delete|del|刪除)\s+/.test(args)) {
      const target = args.replace(/^(delete|del|刪除)\s+/, "").trim();
      return handleDelete(target, agentId);
    }

    // ── enable / disable ──
    if (/^enable\s+/.test(args)) {
      return handleToggle(args.replace(/^enable\s+/, "").trim(), true, agentId);
    }
    if (/^disable\s+/.test(args)) {
      return handleToggle(args.replace(/^disable\s+/, "").trim(), false, agentId);
    }

    // ── add <schedule> <action> <content> ──
    if (args.startsWith("add ")) {
      return handleAdd(args.slice(4).trim(), ctx.channelId, agentId);
    }

    // ── 快捷語法：/cron <time> <content> → /cron add at <time> msg <content> ──
    const parts = args.split(/\s+/);
    if (looksLikeTime(parts[0])) {
      const content = parts.slice(1).join(" ");
      if (!content) return showUsage();
      return handleAdd(`at ${parts[0]} msg ${content}`, ctx.channelId, agentId);
    }

    return showUsage();
  },
};

// ── add 子命令解析 ──────────────────────────────────────────────────────────

function handleAdd(rest: string, channelId: string, agentId?: string): { text: string; isError?: boolean } {
  if (!config.cron?.enabled) {
    return { text: "排程服務未啟用。請在 catclaw.json 設定 `cron.enabled: true` 後重啟。" };
  }

  const parts = rest.split(/\s+/);
  if (parts.length < 3) return showUsage();

  const scheduleKind = parts[0].toLowerCase();

  // ── at <time> <action> <content> ──
  if (scheduleKind === "at") {
    const timeStr = parts[1];
    const parsed = parseTime(timeStr);
    if (!parsed) return { text: `無法解析時間：\`${timeStr}\`\n支援格式：\`15:55\`、\`30m\`、\`2h\`、\`1d\`、\`2026-04-15\``, isError: true };

    const actionKw = parts[2]?.toLowerCase();
    if (!isActionKeyword(actionKw)) return { text: `未知動作類型：\`${parts[2]}\`\n支援：\`msg\`、\`exec\`、\`claude\`、\`agent\``, isError: true };

    const content = parts.slice(3).join(" ");
    if (!content) return { text: `缺少內容。用法：\`/cron add at ${timeStr} ${actionKw} <內容>\``, isError: true };

    const action = buildAction(actionKw, content, channelId);
    const id = addCronJob({
      name: content.slice(0, 30),
      enabled: true,
      agentId,
      schedule: { kind: "at", at: parsed.at },
      action,
      deleteAfterRun: true,
    });

    const display = new Date(parsed.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    return { text: `已建立排程：**${content.slice(0, 50)}**\n類型：一次性（${actionLabel(actionKw)}）\n時間：${display}\nID：\`${id}\`` };
  }

  // ── every <interval> <action> <content> ──
  if (scheduleKind === "every") {
    const intervalStr = parts[1];
    const interval = parseInterval(intervalStr);
    if (!interval) return { text: `無法解析間隔：\`${intervalStr}\`\n支援格式：30s、5m、2h、1d`, isError: true };

    const actionKw = parts[2]?.toLowerCase();
    if (!isActionKeyword(actionKw)) return { text: `未知動作類型：\`${parts[2]}\`\n支援：\`msg\`、\`exec\`、\`claude\`、\`agent\``, isError: true };

    const content = parts.slice(3).join(" ");
    if (!content) return { text: `缺少內容。用法：\`/cron add every ${intervalStr} ${actionKw} <內容>\``, isError: true };

    const action = buildAction(actionKw, content, channelId);
    const id = addCronJob({
      name: content.slice(0, 30),
      enabled: true,
      agentId,
      schedule: { kind: "every", everyMs: interval.ms },
      action,
    });

    return { text: `已建立排程：**${content.slice(0, 50)}**\n類型：重複（${actionLabel(actionKw)}）\n間隔：每 ${interval.label}\nID：\`${id}\`\n\n停用：\`/cron disable ${id}\`\n刪除：\`/cron delete ${id}\`` };
  }

  // ── expr <5段cron> <action> <content> ──
  if (scheduleKind === "expr") {
    if (parts.length < 8) return { text: "用法：`/cron add expr <分> <時> <日> <月> <週> <action> <內容>`\n範例：`/cron add expr 0 9 * * * msg 早安`", isError: true };
    const expr = parts.slice(1, 6).join(" ");
    const actionKw = parts[6]?.toLowerCase();
    if (!isActionKeyword(actionKw)) return { text: `未知動作類型：\`${parts[6]}\`\n支援：\`msg\`、\`exec\`、\`claude\`、\`agent\``, isError: true };

    const content = parts.slice(7).join(" ");
    if (!content) return { text: `缺少內容。用法：\`/cron add expr ${expr} ${actionKw} <內容>\``, isError: true };

    const action = buildAction(actionKw, content, channelId);
    const id = addCronJob({
      name: content.slice(0, 30),
      enabled: true,
      agentId,
      schedule: { kind: "cron", expr, tz: "Asia/Taipei" },
      action,
    });

    return { text: `已建立排程：**${content.slice(0, 50)}**\n類型：Cron（${actionLabel(actionKw)}）\n表達式：\`${expr}\`\nID：\`${id}\`\n\n停用：\`/cron disable ${id}\`\n刪除：\`/cron delete ${id}\`` };
  }

  return showUsage();
}

// ── list ────────────────────────────────────────────────────────────────────

function handleList(agentId?: string): { text: string } {
  const jobs = listCronJobs(agentId);
  if (jobs.length === 0) {
    // 揭露其他 agent 的 job 存在，避免誤判成「整個系統沒有排程」而手動亂寫 JSON
    if (agentId !== undefined) {
      const totalCount = listCronJobs().length;
      if (totalCount > 0) {
        return { text: `你（agent \`${agentId}\`）目前沒有排程。\n（系統內共 ${totalCount} 個排程屬於其他 agent，本指令依設計只顯示自己的；不要直接編輯 cron-jobs.json）` };
      }
    }
    return { text: "目前沒有排程。" };
  }

  const lines = jobs.map(({ id, entry }) => {
    const sched = formatSchedule(entry);
    const actionType = entry.action.type === "message" ? "msg"
      : entry.action.type === "exec" ? "exec"
      : entry.action.type === "claude-acp" ? "claude"
      : "agent";
    const status = entry.enabled === false ? " ⏸" : "";
    const lastStatus = entry.lastResult === "error" ? " ❌" : entry.lastResult === "success" ? " ✅" : "";
    return `- **${entry.name}**${status}${lastStatus} — ${sched} — \`${actionType}\` — \`${id}\``;
  });

  return { text: `**排程列表**（${jobs.length} 個）\n${lines.join("\n")}` };
}

function formatSchedule(entry: CronJobEntry): string {
  if (entry.schedule.kind === "at") {
    return `一次性 ${new Date(entry.schedule.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}`;
  }
  if (entry.schedule.kind === "every") {
    const ms = entry.schedule.everyMs;
    if (ms >= 86_400_000) return `每 ${Math.round(ms / 86_400_000)}d`;
    if (ms >= 3_600_000) return `每 ${Math.round(ms / 3_600_000)}h`;
    if (ms >= 60_000) return `每 ${Math.round(ms / 60_000)}m`;
    return `每 ${Math.round(ms / 1000)}s`;
  }
  return `cron \`${entry.schedule.expr}\``;
}

// ── delete ──────────────────────────────────────────────────────────────────

function handleDelete(target: string, agentId?: string): { text: string; isError?: boolean } {
  if (removeCronJob(target)) {
    return { text: `已刪除排程：\`${target}\`` };
  }

  // 模糊匹配（只在自己 agent 的 job 裡找）
  const jobs = listCronJobs(agentId);
  const match = jobs.find(j =>
    j.entry.name.toLowerCase().includes(target.toLowerCase()) ||
    j.id.includes(target.toLowerCase())
  );

  if (match && removeCronJob(match.id)) {
    return { text: `已刪除排程：**${match.entry.name}**（\`${match.id}\`）` };
  }

  return { text: `找不到排程：\`${target}\`\n用 \`/cron list\` 查看所有排程。`, isError: true };
}

// ── enable / disable ────────────────────────────────────────────────────────

function handleToggle(target: string, enabled: boolean, agentId?: string): { text: string; isError?: boolean } {
  const jobs = listCronJobs(agentId);
  const match = jobs.find(j => j.id === target)
    ?? jobs.find(j =>
      j.entry.name.toLowerCase().includes(target.toLowerCase()) ||
      j.id.includes(target.toLowerCase())
    );

  if (!match) {
    return { text: `找不到排程：\`${target}\`\n用 \`/cron list\` 查看所有排程。`, isError: true };
  }

  updateCronJob(match.id, { enabled });
  const verb = enabled ? "啟用" : "停用";
  return { text: `已${verb}排程：**${match.entry.name}**（\`${match.id}\`）` };
}

// ── 用法說明 ────────────────────────────────────────────────────────────────

function showUsage(): { text: string; isError: true } {
  return {
    text: `**排程管理** — \`/cron\`

**建立排程：**
\`/cron add at <時間> <動作> <內容>\` — 一次性
\`/cron add every <間隔> <動作> <內容>\` — 重複
\`/cron add expr <cron五段> <動作> <內容>\` — Cron 表達式

**快捷：**
\`/cron <時間> <內容>\` — 等同 \`/cron add at <時間> msg <內容>\`

**動作類型：**
\`msg\` 發送訊息 | \`exec\` 執行指令 | \`claude\` Claude 對話 | \`agent\` Subagent

**管理：**
\`/cron list\` — 列出排程
\`/cron delete <id>\` — 刪除
\`/cron enable <id>\` — 啟用
\`/cron disable <id>\` — 停用

**時間格式：** \`15:55\`、\`30m\`、\`2h\`、\`1d\`、\`2026-04-15\`
**Cron：** \`/cron add expr 0 9 * * * msg 早安\`

**範例：**
\`/cron 30m 開會\`
\`/cron add every 6h exec git pull\`
\`/cron add expr 0 9 * * 1 claude 整理本週 PR\``,
    isError: true,
  };
}
