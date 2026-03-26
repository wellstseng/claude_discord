/**
 * @file tools/builtin/edit-file.ts
 * @description edit_file 工具 — 精確字串替換（tier=elevated）
 *
 * 使用方式：讀取檔案 → 替換 old_string → 寫回
 * replace_all=false（預設）：只替換第一個，old_string 不唯一時報錯
 * replace_all=true：替換所有出現
 */

import { readFile, writeFile } from "node:fs/promises";
import { log } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const tool: Tool = {
  name: "edit_file",
  description: "對已存在的檔案進行精確字串替換。replace_all=false 時 old_string 必須唯一；true 時替換所有出現。",
  tier: "elevated",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "要修改的檔案絕對路徑",
      },
      old_string: {
        type: "string",
        description: "要被替換的文字（必須與檔案內容完全相符，包含縮排與換行）",
      },
      new_string: {
        type: "string",
        description: "替換後的文字",
      },
      replace_all: {
        type: "boolean",
        description: "是否替換所有出現（預設 false）",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = String(params["path"] ?? "");
    const oldStr = String(params["old_string"] ?? "");
    const newStr = String(params["new_string"] ?? "");
    const replaceAll = Boolean(params["replace_all"] ?? false);

    if (!filePath) return { error: "path 不能為空" };
    if (oldStr === newStr) return { error: "old_string 與 new_string 相同，不需編輯" };

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      return { error: `讀取檔案失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    if (!content.includes(oldStr)) {
      return { error: `找不到 old_string：「${oldStr.slice(0, 80)}${oldStr.length > 80 ? "…" : ""}」` };
    }

    if (!replaceAll) {
      // 檢查唯一性
      const firstIdx = content.indexOf(oldStr);
      const secondIdx = content.indexOf(oldStr, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          error: "old_string 在檔案中出現多次，請提供更多上下文確保唯一，或設定 replace_all=true",
        };
      }
    }

    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);

    try {
      await writeFile(filePath, updated, "utf-8");
    } catch (err) {
      return { error: `寫入失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    log.debug(`[edit-file] 已編輯：${filePath}`);
    ctx.eventBus.emit("file:modified", filePath, "edit_file", ctx.accountId);

    return {
      result: { path: filePath, replaced: replaceAll ? "all" : "first" },
      fileModified: true,
      modifiedPath: filePath,
    };
  },
};
