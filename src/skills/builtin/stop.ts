/**
 * @file skills/builtin/stop.ts
 * @description /stop, /queue, /rollback skills
 *
 * /stop     — 強制中斷當前 turn + 自動回退 session
 * /queue    — 查看 TurnQueue 狀態
 * /queue clear — 清空排隊（不中斷當前）
 * /rollback — 手動還原 CE 壓縮（最近可用快照）
 * /rollback --list — 列出可用快照
 */

import type { Skill } from "../types.js";
import { getPlatformSessionManager } from "../../core/platform.js";
import { getSessionSnapshotStore } from "../../core/session-snapshot.js";
import { getTraceStore } from "../../core/message-trace.js";

// ── 全域 AbortController 登錄表（session → controller） ───────────────────────
// agent-loop 執行時呼叫 registerTurnAbort / clearTurnAbort 管理

const _turnAbortMap = new Map<string, AbortController>();

export function registerTurnAbort(sessionKey: string, controller: AbortController): void {
  _turnAbortMap.set(sessionKey, controller);
}

export function clearTurnAbort(sessionKey: string): void {
  _turnAbortMap.delete(sessionKey);
}

/** 是否有正在執行的 turn（用於中途插隊判斷） */
export function hasTurnRunning(sessionKey: string): boolean {
  return _turnAbortMap.has(sessionKey);
}

/**
 * 中途中斷正在執行的 turn（不做 session rollback）。
 * 用於 interruptOnNewMessage 場景，讓新訊息插隊立刻執行。
 */
export function abortRunningTurn(sessionKey: string): boolean {
  const controller = _turnAbortMap.get(sessionKey);
  if (!controller) return false;
  controller.abort();
  _turnAbortMap.delete(sessionKey);
  return true;
}

// ── /stop ────────────────────────────────────────────────────────────────────

export const stopSkill: Skill = {
  name: "stop",
  description: "強制中斷當前 turn，自動回退 session 到本次前的狀態",
  tier: "standard",
  trigger: ["/stop"],

  async execute({ channelId }) {
    // 尋找此頻道的 session key
    const sessionManager = getPlatformSessionManager();
    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === channelId);

    if (!session) {
      return { text: "⚠️ 找不到此頻道的 session，可能無進行中的 turn。" };
    }

    const { sessionKey, turnCount } = session;

    // 中斷 agentLoop
    const controller = _turnAbortMap.get(sessionKey);
    if (controller) {
      controller.abort();
      _turnAbortMap.delete(sessionKey);
    } else {
      return { text: "⚠️ 目前沒有進行中的 turn，不需要中斷。" };
    }

    // 清空排隊等待的 turn（避免下一個排隊 turn 自動繼續執行）
    const queuedCount = sessionManager.clearQueue(sessionKey);

    // 回退 session
    const snapshotStore = getSessionSnapshotStore();
    const snapshot = snapshotStore?.get(sessionKey, turnCount);
    const queueNote = queuedCount > 0 ? `，已取消 ${queuedCount} 條排隊` : "";

    if (snapshot) {
      session.messages = snapshot.messages;
      session.turnCount = Math.max(0, turnCount - 1);
      snapshotStore!.delete(sessionKey, turnCount);
      return { text: `🛑 已中斷，session 還原至 turn #${turnCount} 前${queueNote}。` };
    }

    return { text: `🛑 已中斷，但找不到快照，session 未還原${queueNote}。` };
  },
};

// ── /queue ────────────────────────────────────────────────────────────────────

export const queueSkill: Skill = {
  name: "queue",
  description: "查看 TurnQueue 狀態（幾條排隊）",
  tier: "standard",
  trigger: ["/queue"],

  async execute({ channelId, args }) {
    const sessionManager = getPlatformSessionManager();
    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === channelId);

    if (!session) {
      return { text: "⚠️ 找不到此頻道的 session。" };
    }

    if (args.trim().toLowerCase() === "clear") {
      const count = sessionManager.clearQueue(session.sessionKey);
      return { text: count > 0
        ? `✅ 已取消 ${count} 條排隊中的 turn。`
        : "ℹ️ 目前沒有等待中的 turn。"
      };
    }

    const depth = sessionManager.getQueueDepth(session.sessionKey);
    return { text: `📋 Turn Queue：session=${session.sessionKey} 排隊中=${depth} 條` };
  },
};

// ── /rollback ────────────────────────────────────────────────────────────────

export const rollbackSkill: Skill = {
  name: "rollback",
  description: "手動還原 CE 壓縮前的 session 狀態（/rollback --list 列出可用快照）",
  tier: "standard",
  trigger: ["/rollback"],

  async execute({ channelId, args }) {
    const sessionManager = getPlatformSessionManager();
    const snapshotStore = getSessionSnapshotStore();

    if (!snapshotStore) {
      return { text: "⚠️ SessionSnapshotStore 尚未初始化。", isError: true };
    }

    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === channelId);
    if (!session) {
      return { text: "⚠️ 找不到此頻道的 session。" };
    }

    const { sessionKey } = session;
    const snapshots = snapshotStore.list(sessionKey).filter(s => s.ceApplied);

    if (args.includes("--list")) {
      if (snapshots.length === 0) return { text: "📋 無可用的 CE 壓縮快照。" };
      const lines = snapshots.map(s => `turn ${s.turnIndex}（${s.snapshotAt}）`).join("\n");
      return { text: `📋 可用快照：\n${lines}` };
    }

    // 取最近一個 CE 快照
    const snap = snapshots[0];
    if (!snap) {
      return { text: "ℹ️ 無可用的 CE 壓縮快照（只有 CE 壓縮觸發時才保留）。" };
    }

    session.messages = snap.messages;
    snapshotStore.delete(sessionKey, snap.turnIndex);

    return { text: `↩️ 已還原 session 至 turn #${snap.turnIndex} 前（CE 壓縮前狀態）。` };
  },
};

// ── /clear ────────────────────────────────────────────────────────────────────

export const clearSkill: Skill = {
  name: "clear",
  description: "清除當前頻道的 session 歷史（messages）。`/clear all` 連 trace 一起清；預設保留 trace（30 天 TTL 自動滾動）。",
  tier: "standard",
  trigger: ["/clear"],

  async execute({ channelId, args }) {
    const sessionManager = getPlatformSessionManager();
    const sessions = sessionManager.list();
    const session = sessions.find(s => s.channelId === channelId);

    if (!session) {
      return { text: "ℹ️ 此頻道尚無 session 歷史。" };
    }

    const clearTrace = args.trim().toLowerCase() === "all";
    const msgCount = sessionManager.clearMessages(session.sessionKey);
    const tracesDeleted = clearTrace ? (getTraceStore()?.deleteBySession(session.sessionKey) ?? 0) : 0;

    if (clearTrace) {
      return { text: `🧹 Session + Trace 已清除（${msgCount} 條訊息、${tracesDeleted} 筆 trace 已刪除）。` };
    }
    return { text: `🧹 Session 已清除（${msgCount} 條訊息）。Trace 保留（用 \`/clear all\` 連 trace 一起清）。` };
  },
};

// ── exports（registry 支援 skill + skills 兩種格式）────────────────────────

export const skill = stopSkill;
export const skills = [queueSkill, rollbackSkill, clearSkill];
