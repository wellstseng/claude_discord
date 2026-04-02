/**
 * @file tools/builtin/llm-task.ts
 * @description llm_task — 單次 JSON-only LLM 呼叫（無 tools / 無 multi-turn）
 *
 * 適合：分類、評分、摘要、條件判斷等需要結構化輸出的子任務。
 * 比 spawn_subagent 輕量：不建立 session、不跑 agentLoop、不累積對話。
 */

import type { Tool, ToolContext } from "../types.js";
import { getProviderRegistry } from "../../providers/registry.js";
import { log } from "../../logger.js";

export const tool: Tool = {
  name: "llm_task",
  description: `單次 LLM 呼叫，回傳 JSON 結構化結果。
不使用 tools、不累積 session，比 spawn_subagent 更輕量。
適合：分類、評分、摘要、條件判斷、結構化資料抽取。`,
  resultTokenCap: 2000,
  tier: "standard",
  parameters: {
    type: "object",
    properties: {
      prompt:     { type: "string",  description: "任務描述（輸入內容）" },
      schema:     { type: "object",  description: "期望輸出的 JSON schema，LLM 會按此格式回傳" },
      provider:   { type: "string",  description: "指定 provider ID（預設繼承父）" },
      timeoutMs:  { type: "number",  description: "逾時毫秒（預設 30000）" },
    },
    required: ["prompt", "schema"],
  },

  async execute(params, _ctx: ToolContext) {
    const prompt    = String(params["prompt"] ?? "").trim();
    const schema    = params["schema"] as Record<string, unknown> | undefined;
    const providerId = params["provider"] ? String(params["provider"]) : undefined;
    const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : 30_000;

    if (!prompt)  return { error: "prompt 不能為空" };
    if (!schema)  return { error: "schema 不能為空" };

    const registry = getProviderRegistry();
    if (!registry) return { error: "ProviderRegistry 尚未初始化" };

    // registry.get() 自動解析 alias
    const provider = providerId ? registry.get(providerId) : registry.resolve();
    if (!provider) return { error: `找不到 provider${providerId ? ` (${providerId})` : ""}` };

    const schemaStr = JSON.stringify(schema, null, 2);
    const systemPrompt = `你是一個嚴格遵守 JSON schema 的助手。
只輸出符合以下 schema 的 JSON，不加任何說明、markdown、code fence。

Schema：
${schemaStr}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.debug(`[llm-task] provider=${provider.id} prompt=${prompt.slice(0, 80)}...`);

      const result = await provider.stream(
        [{ role: "user", content: prompt }],
        { systemPrompt, abortSignal: controller.signal },
      );

      let raw = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) raw += evt.text;
      }

      // 清理可能的 code fence
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return { error: `JSON 解析失敗：${cleaned.slice(0, 200)}` };
      }

      log.debug(`[llm-task] 完成 provider=${provider.id}`);
      return { result: { result: parsed, raw: cleaned, model: provider.id } };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "aborted" || controller.signal.aborted) {
        return { error: "llm_task timeout" };
      }
      return { error: msg };
    } finally {
      clearTimeout(timer);
    }
  },
};
