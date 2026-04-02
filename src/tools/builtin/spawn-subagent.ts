/**
 * @file tools/builtin/spawn-subagent.ts
 * @description spawn_subagent — 產生隔離子 agent 執行任務
 *
 * 模式：
 * - async:false（預設）：同步等待完成，結果直接回傳。
 * - async:true：立即回傳 runId，子 agent 背景執行，完成時通知 Discord（SUB-4）。
 *
 * 並行執行：多個 spawn_subagent 在同一輪 LLM response 中可以並行（由 agent-loop 的 Promise.all 負責）。
 * 增生限制：子 agent 執行時 allowSpawn:false，子 agent 看不到此 tool。
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "../types.js";
import { getSubagentRegistry } from "../../core/subagent-registry.js";
import type { SpawnResult, SubagentRunRecord } from "../../core/subagent-registry.js";
import { log } from "../../logger.js";

// 延遲 import（防止循環依賴）— 由 runChildAgentLoop 動態取得
async function getAgentLoopDeps() {
  const [
    { agentLoop },
    { getPlatformSessionManager },
    { getPlatformPermissionGate },
    { getPlatformToolRegistry },
    { getPlatformSafetyGuard },
    { eventBus },
    { getProviderRegistry },
  ] = await Promise.all([
    import("../../core/agent-loop.js"),
    import("../../core/platform.js"),
    import("../../core/platform.js"),
    import("../../core/platform.js"),
    import("../../core/platform.js"),
    import("../../core/event-bus.js"),
    import("../../providers/registry.js"),
  ]);
  return {
    agentLoop,
    getPlatformSessionManager,
    getPlatformPermissionGate,
    getPlatformToolRegistry,
    getPlatformSafetyGuard,
    eventBus,
    getProviderRegistry,
  };
}

// ── 子 agent 執行 ─────────────────────────────────────────────────────────────

interface ChildRunOpts {
  task: string;
  childSessionKey: string;
  accountId: string;
  providerId?: string;
  runtime: "default" | "coding" | "acp";
  maxTurns: number;
  timeoutMs: number;
  signal: AbortSignal;
  workspaceDir?: string;
  attachmentsDir?: string;
  /** 父層 spawn 深度（子層為此值 + 1） */
  parentSpawnDepth?: number;
  /** opt-in 開放子 agent 再 spawn（深度 < 2 時有效） */
  allowNestedSpawn?: boolean;
  /** 此子 agent 的 runId（注入到 ToolContext.parentRunId，供孫層 spawn 建立 parentId 關聯） */
  parentRunId?: string;
}

// ── ACP Runtime（SUB-6）──────────────────────────────────────────────────────

async function runAcpSubagent(opts: ChildRunOpts): Promise<{ text: string; turns: number }> {
  const { resolveClaudeBin, resolveWorkspaceDir } = await import("../../core/config.js");
  const claudeCmd = resolveClaudeBin();
  const cwd = opts.workspaceDir ?? resolveWorkspaceDir();

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--resume", opts.childSessionKey,
      opts.task,
    ];

    log.debug(`[spawn-subagent:acp] spawn: ${claudeCmd} ${args.slice(0, 4).join(" ")} ...`);

    const proc = nodeSpawn(claudeCmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let fullText = "";
    let stdout = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // parse stream-json lines for text deltas
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj["type"] === "assistant" && obj["message"]) {
            const msg = obj["message"] as Record<string, unknown>;
            const content = msg["content"] as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const block of content) {
                if (block["type"] === "text" && typeof block["text"] === "string") {
                  fullText = block["text"];
                }
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("__TIMEOUT__"));
    }, opts.timeoutMs);

    opts.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      proc.kill();
      reject(new Error("killed"));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !fullText) {
        reject(new Error(`ACP 子 agent 退出 code=${code}`));
      } else {
        resolve({ text: fullText, turns: 1 });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runChildAgentLoop(opts: ChildRunOpts): Promise<{ text: string; turns: number }> {
  // ACP 路徑走 Claude CLI
  if (opts.runtime === "acp") {
    return runAcpSubagent(opts);
  }

  const {
    agentLoop,
    getPlatformSessionManager,
    getPlatformPermissionGate,
    getPlatformToolRegistry,
    getPlatformSafetyGuard,
    eventBus,
    getProviderRegistry,
  } = await getAgentLoopDeps();

  const sessionManager = getPlatformSessionManager();
  const permissionGate = getPlatformPermissionGate();
  const toolRegistry = getPlatformToolRegistry();
  const safetyGuard = getPlatformSafetyGuard();
  const providerRegistry = getProviderRegistry();

  // 取得 provider（registry.get 自動解析 alias，無 providerId 則用 resolve() 取預設）
  const provider = opts.providerId
    ? (providerRegistry.get(opts.providerId) ?? providerRegistry.resolve())
    : providerRegistry.resolve();
  if (!provider) throw new Error("找不到可用的 provider");

  // system prompt
  let systemPrompt = `你是一個專門執行子任務的 agent。完成以下任務後請直接回傳結果。\n你沒有 spawn_subagent 工具。`;
  if (opts.attachmentsDir) {
    systemPrompt += `\n\n可用附件目錄：${opts.attachmentsDir}`;
  }

  if (opts.runtime === "coding") {
    systemPrompt = `你是一個程式碼執行 agent。只使用 read_file / write_file / bash 工具。\n不要做社交互動，只做技術任務。`;
  }

  // 根據 runtime 篩選工具（coding 只用三種）
  const codingToolNames = new Set(["read_file", "write_file", "run_command"]);
  const filteredToolRegistry = opts.runtime === "coding"
    ? {
        ...toolRegistry,
        all: () => toolRegistry.all().filter(t => codingToolNames.has(t.name)),
        get: (name: string) => codingToolNames.has(name) ? toolRegistry.get(name) : undefined,
        execute: toolRegistry.execute.bind(toolRegistry),
        register: toolRegistry.register.bind(toolRegistry),
        loadFromDirectory: toolRegistry.loadFromDirectory.bind(toolRegistry),
      }
    : toolRegistry;

  let fullText = "";
  let turnCount = 0;

  const childDepth = (opts.parentSpawnDepth ?? 0) + 1;
  // allowNestedSpawn:true + depth < 2 → 允許子 agent spawn（深度限制由 agent-loop 強制）
  const childAllowSpawn = (opts.allowNestedSpawn === true) && childDepth < 2;

  const loopGen = agentLoop(opts.task, {
    platform: "subagent",
    channelId: opts.childSessionKey,
    accountId: opts.accountId,
    provider,
    systemPrompt,
    signal: opts.signal,
    turnTimeoutMs: opts.timeoutMs,
    allowSpawn: childAllowSpawn,
    spawnDepth: childDepth,
    workspaceDir: opts.workspaceDir,
    _sessionKeyOverride: opts.childSessionKey,
    parentRunId: opts.parentRunId,
  }, {
    sessionManager,
    permissionGate,
    toolRegistry: filteredToolRegistry as typeof toolRegistry,
    safetyGuard,
    eventBus,
  });

  for await (const event of loopGen) {
    if (event.type === "text_delta") fullText += event.text;
    if (event.type === "done") { turnCount = event.turnCount; break; }
    if (event.type === "error") throw new Error(event.message);
  }

  return { text: fullText, turns: turnCount };
}

// ── Tool 定義 ─────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "spawn_subagent",
  description: `產生隔離子 agent 執行任務。
- async:false（預設）：同步等待完成，結果直接回傳。
- async:true：立即回傳 runId，子 agent 背景執行，完成時推送 Discord 通知。
多個任務可同時呼叫（同一輪並行執行，時間 = max(A,B)）。`,
  tier: "standard",
  resultTokenCap: 4000,
  parameters: {
    type: "object",
    properties: {
      task:       { type: "string",  description: "子 agent 要執行的任務描述" },
      label:      { type: "string",  description: "任務標籤（用於顯示和通知，可選）" },
      provider:   { type: "string",  description: "指定 provider ID（預設繼承父）" },
      runtime:    { type: "string",  description: "default | coding（精簡工具：read/write/bash）| acp（Claude CLI）" },
      maxTurns:   { type: "number",  description: "最大 turn 數（預設 10）" },
      timeoutMs:  { type: "number",  description: "逾時毫秒（預設 120000）" },
      async:      { type: "boolean", description: "true = 立即回傳 runId，背景執行（預設 false）" },
      keepSession:{ type: "boolean", description: "完成後保留 session（debug 用，預設 false）" },
      mode:       { type: "string",  description: "run（預設，one-shot）| session（持久，需搭配 keepSession:true）" },
      allowNestedSpawn: { type: "boolean", description: "opt-in 允許子 agent 再 spawn（最多 3 層，預設 false）" },
      inputFrom:    { type: "string",  description: "等待指定 runId 的子 agent 完成，以其 result 作為本次 task 的前置輸入（pipeline 模式）" },
      saveToMemory: { type: "boolean", description: "完成後將結果存入記憶系統（預設 false）" },
      memoryTag:    { type: "string",  description: "記憶標籤（saveToMemory:true 時使用，方便後續搜尋）" },
      attachments: {
        type: "array",
        description: "spawn 時帶入的附件",
        items: {
          type: "object",
          properties: {
            name:     { type: "string" },
            content:  { type: "string" },
            encoding: { type: "string", description: "utf8 | base64" },
          },
        },
      },
    },
    required: ["task"],
  },

  async execute(params, ctx: ToolContext): Promise<{ result?: SpawnResult; error?: string }> {
    const registry = getSubagentRegistry();
    if (!registry) return { error: "SubagentRegistry 尚未初始化" };

    const task       = String(params["task"] ?? "").trim();
    const label      = params["label"] ? String(params["label"]) : undefined;
    const providerId = params["provider"] ? String(params["provider"]) : undefined;
    const runtime    = (params["runtime"] as "default" | "coding" | "acp") ?? "default";
    const maxTurns   = typeof params["maxTurns"] === "number" ? params["maxTurns"] : 10;
    const timeoutMs  = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : 120_000;
    const isAsync          = params["async"] === true;
    const keepSession      = params["keepSession"] === true;
    const mode             = (params["mode"] as "run" | "session") ?? "run";
    const allowNestedSpawn = params["allowNestedSpawn"] === true;
    const inputFrom        = params["inputFrom"] ? String(params["inputFrom"]) : undefined;
    const saveToMemory     = params["saveToMemory"] === true;
    const memoryTag        = params["memoryTag"] ? String(params["memoryTag"]) : undefined;
    const attachments = Array.isArray(params["attachments"]) ? params["attachments"] : [];

    if (!task) return { result: { status: "error", error: "task 不能為空" } };

    // inputFrom：等待前置子 agent 完成，將 result 注入 task
    let resolvedTask = task;
    if (inputFrom) {
      const upstream = registry.get(inputFrom);
      if (!upstream) return { result: { status: "error", error: `inputFrom 找不到 runId：${inputFrom}` } };

      // 等待最多 timeoutMs
      const waitStart = Date.now();
      while (upstream.status === "running") {
        if (Date.now() - waitStart > timeoutMs) {
          return { result: { status: "timeout", result: null } };
        }
        await new Promise(r => setTimeout(r, 300));
      }

      if (upstream.status !== "completed") {
        return { result: { status: "error", error: `inputFrom 子 agent 結束狀態 ${upstream.status}，無法繼承輸出` } };
      }

      resolvedTask = `[前置子 agent 輸出]\n${upstream.result ?? ""}\n\n[本次任務]\n${task}`;
      log.debug(`[spawn-subagent] pipeline inputFrom=${inputFrom} task prepended`);
    }

    // 1. allowSpawn 檢查（由 agent-loop opts 注入到 toolContext 未來版，現在透過 registry 無 record 判定）
    // 2. concurrent 上限
    if (registry.isOverConcurrentLimit(ctx.sessionId)) {
      return { result: { status: "forbidden", reason: "max_concurrent" } };
    }

    // 3. 處理附件
    let attachmentsDir: string | undefined;
    const attachmentUuid = randomUUID();
    if (attachments.length > 0) {
      const catclawDir = process.env["CATCLAW_WORKSPACE"] ?? "";
      attachmentsDir = join(catclawDir, "attachments", attachmentUuid);
      try {
        mkdirSync(attachmentsDir, { recursive: true });
        for (const att of attachments) {
          const name = String(att["name"] ?? "file");
          const content = String(att["content"] ?? "");
          const encoding = String(att["encoding"] ?? "utf8") as BufferEncoding;
          writeFileSync(join(attachmentsDir, name), Buffer.from(content, encoding));
        }
      } catch (err) {
        log.warn(`[spawn-subagent] 附件寫入失敗：${err instanceof Error ? err.message : String(err)}`);
        attachmentsDir = undefined;
      }
    }

    // 4. 建立 registry record
    const record = registry.create({
      parentSessionKey: ctx.sessionId,
      task,
      label,
      mode,
      runtime,
      async: isAsync,
      keepSession: keepSession || mode === "session",
      discordChannelId: ctx.channelId,
      accountId: ctx.accountId,
      parentId: ctx.parentRunId,
    });

    // SUB-5：mode:session → 建立 Discord thread 並綁定
    if (mode === "session") {
      const { createSubagentThread } = await import("../../core/subagent-discord-bridge.js");
      const threadLabel = label ?? `子 agent ${record.runId.slice(0, 8)}`;
      // 注意：originMessageId 需從 ctx 取得，但 ToolContext 目前沒有，用空字串 fallback
      const originMsgId = ((ctx as unknown) as Record<string, unknown>)["originMessageId"] as string | undefined ?? "";
      if (originMsgId) {
        const threadId = await createSubagentThread(ctx.channelId, originMsgId, threadLabel, record.childSessionKey);
        if (threadId) {
          record.discordThreadId = threadId;
          log.info(`[spawn-subagent] thread created threadId=${threadId} for runId=${record.runId}`);
        }
      }
    }

    const runChildFn = async () => {
      try {
        const { text, turns } = await Promise.race([
          runChildAgentLoop({
            task: resolvedTask,
            childSessionKey: record.childSessionKey,
            accountId: record.accountId,
            providerId,
            runtime,
            maxTurns,
            timeoutMs,
            signal: record.abortController.signal,
            attachmentsDir,
            parentSpawnDepth: ctx.spawnDepth ?? 0,
            allowNestedSpawn,
            parentRunId: record.runId,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("__TIMEOUT__")), timeoutMs + 1000);
          }),
        ]);

        registry.complete(record.runId, text, turns);
        log.info(`[spawn-subagent] completed runId=${record.runId} turns=${turns}`);

        // saveToMemory：將結果寫入記憶系統
        if (saveToMemory && text) {
          try {
            const { writeAtom } = await import("../../memory/atom.js");
            const { resolveWorkspaceDir } = await import("../../core/config.js");
            const { join } = await import("node:path");
            const memDir = join(resolveWorkspaceDir(), "memory");
            const atomName = `subagent-result-${record.runId.slice(0, 8)}`;
            const triggers = memoryTag ? [memoryTag, "subagent-result"] : ["subagent-result"];
            writeAtom(memDir, atomName, {
              description: `子 agent 結果：${record.label ?? record.task.slice(0, 50)}`,
              triggers,
              confidence: "[臨]",
              scope: "global",
              namespace: "global",
              content: `## 任務\n${record.task}\n\n## 結果\n${text.slice(0, 2000)}`,
            });
            log.info(`[spawn-subagent] memory saved atomName=${atomName}`);
          } catch (memErr) {
            log.warn(`[spawn-subagent] memory save failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
          }
        }

        // 清除附件（非持久 session）
        if (attachmentsDir && !record.keepSession) {
          try { rmSync(attachmentsDir, { recursive: true }); } catch { /* ignore */ }
        }

        return { text, turns };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "__TIMEOUT__") {
          registry.timeout(record.runId);
          log.warn(`[spawn-subagent] timeout runId=${record.runId}`);
          throw new Error("__TIMEOUT__");
        } else {
          registry.fail(record.runId, msg);
          log.warn(`[spawn-subagent] failed runId=${record.runId} err=${msg}`);
          throw err;
        }
      }
    };

    // 5. Sync vs Async
    if (!isAsync) {
      // 同步：等待完成
      try {
        const { text, turns } = await runChildFn();
        return {
          result: {
            status: "completed",
            result: text,
            sessionKey: record.childSessionKey,
            turns,
          } satisfies SpawnResult,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "__TIMEOUT__") {
          return { result: { status: "timeout", result: null } };
        }
        return { result: { status: "error", error: msg } };
      }
    } else {
      // 非同步：背景執行，立即回傳 runId（SUB-4）
      runChildFn()
        .then(async () => {
          const { sendSubagentNotification } = await import("../../core/subagent-discord-bridge.js");
          await sendSubagentNotification(record);
        })
        .catch(async (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[spawn-subagent] async background error runId=${record.runId}: ${msg}`);
          const { sendSubagentNotification } = await import("../../core/subagent-discord-bridge.js");
          await sendSubagentNotification(record, { error: true });
        });

      return {
        result: {
          status: "spawned",
          runId: record.runId,
          sessionKey: record.childSessionKey,
        } satisfies SpawnResult,
      };
    }
  },
};
