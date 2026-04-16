/**
 * @file tools/builtin/hook-register.ts
 * @description hook_register — 寫入新 hook 腳本至 hooks/ 資料夾
 *
 * 寫入後 fs.watch 會自動偵測並 reload registry。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Tool } from "../types.js";

const SUPPORTED_RUNTIMES = new Set(["ts", "js", "mjs", "sh", "bat", "ps1"]);

export const tool: Tool = {
  name: "hook_register",
  description:
    "寫入新 hook 腳本至 hooks/ 資料夾。scope=global 寫入 workspace/hooks/；" +
    "scope=agent 寫入 agents/{agentId}/hooks/。寫入後 fs.watch 自動 reload。" +
    "runtime 支援 ts/js/mjs/sh/bat/ps1。檔名自動格式化為 {event}.{name}.{runtime}。",
  tier: "elevated",
  resultTokenCap: 400,
  parameters: {
    type: "object",
    properties: {
      event:    { type: "string", description: "HookEvent（如 PreToolUse / PostTurn / MemoryRecall / FileChanged / FileDeleted）" },
      name:     { type: "string", description: "hook 名稱（kebab-case）" },
      content:  { type: "string", description: "腳本完整內容" },
      runtime:  { type: "string", description: "ts / js / mjs / sh / bat / ps1（預設 ts）" },
      scope:    { type: "string", description: "global / agent（預設 global）" },
      overwrite:{ type: "boolean", description: "已存在時是否覆蓋（預設 false）" },
    },
    required: ["event", "name", "content"],
  },
  async execute(params, ctx) {
    const event = String(params["event"] ?? "").trim();
    const name = String(params["name"] ?? "").trim();
    const content = String(params["content"] ?? "");
    const runtime = String(params["runtime"] ?? "ts").trim().toLowerCase();
    const scope = String(params["scope"] ?? "global").trim() as "global" | "agent";
    const overwrite = Boolean(params["overwrite"] ?? false);

    if (!event) return { error: "event 不能為空" };
    if (!name) return { error: "name 不能為空" };
    if (!content) return { error: "content 不能為空" };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: "name 必須是英文 kebab-case" };
    if (!SUPPORTED_RUNTIMES.has(runtime)) return { error: `runtime 必須是 ${[...SUPPORTED_RUNTIMES].join("/")} 之一` };
    if (scope === "agent" && !ctx.agentId) return { error: "scope=agent 需要 agentId context" };

    try {
      const { resolveWorkspaceDir } = await import("../../core/config.js");
      const wsDir = resolveWorkspaceDir();

      let dir: string;
      if (scope === "agent") {
        const { resolveAgentDataDir } = await import("../../core/agent-loader.js");
        dir = join(resolveAgentDataDir(ctx.agentId!), "hooks");
      } else {
        dir = join(wsDir, "hooks");
      }

      await mkdir(dir, { recursive: true });
      const filename = `${event}.${name}.${runtime}`;
      const filePath = join(dir, filename);

      if (existsSync(filePath) && !overwrite) {
        return { error: `hook 已存在：${filePath}（設定 overwrite=true 以覆蓋）` };
      }

      await writeFile(filePath, content, "utf-8");
      return {
        result: {
          registered: true,
          path: filePath,
          event,
          scope,
          runtime,
          note: "fs.watch 將於數百毫秒內自動 reload registry。",
        },
      };
    } catch (err) {
      return { error: `註冊失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
