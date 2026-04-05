/**
 * @file core/task-ui.ts
 * @description Task UI — Discord Components v2 rendering + button interaction handler
 *
 * Listens for "task:ui" events from eventBus and sends Discord messages
 * with ActionRow buttons for task state transitions.
 * Also exports the button interaction handler for discord.ts.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type ButtonInteraction } from "discord.js";
import { log } from "../logger.js";
import { getTaskStore } from "./task-store.js";
import type { TaskStatus } from "./task-store.js";
import type { TaskUiPayload } from "./event-bus.js";
import { eventBus } from "./event-bus.js";

// ── Discord Client 引用 ────────────────────────────────────────────────────

let _client: Client | null = null;

export function setTaskUiDiscordClient(client: Client): void {
  _client = client;
}

// ── Button ID 格式 ──────────────────────────────────────────────────────────

// Format: task_{action}_{sessionId}_{taskId}
// sessionId 用於找到正確的 TaskStore

const TASK_BUTTON_PREFIX = "task_";

function makeButtonId(action: string, sessionId: string, taskId: string): string {
  return `${TASK_BUTTON_PREFIX}${action}_${sessionId}_${taskId}`;
}

export function parseTaskButtonId(customId: string): { action: string; sessionId: string; taskId: string } | null {
  if (!customId.startsWith(TASK_BUTTON_PREFIX)) return null;
  const parts = customId.slice(TASK_BUTTON_PREFIX.length).split("_");
  if (parts.length < 3) return null;
  // action is first, sessionId could contain underscores, taskId is last
  const action = parts[0];
  const taskId = parts[parts.length - 1];
  const sessionId = parts.slice(1, -1).join("_");
  return { action, sessionId, taskId };
}

// ── Components 生成 ─────────────────────────────────────────────────────────

function buildTaskRow(task: TaskUiPayload, sessionId: string): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const buttons: ButtonBuilder[] = [];

  if (task.status !== "in_progress") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(makeButtonId("progress", sessionId, task.id))
        .setLabel("🔄 In Progress")
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (task.status !== "completed") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(makeButtonId("complete", sessionId, task.id))
        .setLabel("✅ Complete")
        .setStyle(ButtonStyle.Success),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(makeButtonId("delete", sessionId, task.id))
      .setLabel("🗑️ Delete")
      .setStyle(ButtonStyle.Danger),
  );

  row.addComponents(...buttons);
  return row;
}

function buildTaskMessage(tasks: TaskUiPayload[], sessionId: string): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const lines = tasks.map(t => {
    const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
    const deps = t.blockedBy.length > 0 ? ` _(blocked by #${t.blockedBy.join(",#")})_` : "";
    return `${icon} **#${t.id}** [${t.status}] ${t.subject}${deps}`;
  });

  // Discord allows max 5 ActionRows per message, each with max 5 buttons
  // Show buttons for first 5 non-completed tasks
  const actionable = tasks.filter(t => t.status !== "completed").slice(0, 5);
  const components = actionable.map(t => buildTaskRow(t, sessionId));

  return {
    content: `**📋 Tasks (${tasks.length})**\n${lines.join("\n")}`,
    components,
  };
}

// ── EventBus Listener ───────────────────────────────────────────────────────

// Map channelId → sessionId for button handler to find the right TaskStore
const _channelSessionMap = new Map<string, string>();

export function registerTaskUiListener(sessionIdResolver: (channelId: string) => string | undefined): void {
  eventBus.on("task:ui", (channelId, tasks) => {
    if (!_client || tasks.length === 0) return;

    const sessionId = sessionIdResolver(channelId);
    if (!sessionId) {
      log.debug("[task-ui] No session found for channel, skipping UI");
      return;
    }

    _channelSessionMap.set(channelId, sessionId);

    const msg = buildTaskMessage(tasks, sessionId);

    const channel = _client.channels.cache.get(channelId);
    if (!channel || !("send" in channel)) return;

    void (channel as any).send({
      content: msg.content,
      components: msg.components,
    }).catch((err: Error) => {
      log.warn(`[task-ui] Failed to send task UI: ${err.message}`);
    });
  });

  log.info("[task-ui] EventBus listener registered");
}

// ── Button Interaction Handler ──────────────────────────────────────────────

const ACTION_TO_STATUS: Record<string, TaskStatus> = {
  progress: "in_progress",
  complete: "completed",
};

export async function handleTaskButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseTaskButtonId(interaction.customId);
  if (!parsed) return false;

  const { action, sessionId, taskId } = parsed;
  const store = getTaskStore(sessionId);

  if (action === "delete") {
    const deleted = store.delete(taskId);
    if (!deleted) {
      await interaction.update({ content: `❌ Task #${taskId} not found`, components: [] }).catch(() => {});
      return true;
    }
    await interaction.update({
      content: `🗑️ Task #${taskId} deleted`,
      components: [],
    }).catch(() => {});
    return true;
  }

  const newStatus = ACTION_TO_STATUS[action];
  if (!newStatus) return false;

  const task = store.update(taskId, { status: newStatus });
  if (!task) {
    await interaction.update({ content: `❌ Task #${taskId} not found`, components: [] }).catch(() => {});
    return true;
  }

  // Rebuild the full task list UI
  const allTasks = store.list();
  const uiPayload: TaskUiPayload[] = allTasks.map(t => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    description: t.description,
    blockedBy: t.blockedBy,
  }));

  if (uiPayload.length === 0) {
    await interaction.update({ content: "📋 No tasks remaining", components: [] }).catch(() => {});
  } else {
    const msg = buildTaskMessage(uiPayload, sessionId);
    await interaction.update({ content: msg.content, components: msg.components }).catch(() => {});
  }

  log.debug(`[task-ui] Task #${taskId} → ${newStatus} via button`);
  return true;
}
