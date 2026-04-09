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
import { MessageTrace } from "../../core/message-trace.js";

// ── Worktree Isolation helpers ────────────────────────────────────────────────

import { execSync } from "node:child_process";

interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

function createWorktree(baseCwd: string, runId: string): WorktreeInfo {
  const shortId = runId.slice(0, 8);
  const branchName = `catclaw-agent-${shortId}`;
  const worktreePath = join(baseCwd, "..", `.catclaw-worktree-${shortId}`);
  execSync(`git worktree add -b ${branchName} "${worktreePath}" HEAD`, { cwd: baseCwd, stdio: "pipe" });
  log.info(`[spawn-subagent:worktree] created ${worktreePath} branch=${branchName}`);
  return { worktreePath, branchName };
}

function removeWorktree(baseCwd: string, worktreePath: string, branchName: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: baseCwd, stdio: "pipe" });
    // 刪除分支（如果沒有未合併的 commit 就刪除，否則保留）
    try {
      execSync(`git branch -d ${branchName}`, { cwd: baseCwd, stdio: "pipe" });
    } catch {
      // 分支有未合併 commit → 保留，讓 parent 決定
      log.info(`[spawn-subagent:worktree] 保留分支 ${branchName}（有未合併變更）`);
    }
  } catch (err) {
    log.warn(`[spawn-subagent:worktree] 移除 worktree 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

function worktreeHasChanges(worktreePath: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

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
  runtime: string;
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
  /** 父層 traceId（建立 parent-child trace 關聯） */
  parentTraceId?: string;
  /** Agent 專屬 system prompt（覆蓋 agentType 預設 prompt） */
  agentSystemPrompt?: string;
  /** Agent ID（傳遞到 agentLoop → ToolContext） */
  agentId?: string;
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
  const { getAgentType } = await import("../../core/agent-types.js");

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

  // Agent Type：取得預定義的 system prompt + tool 白名單
  const agentType = getAgentType(opts.runtime);
  let systemPrompt = opts.agentSystemPrompt ?? agentType.systemPrompt;
  if (opts.attachmentsDir) {
    systemPrompt += `\n\n可用附件目錄：${opts.attachmentsDir}`;
  }

  // 根據 agent type 的 allowedTools 篩選工具
  const allowedToolSet = agentType.allowedTools ? new Set(agentType.allowedTools) : null;
  const filteredToolRegistry = allowedToolSet
    ? {
        ...toolRegistry,
        all: () => toolRegistry.all().filter(t => allowedToolSet.has(t.name)),
        get: (name: string) => allowedToolSet.has(name) ? toolRegistry.get(name) : undefined,
        execute: toolRegistry.execute.bind(toolRegistry),
        register: toolRegistry.register.bind(toolRegistry),
        loadFromDirectory: toolRegistry.loadFromDirectory.bind(toolRegistry),
      }
    : toolRegistry;

  let fullText = "";
  let turnCount = 0;

  // ── Trace 建立（subagent 分類）──────────────────────────────────────────
  const childTraceId = randomUUID();
  const childTrace = MessageTrace.create(childTraceId, opts.childSessionKey, opts.accountId, "subagent");
  if (opts.parentTraceId) childTrace.setParentTraceId(opts.parentTraceId);
  childTrace.recordInbound({ text: opts.task, attachments: 0 });

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
    trace: childTrace,
    agentId: opts.agentId,
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
- async:true：立即回傳 runId，子 agent 背景執行。完成後自動透過 EventBus 通知 parent，結果會在你的下次回應前自動注入。同時推送 Discord 通知。
多個任務可同時呼叫（同一輪並行執行，時間 = max(A,B)）。`,
  tier: "standard",
  deferred: true,
  resultTokenCap: 4000,
  timeoutMs: 0,  // 自己管 timeout（params.timeoutMs），不受全域 30s 限制
  parameters: {
    type: "object",
    properties: {
      task:       { type: "string",  description: "子 agent 要執行的任務描述" },
      label:      { type: "string",  description: "任務標籤（用於顯示和通知，可選）" },
      provider:   { type: "string",  description: "指定 provider ID（預設繼承父）" },
      runtime:    { type: "string",  description: "default | coding | explore（唯讀搜尋）| plan（架構規劃）| build（程式碼建構）| review（程式碼審查）| acp（Claude CLI）" },
      maxTurns:   { type: "number",  description: "最大 turn 數（預設 10）" },
      timeoutMs:  { type: "number",  description: "逾時毫秒（預設 120000）" },
      async:      { type: "boolean", description: "true = 立即回傳 runId，背景執行（預設 false）" },
      keepSession:{ type: "boolean", description: "完成後保留 session（debug 用，預設 false）" },
      mode:       { type: "string",  description: "run（預設，one-shot）| session（持久，需搭配 keepSession:true）" },
      allowNestedSpawn: { type: "boolean", description: "opt-in 允許子 agent 再 spawn（最多 3 層，預設 false）" },
      agent:      { type: "string",  description: "Agent ID（對應 ~/.catclaw/agents/{id}/），自動載入設定、deterministic session、保留歷史" },
      model:      { type: "string",  description: "模型 alias 或 provider/model（覆蓋預設）" },
      workspaceDir: { type: "string", description: "工作目錄（覆蓋預設）" },
      isolation:  { type: "string",  description: "worktree = git worktree 隔離分支工作（完成後由 parent 決定 merge 或丟棄）" },
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
    const agentParam = params["agent"] ? String(params["agent"]) : undefined;
    const modelParam = params["model"] ? String(params["model"]) : undefined;
    const workspaceDirParam = params["workspaceDir"] ? String(params["workspaceDir"]) : undefined;

    // ── Agent config 載入（覆蓋預設值）──────────────────────────────────────
    let agentConfig: import("../../core/config.js").AgentConfig | undefined;
    let agentPromptExtra = "";
    if (agentParam) {
      const { loadAgentConfig, loadAgentPrompt } = await import("../../core/agent-loader.js");
      agentConfig = loadAgentConfig(agentParam);
      const catclawMd = loadAgentPrompt(agentParam);
      if (catclawMd) agentPromptExtra = `\n\n# Agent 行為規則\n${catclawMd}`;

      // Agent Skills 載入 + 自建提示
      const { loadAgentSkills, buildSkillsPrompt, buildSkillCreationHint } = await import("../../core/agent-skill-loader.js");
      const skills = loadAgentSkills(agentParam, agentConfig?.skills);
      const skillsPrompt = buildSkillsPrompt(skills);
      if (skillsPrompt) agentPromptExtra += skillsPrompt;
      agentPromptExtra += buildSkillCreationHint(agentParam);
    }

    // 參數優先序：call params > agent config > 預設值
    const providerId = modelParam ?? agentConfig?.model ?? (params["provider"] ? String(params["provider"]) : undefined);
    const runtime    = String(params["runtime"] ?? "default");
    const maxTurns   = typeof params["maxTurns"] === "number" ? params["maxTurns"] : (agentConfig?.maxTurns ?? 10);
    const timeoutMs  = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : (agentConfig?.timeoutMs ?? 120_000);
    const isAsync          = params["async"] === true;
    const keepSession      = agentParam ? true : params["keepSession"] === true;  // agent 身份強制 keepSession
    const mode             = (params["mode"] as "run" | "session") ?? "run";
    const allowNestedSpawn = params["allowNestedSpawn"] === true;
    const isolation        = params["isolation"] === "worktree" ? "worktree" as const : undefined;
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
      label: label ?? agentConfig?.label,
      mode,
      runtime,
      async: isAsync,
      keepSession: keepSession || mode === "session",
      discordChannelId: ctx.channelId,
      accountId: ctx.accountId,
      parentId: ctx.parentRunId,
      agentId: agentParam,
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

    // ── Worktree Isolation：建立隔離工作區 ─────────────────────────────────
    let worktreeInfo: WorktreeInfo | undefined;
    const { resolveWorkspaceDir: _resolveWs } = await import("../../core/config.js");
    let effectiveWorkspaceDir: string | undefined;
    if (isolation === "worktree") {
      try {
        const baseCwd = _resolveWs();
        worktreeInfo = createWorktree(baseCwd, record.runId);
        effectiveWorkspaceDir = worktreeInfo.worktreePath;
      } catch (err) {
        log.warn(`[spawn-subagent] worktree 建立失敗，fallback 到原始 cwd：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Agent / 參數 workspaceDir（worktree 優先）
    if (!effectiveWorkspaceDir) {
      effectiveWorkspaceDir = workspaceDirParam ?? agentConfig?.workspaceDir;
    }

    // Agent memory + skills 目錄自動建立（首次 spawn 時確保存在）
    if (agentParam) {
      const { homedir } = await import("node:os");
      const agentBase = join(homedir(), ".catclaw", "agents", agentParam);
      mkdirSync(join(agentBase, "memory"), { recursive: true });
      mkdirSync(join(agentBase, "skills"), { recursive: true });
    }

    // Agent system prompt 注入
    const agentSystemPrompt = agentConfig?.systemPrompt
      ? agentConfig.systemPrompt + agentPromptExtra
      : agentPromptExtra || undefined;

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
            workspaceDir: effectiveWorkspaceDir,
            attachmentsDir,
            parentSpawnDepth: ctx.spawnDepth ?? 0,
            allowNestedSpawn,
            parentRunId: record.runId,
            parentTraceId: ctx.traceId,
            agentSystemPrompt,
            agentId: agentParam,
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
            const { join: pathJoin } = await import("node:path");
            const { homedir: osHomedir } = await import("node:os");
            const { mkdirSync: mkdirSyncFs } = await import("node:fs");

            // agent context → 寫入 agent 專屬目錄；否則 global
            const hasAgent = !!agentParam;
            const memDir = hasAgent
              ? pathJoin(osHomedir(), ".catclaw", "agents", agentParam!, "memory")
              : pathJoin(osHomedir(), ".catclaw", "memory");
            const ns = hasAgent ? `agent/${agentParam!}` : "global";

            mkdirSyncFs(memDir, { recursive: true });

            const atomName = `subagent-result-${record.runId.slice(0, 8)}`;
            const triggers = memoryTag ? [memoryTag, "subagent-result"] : ["subagent-result"];
            writeAtom(memDir, atomName, {
              description: `子 agent 結果：${record.label ?? record.task.slice(0, 50)}`,
              triggers,
              confidence: "[臨]",
              scope: hasAgent ? "agent" : "global",
              namespace: ns,
              content: `## 任務\n${record.task}\n\n## 結果\n${text.slice(0, 2000)}`,
            });
            log.info(`[spawn-subagent] memory saved atomName=${atomName} ns=${ns}`);
          } catch (memErr) {
            log.warn(`[spawn-subagent] memory save failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
          }
        }

        // 清除附件（非持久 session）
        if (attachmentsDir && !record.keepSession) {
          try { rmSync(attachmentsDir, { recursive: true }); } catch { /* ignore */ }
        }

        // Worktree cleanup：無變更 → 自動移除；有變更 → 保留分支，回報路徑
        let worktreeResult: { worktreePath?: string; branchName?: string; hasChanges?: boolean } | undefined;
        if (worktreeInfo) {
          const hasChanges = worktreeHasChanges(worktreeInfo.worktreePath);
          if (hasChanges) {
            // 自動 commit 未提交的變更
            try {
              execSync("git add -A && git commit -m 'agent work (auto-commit)'", { cwd: worktreeInfo.worktreePath, stdio: "pipe" });
            } catch { /* 可能沒有變更需要 commit */ }
            worktreeResult = { worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName, hasChanges: true };
            log.info(`[spawn-subagent:worktree] 保留 ${worktreeInfo.branchName}（有變更）`);
          } else {
            removeWorktree(_resolveWs(), worktreeInfo.worktreePath, worktreeInfo.branchName);
            worktreeResult = { hasChanges: false };
          }
        }

        return { text, turns, worktree: worktreeResult };
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
        const childResult = await runChildFn();
        const result: Record<string, unknown> = {
            status: "completed",
            result: childResult.text,
            sessionKey: record.childSessionKey,
            turns: childResult.turns,
        };
        if (childResult.worktree) {
          result["worktree"] = childResult.worktree;
        }
        return { result: result as unknown as SpawnResult };
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
          // EventBus 通知 parent（agent-loop 在下次 LLM 呼叫前注入結果）
          const { eventBus } = await import("../../core/event-bus.js");
          eventBus.emit("subagent:completed", record.parentSessionKey, record.runId, record.label ?? record.task.slice(0, 60), record.result ?? "");

          const { sendSubagentNotification } = await import("../../core/subagent-discord-bridge.js");
          await sendSubagentNotification(record);
        })
        .catch(async (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[spawn-subagent] async background error runId=${record.runId}: ${msg}`);

          // EventBus 通知 parent（失敗）
          const { eventBus } = await import("../../core/event-bus.js");
          eventBus.emit("subagent:failed", record.parentSessionKey, record.runId, record.label ?? record.task.slice(0, 60), msg);

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
