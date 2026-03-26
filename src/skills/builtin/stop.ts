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

// ── 全域 AbortController 登錄表（session → controller） ───────────────────────
// agent-loop 執行時呼叫 registerTurnAbort / clearTurnAbort 管理

const _turnAbortMap = new Map<string, AbortController>();

export function registerTurnAbort(sessionKey: string, controller: AbortController): void {
  _turnAbortMap.set(sessionKey, controller);
}

export function clearTurnAbort(sessionKey: string): void {
  _turnAbortMap.delete(sessionKey);
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

    // 回退 session
    const snapshotStore = getSessionSnapshotStore();
    const snapshot = snapshotStore?.get(sessionKey, turnCount);

    if (snapshot) {
      session.messages = snapshot.messages;
      session.turnCount = Math.max(0, turnCount - 1);
      snapshotStore!.delete(sessionKey, turnCount);
      return { text: `🛑 已中斷，session 還原至 turn #${turnCount} 前。` };
    }

    return { text: "🛑 已中斷，但找不到快照，session 未還原。" };
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
      // 清空排隊（從 session manager 找 queue）
      // SessionManager 沒有對外暴露 clear queue API，需在此呼叫 dequeueTurn 直到空
      // 目前設計中 queue 不支援外部 clear，回傳提示
      return { text: "ℹ️ 目前 queue clear 功能待實作（需 SessionManager.clearQueue API）。" };
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

// ── exports（registry 支援 skill + skills 兩種格式）────────────────────────

export const skill = stopSkill;
export const skills = [queueSkill, rollbackSkill];
