/**
 * @file tools/builtin/memory-recall.ts
 * @description memory_recall — 搜尋記憶庫（standard tier）
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "memory_recall",
  description: "搜尋記憶庫，取得相關知識片段（全域/專案/個人）",
  tier: "standard",
  deferred: true,
  resultTokenCap: 2000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      query:        { type: "string",  description: "搜尋關鍵字或問題" },
      layer:        { type: "string",  description: "指定層級：global / project / account（省略為全部）" },
      vectorSearch: { type: "boolean", description: "true = 啟用語意向量搜尋（需 Ollama 在線，預設依系統設定）" },
      topK:         { type: "number",  description: "向量搜尋回傳數量（vectorSearch:true 時有效，預設 5）" },
    },
    required: ["query"],
  },
  async execute(params, ctx) {
    const query        = String(params["query"] ?? "").trim();
    const vectorSearch = typeof params["vectorSearch"] === "boolean" ? params["vectorSearch"] : undefined;
    const topK         = typeof params["topK"] === "number" ? params["topK"] : undefined;
    if (!query) return { error: "query 不能為空" };

    try {
      // 延遲載入（記憶引擎可能尚未初始化）
      const { getMemoryEngine } = await import("../../memory/engine.js");
      const engine = getMemoryEngine();
      const overrides = (vectorSearch !== undefined || topK !== undefined)
        ? { vectorSearch, vectorTopK: topK }
        : undefined;
      const result = await engine.recall(query, {
        accountId: ctx.accountId,
        projectId: ctx.projectId,
        agentId: ctx.agentId,
      }, overrides);

      const fragments = result.fragments.map(f => ({
        atom: f.atom.name,
        score: f.score,
        matchedBy: f.matchedBy,
        content: f.atom.content?.slice(0, 500) ?? "",
      }));

      return {
        result: { fragments, blindSpot: result.blindSpot, degraded: result.degraded },
      };
    } catch (err) {
      return { error: `記憶搜尋失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
