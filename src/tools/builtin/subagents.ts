/**
 * @file tools/builtin/subagents.ts
 * @description subagents — 管理子 agent（list / kill / steer / wait）
 *
 * LLM 可用此 tool 查詢、終止、轉向、等待子 agent。
 */

import type { Tool, ToolContext } from "../types.js";
import { getSubagentRegistry } from "../../core/subagent-registry.js";
import { getPlatformSessionManager } from "../../core/platform.js";
import { log } from "../../logger.js";

export const tool: Tool = {
  name: "subagents",
  description: "管理子 agent：list（列出）/ kill（終止）/ steer（轉向）/ wait（等待完成）",
  tier: "standard",
  parameters: {
    type: "object",
    properties: {
      action:       { type: "string",  description: "list | kill | steer | wait" },
      runId:        { type: "string",  description: "目標 runId（kill/steer/wait 用；kill 省略 = kill all）" },
      message:      { type: "string",  description: "steer 時注入的訊息" },
      timeoutMs:    { type: "number",  description: "wait 最長等待毫秒（預設 60000）" },
      recentMinutes:{ type: "number",  description: "list 只顯示最近 N 分鐘（預設全部）" },
    },
    required: ["action"],
  },

  async execute(params, ctx: ToolContext) {
    const registry = getSubagentRegistry();
    if (!registry) return { error: "SubagentRegistry 尚未初始化" };

    const action = String(params["action"] ?? "").trim();
    const runId  = params["runId"] ? String(params["runId"]) : undefined;

    switch (action) {
      case "list": {
        const recent = typeof params["recentMinutes"] === "number" ? params["recentMinutes"] : undefined;
        const records = registry.listByParent(ctx.sessionId, recent);
        if (records.length === 0) return { result: "（目前無子 agent 記錄）" };
        const lines = records.map(r => {
          const dur = r.endedAt ? `${Math.round((r.endedAt - r.createdAt) / 1000)}s` : `${Math.round((Date.now() - r.createdAt) / 1000)}s+`;
          return `• [${r.status}] ${r.label ?? r.runId.slice(0, 8)} | ${r.runtime} | ${dur} | runId:${r.runId}`;
        });
        return { result: lines.join("\n") };
      }

      case "kill": {
        if (runId) {
          const ok = registry.kill(runId);
          return { result: ok ? `✅ killed ${runId}` : `❌ 找不到或已結束：${runId}` };
        } else {
          const count = registry.killAll(ctx.sessionId);
          return { result: `✅ killed ${count} 個子 agent` };
        }
      }

      case "steer": {
        if (!runId) return { error: "steer 需要指定 runId" };
        const message = params["message"] ? String(params["message"]) : undefined;
        if (!message) return { error: "steer 需要指定 message" };

        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        if (record.status !== "running") return { error: `子 agent 已結束（status=${record.status}）` };

        // 注入訊息到子 session（子 loop 下一輪自然讀到）
        try {
          const sessionManager = getPlatformSessionManager();
          sessionManager.addMessages(record.childSessionKey, [
            { role: "user", content: `[父 agent 轉向指令]\n${message}` },
          ]);
          log.info(`[subagents:steer] 注入至 ${record.childSessionKey}`);
          return { result: `✅ 轉向訊息已注入子 agent ${runId.slice(0, 8)}` };
        } catch (err) {
          return { error: `steer 失敗：${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case "wait": {
        if (!runId) return { error: "wait 需要指定 runId" };
        const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : 60_000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          const record = registry.get(runId);
          if (!record) return { error: `找不到 runId：${runId}` };
          if (record.status !== "running") {
            if (record.status === "completed") {
              return { result: { status: "completed", result: record.result ?? "", sessionKey: record.childSessionKey, turns: record.turns ?? 0 } };
            } else if (record.status === "timeout") {
              return { result: { status: "timeout", result: null } };
            } else {
              return { result: { status: record.status, error: record.error ?? "" } };
            }
          }
          await new Promise(r => setTimeout(r, 500));
        }

        return { result: { status: "timeout", result: null } };
      }

      default:
        return { error: `未知 action：${action}。可用：list / kill / steer / wait` };
    }
  },
};
