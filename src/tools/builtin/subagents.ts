/**
 * @file tools/builtin/subagents.ts
 * @description subagents — 管理子 agent（list / kill / steer / wait）
 *
 * LLM 可用此 tool 查詢、終止、轉向、等待子 agent。
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "../types.js";
import { getSubagentRegistry } from "../../core/subagent-registry.js";
import { getPlatformSessionManager, getPlatformPermissionGate, getPlatformToolRegistry, getPlatformSafetyGuard } from "../../core/platform.js";
import { log } from "../../logger.js";
import { MessageTrace } from "../../core/message-trace.js";

export const tool: Tool = {
  name: "subagents",
  description: "管理子 agent：list / kill / steer（轉向 running agent）/ wait / status / resume（喚醒 keepSession agent）/ send_message（續接已完成的 agent，注入後續指令並背景執行）",
  tier: "standard",
  deferred: true,
  resultTokenCap: 500,
  parameters: {
    type: "object",
    properties: {
      action:       { type: "string",  description: "list | kill | steer | wait | status | resume | send_message" },
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

      case "resume": {
        // 喚醒 keepSession:true 的已完成子 agent
        if (!runId) return { error: "resume 需要指定 runId" };
        const message = params["message"] ? String(params["message"]) : undefined;
        if (!message) return { error: "resume 需要指定 message（注入訊息）" };

        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        if (!record.keepSession) return { error: `該子 agent 未啟用 keepSession，無法喚醒` };
        if (record.status === "running") return { error: `子 agent 仍在執行中，請用 steer` };
        if (record.status === "killed") return { error: `子 agent 已 killed，無法喚醒` };

        // 注入喚醒訊息到子 session
        const sessionManager = getPlatformSessionManager();
        sessionManager.addMessages(record.childSessionKey, [
          { role: "user", content: `[喚醒]\n${message}` },
        ]);

        // 重置 registry 狀態
        record.status = "running";
        record.endedAt = undefined;
        record.result = undefined;
        record.error = undefined;
        record.abortController = new AbortController();

        log.info(`[subagents:resume] 喚醒 runId=${runId} childSession=${record.childSessionKey}`);

        // 背景重跑 agentLoop（動態 import 避免循環依賴）
        import("../../core/agent-loop.js").then(async ({ agentLoop }) => {
          const permissionGate = getPlatformPermissionGate();
          const toolRegistry = getPlatformToolRegistry();
          const safetyGuard = getPlatformSafetyGuard();
          const { getProviderRegistry } = await import("../../providers/registry.js");
          const { eventBus } = await import("../../core/event-bus.js");
          const provider = getProviderRegistry()?.resolve();
          if (!provider) { registry.fail(runId!, "找不到 provider"); return; }

          // Trace 建立（resume subagent）
          const resumeTrace = MessageTrace.create(randomUUID(), record!.childSessionKey, record!.accountId, "subagent");
          resumeTrace.recordInbound({ text: message, attachments: 0 });

          let fullText = ""; let turns = 0;
          const loopGen = agentLoop(message, {
            platform: "subagent",
            channelId: record!.childSessionKey,
            accountId: record!.accountId,
            provider,
            allowSpawn: false,
            _sessionKeyOverride: record!.childSessionKey,
            signal: record!.abortController.signal,
            trace: resumeTrace,
          }, { sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus });

          try {
            for await (const evt of loopGen) {
              if (evt.type === "text_delta") fullText += evt.text;
              if (evt.type === "done") { turns = evt.turnCount; break; }
              if (evt.type === "error") throw new Error(evt.message);
            }
            registry.complete(runId!, fullText, turns);
            log.info(`[subagents:resume] 完成 runId=${runId}`);
            // EventBus 通知 parent
            eventBus.emit("subagent:completed", record!.parentSessionKey, record!.runId, record!.label ?? record!.task.slice(0, 60), fullText);
            const { sendSubagentNotification } = await import("../../core/subagent-discord-bridge.js");
            await sendSubagentNotification(record!);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            registry.fail(runId!, msg);
            log.warn(`[subagents:resume] 失敗 runId=${runId} err=${msg}`);
            eventBus.emit("subagent:failed", record!.parentSessionKey, record!.runId, record!.label ?? record!.task.slice(0, 60), msg);
          }
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[subagents:resume] 動態 import 失敗：${msg}`);
        });

        return { result: { status: "resuming", runId: record.runId, childSessionKey: record.childSessionKey } };
      }

      case "send_message": {
        // SendMessage 續接：對已完成（keepSession）的 child agent 發後續指令
        // 與 resume 相同邏輯，但語意更直覺（Claude Code 的 SendMessage 概念）
        if (!runId) return { error: "send_message 需要指定 runId" };
        const msg = params["message"] ? String(params["message"]) : undefined;
        if (!msg) return { error: "send_message 需要指定 message" };

        const rec = registry.get(runId);
        if (!rec) return { error: `找不到 runId：${runId}` };

        // running → 用 steer 注入
        if (rec.status === "running") {
          const sessionManager = getPlatformSessionManager();
          sessionManager.addMessages(rec.childSessionKey, [
            { role: "user", content: `[續接指令]\n${msg}` },
          ]);
          return { result: `✅ 訊息已注入 running agent ${runId.slice(0, 8)}` };
        }

        // completed/failed → keepSession 才能續接
        if (!rec.keepSession) return { error: `該子 agent 未啟用 keepSession，無法續接` };
        if (rec.status === "killed") return { error: `子 agent 已 killed，無法續接` };

        // 重用 resume 邏輯
        params["action"] = "resume";
        return this.execute(params, ctx);
      }

      case "status": {
        if (!runId) return { error: "status 需要指定 runId" };
        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        const durationMs = record.endedAt
          ? record.endedAt - record.createdAt
          : Date.now() - record.createdAt;
        return {
          result: {
            runId: record.runId,
            status: record.status,
            label: record.label,
            task: record.task,
            runtime: record.runtime,
            turns: record.turns,
            createdAt: record.createdAt,
            endedAt: record.endedAt,
            durationMs,
            childSessionKey: record.childSessionKey,
          },
        };
      }

      default:
        return { error: `未知 action：${action}。可用：list / kill / steer / wait / status` };
    }
  },
};
