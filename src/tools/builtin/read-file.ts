/**
 * @file tools/builtin/read-file.ts
 * @description read_file — 讀取檔案內容（elevated tier）
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../types.js";

const MAX_FILE_SIZE = 200_000; // 200KB

export const tool: Tool = {
  name: "read_file",
  description: "讀取檔案內容",
  tier: "elevated",
  resultTokenCap: 4000,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "檔案路徑（絕對路徑或相對路徑）" },
      offset: { type: "number", description: "起始行號（1-based，省略為從頭）" },
      limit:  { type: "number", description: "最多讀取行數（省略為全部）" },
    },
    required: ["path"],
  },
  async execute(params, ctx) {
    const filePath = resolve(String(params["path"] ?? ""));

    if (!existsSync(filePath)) return { error: `檔案不存在：${filePath}` };

    // 目錄偵測：回傳目錄列表而非 EISDIR 錯誤
    try {
      if (statSync(filePath).isDirectory()) {
        const entries = readdirSync(filePath, { withFileTypes: true })
          .map(e => (e.isDirectory() ? e.name + "/" : e.name))
          .sort();
        return { result: `這是一個目錄，包含 ${entries.length} 個項目：\n${entries.join("\n")}` };
      }
    } catch { /* stat 失敗就繼續嘗試讀取 */ }

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      return { error: `讀取失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    if (content.length > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + "\n...[截斷，超過 200KB]";
    }

    // offset / limit 行號切割
    const offset = typeof params["offset"] === "number" ? params["offset"] : 1;
    const limit  = typeof params["limit"]  === "number" ? params["limit"]  : undefined;

    if (offset > 1 || limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end   = limit !== undefined ? start + limit : undefined;
      content = lines.slice(start, end).join("\n");
    }

    ctx.eventBus.emit("file:read", filePath, ctx.accountId);

    return { result: content };
  },
};
