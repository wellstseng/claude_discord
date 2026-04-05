/**
 * @file tools/builtin/task-manage.ts
 * @description task_manage — 結構化任務追蹤（create/update/list/get 合一）
 *
 * 單一 tool 四種 action，避免 tool 數量膨脹。
 * Per-session 任務列表，支援 status、dependencies（blocks/blockedBy）。
 */

import { log } from "../../logger.js";
import { getTaskStore } from "../../core/task-store.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import type { TaskStatus } from "../../core/task-store.js";

export const tool: Tool = {
  name: "task_manage",
  description: [
    "管理結構化任務列表。action: create | update | list | get | delete。",
    "create：建立任務（subject + description），回傳 task id。",
    "update：更新任務（status: pending/in_progress/completed，addBlocks/addBlockedBy 設定依賴）。",
    "list：列出所有任務（可選 status 篩選）。",
    "get：查詢單一任務詳情。",
    "delete：刪除任務。",
  ].join(" "),
  tier: "standard",
  deferred: true,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      action:      { type: "string",  description: "create | update | list | get | delete" },
      taskId:      { type: "string",  description: "任務 ID（update/get/delete 必須）" },
      subject:     { type: "string",  description: "任務標題（create 必須，update 可選）" },
      description: { type: "string",  description: "任務描述（create/update 可選）" },
      status:      { type: "string",  description: "pending | in_progress | completed（update 用）" },
      addBlocks:   { type: "array",   description: "此任務阻擋的任務 ID 列表" },
      addBlockedBy:{ type: "array",   description: "阻擋此任務的任務 ID 列表" },
      filterStatus:{ type: "string",  description: "list 篩選狀態" },
    },
    required: ["action"],
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params["action"] ?? "").trim();
    const store = getTaskStore(ctx.sessionId);

    switch (action) {
      case "create": {
        const subject = String(params["subject"] ?? "").trim();
        if (!subject) return { error: "subject 不能為空" };
        const description = params["description"] ? String(params["description"]) : undefined;
        const task = store.create(subject, description);
        log.debug(`[task-manage] created #${task.id}: ${subject}`);
        return { result: { message: `Task #${task.id} created`, task } };
      }

      case "update": {
        const taskId = String(params["taskId"] ?? "").trim();
        if (!taskId) return { error: "taskId 不能為空" };
        const updates: Parameters<typeof store.update>[1] = {};
        if (params["subject"]) updates.subject = String(params["subject"]);
        if (params["description"]) updates.description = String(params["description"]);
        if (params["status"]) updates.status = String(params["status"]) as TaskStatus;
        if (Array.isArray(params["addBlocks"])) updates.addBlocks = params["addBlocks"].map(String);
        if (Array.isArray(params["addBlockedBy"])) updates.addBlockedBy = params["addBlockedBy"].map(String);
        const task = store.update(taskId, updates);
        if (!task) return { error: `找不到 task #${taskId}` };
        log.debug(`[task-manage] updated #${taskId}: status=${task.status}`);
        return { result: { message: `Task #${taskId} updated`, task } };
      }

      case "list": {
        const filterStatus = params["filterStatus"] ? String(params["filterStatus"]) as TaskStatus : undefined;
        const tasks = store.list({ status: filterStatus });
        const summary = tasks.map(t => {
          const statusIcon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
          const deps = t.blockedBy.length > 0 ? ` (blocked by #${t.blockedBy.join(",#")})` : "";
          return `${statusIcon} #${t.id} [${t.status}] ${t.subject}${deps}`;
        }).join("\n");
        // Emit task:ui event for Discord Components v2 rendering
        if (tasks.length > 0 && ctx.channelId) {
          ctx.eventBus.emit("task:ui", ctx.channelId, tasks.map(t => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            description: t.description,
            blockedBy: t.blockedBy,
          })));
        }
        return { result: { total: tasks.length, tasks, summary } };
      }

      case "get": {
        const taskId = String(params["taskId"] ?? "").trim();
        if (!taskId) return { error: "taskId 不能為空" };
        const task = store.get(taskId);
        if (!task) return { error: `找不到 task #${taskId}` };
        return { result: task };
      }

      case "delete": {
        const taskId = String(params["taskId"] ?? "").trim();
        if (!taskId) return { error: "taskId 不能為空" };
        const deleted = store.delete(taskId);
        if (!deleted) return { error: `找不到 task #${taskId}` };
        log.debug(`[task-manage] deleted #${taskId}`);
        return { result: { message: `Task #${taskId} deleted` } };
      }

      default:
        return { error: `未知 action: ${action}。可用：create | update | list | get | delete` };
    }
  },
};
