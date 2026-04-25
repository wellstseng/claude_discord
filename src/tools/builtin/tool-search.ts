/**
 * @file tools/builtin/tool-search.ts
 * @description tool_search — 查詢 deferred tool 的完整 schema
 *
 * Deferred tools 不在 LLM 的 tools 參數中注入完整 schema，
 * 僅在 system prompt 列出名稱+描述。LLM 呼叫此 tool 取得完整 schema 後，
 * agent-loop 會在下一輪 LLM 呼叫中注入該 tool 的完整定義。
 */

import { log } from "../../logger.js";
import { getToolRegistry } from "../registry.js";
import { toDefinition } from "../types.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const tool: Tool = {
  name: "tool_search",
  description: "查詢可用 tool。預設返回精簡描述（name/desc/required params）— 約 50 tokens/tool。要看完整 input_schema 加 verbose=true（~500 tokens/tool）。",
  tier: "public",
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "精確名稱（如 \"web_search,spawn_subagent\"）或關鍵字搜尋",
      },
      verbose: {
        type: "boolean",
        description: "是否返回完整 input_schema。預設 false（精簡模式），活化 deferred tool 後 tools array 會自動帶完整 schema，所以一般情境不用 verbose。",
      },
    },
    required: ["query"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(params["query"] ?? "").trim();
    const verbose = params["verbose"] === true;
    if (!query) return { error: "query 不能為空" };

    const registry = getToolRegistry();
    const allTools = registry.all();

    // 嘗試精確名稱匹配（逗號或空白分隔）
    // LLM 常以空白分隔批次查多個 tool name（如 "mcp_x_snapshot mcp_x_fill_form"），
    // 只認逗號會讓批次查詢全落到關鍵字模糊匹配，然後因為兩個 keyword 都要同時命中而找不到
    const names = query.split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const exactMatches = allTools.filter(t => names.includes(t.name.toLowerCase()));

    let matched: typeof allTools;
    if (exactMatches.length > 0) {
      matched = exactMatches;
    } else {
      // 關鍵字模糊搜尋（name + description）
      const keywords = query.toLowerCase().split(/\s+/);
      matched = allTools.filter(t => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        return keywords.every(k => haystack.includes(k));
      });
    }

    if (matched.length === 0) {
      return { result: { message: "沒有符合的 tool", query } };
    }

    // 預設精簡格式：name + description + required + optional 欄位名清單
    // 完整 schema 只在 verbose=true 才返回
    // 理由：tool 一旦被活化，下一輪 LLM call 在 tools array 已經有完整 input_schema，
    //   tool_search 沒必要再重複給一份（重複的 4-30 個 schema 是 token 大戶，trace b4bef97e 量化過）
    const definitions = matched.map(t => {
      const def = toDefinition(t);
      if (verbose) {
        return { name: def.name, description: def.description, input_schema: def.input_schema };
      }
      // 精簡：抽出 required + optional 欄位名
      const props = (def.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      const required = (def.input_schema as { required?: string[] } | undefined)?.required ?? [];
      const optional = Object.keys(props).filter(k => !required.includes(k));
      return {
        name: def.name,
        description: def.description,
        params: {
          required: required.length > 0 ? required : undefined,
          optional: optional.length > 0 ? optional : undefined,
        },
        hint: "完整 schema 會在 tool 被活化後自動進入 tools array，不需另外查；要強制看 schema 再查一次帶 verbose=true",
      };
    });

    log.debug(`[tool-search] query="${query}" verbose=${verbose} → ${definitions.length} matches: ${definitions.map(d => d.name).join(", ")}`);

    return { result: definitions };
  },
};
