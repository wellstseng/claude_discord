/**
 * @file tools/builtin/atom-write.ts
 * @description atom_write — 寫入/更新記憶 atom（standard tier）
 *
 * 寫入後自動更新 MEMORY.md index 和向量資料庫。
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "atom_write",
  description: "寫入或更新一筆記憶 atom。自動更新 MEMORY.md 索引和向量資料庫。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 500,
  concurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      name:        { type: "string",  description: "atom 名稱（英文 kebab-case，例如 team-roster）" },
      content:     { type: "string",  description: "atom 內容（知識本體）" },
      description: { type: "string",  description: "一行描述（用於索引和向量搜尋）" },
      confidence:  { type: "string",  description: "信心等級：[固] / [觀] / [臨]（預設 [臨]）" },
      scope:       { type: "string",  description: "範圍：global / project / account（預設 global）" },
      triggers:    { type: "string",  description: "觸發關鍵字，逗號分隔（例如：團隊名單, 成員查詢）" },
      related:     { type: "string",  description: "相關 atom 名稱，逗號分隔" },
    },
    required: ["name", "content"],
  },
  async execute(params, ctx) {
    const name = String(params["name"] ?? "").trim();
    const content = String(params["content"] ?? "").trim();
    const description = String(params["description"] ?? content.slice(0, 60)).trim();
    const confidence = String(params["confidence"] ?? "[臨]").trim() as "[固]" | "[觀]" | "[臨]";
    const scope = String(params["scope"] ?? "global").trim() as "global" | "project" | "account";
    const triggersRaw = String(params["triggers"] ?? "").trim();
    const relatedRaw = String(params["related"] ?? "").trim();

    if (!name) return { error: "name 不能為空" };
    if (!content) return { error: "content 不能為空" };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: "name 必須是英文 kebab-case（例如 my-atom-name）" };

    const triggers = triggersRaw ? triggersRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    const related = relatedRaw ? relatedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    // 決定寫入目錄
    let namespace: string;
    try {
      const { getMemoryEngine } = await import("../../memory/engine.js");
      const engine = getMemoryEngine();
      const { globalDir } = engine.getStatus();

      let dir: string;
      if (scope === "project" && ctx.projectId) {
        const { join } = await import("node:path");
        dir = join(globalDir, "projects", ctx.projectId);
        namespace = `project/${ctx.projectId}`;
      } else if (scope === "account") {
        const { join } = await import("node:path");
        dir = join(globalDir, "accounts", ctx.accountId);
        namespace = `account/${ctx.accountId}`;
      } else {
        dir = globalDir;
        namespace = "global";
      }

      // write-gate 去重檢查
      const gate = await engine.checkWrite(content, namespace);
      if (!gate.allowed) {
        return { result: { written: false, reason: `write-gate 阻擋：${gate.reason}` } };
      }

      const { writeAtom } = await import("../../memory/atom.js");
      const filePath = writeAtom(dir, name, {
        description,
        confidence,
        scope,
        triggers,
        related,
        content,
        namespace,
      });

      return { result: { written: true, path: filePath, namespace } };
    } catch (err) {
      return { error: `寫入失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
