/**
 * @file tools/builtin/write-file.ts
 * @description write_file 工具 — 寫入或覆蓋檔案（tier=elevated）
 *
 * 安全：Safety Guard 保護敏感路徑（在 agent-loop before_tool_call 攔截）
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const tool: Tool = {
  name: "write_file",
  description: "寫入或覆蓋檔案內容。若目錄不存在會自動建立。",
  tier: "elevated",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "目標檔案的絕對路徑",
      },
      content: {
        type: "string",
        description: "要寫入的檔案內容",
      },
    },
    required: ["path", "content"],
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = String(params["path"] ?? "");
    const content = String(params["content"] ?? "");

    if (!filePath) return { error: "path 不能為空" };

    try {
      // 自動建立父目錄
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");

      log.debug(`[write-file] 已寫入：${filePath} (${content.length} chars)`);

      ctx.eventBus.emit("file:modified", filePath, "write_file", ctx.accountId);

      return {
        result: { path: filePath, bytesWritten: Buffer.byteLength(content, "utf-8") },
        fileModified: true,
        modifiedPath: filePath,
      };
    } catch (err) {
      return { error: `寫入失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
