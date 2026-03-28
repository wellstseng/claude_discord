/**
 * @file skills/builtin/configure.ts
 * @description /configure — 執行時調整 provider / model 設定（admin only）
 *
 * 子命令：
 *   /configure                        — 顯示目前設定
 *   /configure model <model-id>       — 更改當前 provider 的 model
 *   /configure model <model-id> --provider <id>  — 更改指定 provider 的 model
 *   /configure provider <id>          — 切換預設 provider
 *   /configure models                 — 列出 pi-ai 支援的 anthropic models
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Skill, SkillContext, SkillResult } from "../types.js";
import { config } from "../../core/config.js";
import { log } from "../../logger.js";

// ── 設定檔路徑 ────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("CATCLAW_CONFIG_DIR 未設定");
  return resolve(dir, "catclaw.json");
}

// ── 讀寫 catclaw.json（保留原始格式，hot-reload 自動生效） ─────────────────────

function readRawConfig(): Record<string, unknown> {
  const raw = readFileSync(getConfigPath(), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeRawConfig(obj: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

function handleShow(): SkillResult {
  const lines: string[] = ["**目前 Provider 設定**"];
  lines.push(`預設 provider：\`${config.provider}\``);
  for (const [id, entry] of Object.entries(config.providers)) {
    const active = id === config.provider ? " ◀ 預設" : "";
    lines.push(`• \`${id}\`  type=${entry.type}  model=${entry.model ?? "(預設)"}${active}`);
  }
  return { text: lines.join("\n") };
}

function handleSetModel(args: string): SkillResult {
  const tokens = args.trim().split(/\s+/);
  let modelId: string | undefined;
  let providerId: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--provider" && tokens[i + 1]) {
      providerId = tokens[i + 1];
      i++;
    } else if (!modelId && tokens[i] && !tokens[i]!.startsWith("--")) {
      modelId = tokens[i];
    }
  }

  if (!modelId) {
    return { text: "❌ 用法：`/configure model <model-id> [--provider <id>]`", isError: true };
  }

  const targetProvider = providerId ?? config.provider;
  if (!config.providers[targetProvider]) {
    return { text: `❌ Provider 不存在：${targetProvider}`, isError: true };
  }

  try {
    const raw = readRawConfig();
    const providers = raw["providers"] as Record<string, Record<string, unknown>>;
    if (!providers?.[targetProvider]) {
      return { text: `❌ catclaw.json 中找不到 provider：${targetProvider}`, isError: true };
    }
    providers[targetProvider]!["model"] = modelId;
    writeRawConfig(raw);
    log.info(`[configure] provider=${targetProvider} model → ${modelId}`);
    return { text: `✅ \`${targetProvider}\` model 已設為 \`${modelId}\`（hot-reload 生效中）` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function handleSetProvider(args: string): SkillResult {
  const providerId = args.trim().split(/\s+/)[0];
  if (!providerId) {
    return { text: "❌ 用法：`/configure provider <id>`", isError: true };
  }
  if (!config.providers[providerId]) {
    return { text: `❌ Provider 不存在：${providerId}（可用：${Object.keys(config.providers).join(", ")}）`, isError: true };
  }

  try {
    const raw = readRawConfig();
    raw["provider"] = providerId;
    writeRawConfig(raw);
    log.info(`[configure] 預設 provider → ${providerId}`);
    return { text: `✅ 預設 provider 已切換為 \`${providerId}\`（hot-reload 生效中）` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleListModels(): Promise<SkillResult> {
  try {
    const { getModels } = await import("@mariozechner/pi-ai");
    const models = getModels("anthropic");
    const lines = ["**Anthropic 可用模型（via pi-ai）**"];
    for (const m of models) {
      lines.push(`• \`${m.id}\`  ctx=${(m.contextWindow / 1000).toFixed(0)}k  maxOut=${m.maxTokens}`);
    }
    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `❌ 無法取得模型清單：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Skill 定義 ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "configure",
  description: "調整 provider / model 設定（admin）",
  tier: "admin",
  trigger: ["/configure"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { args } = ctx;
    const tokens = args.trim().split(/\s+/);
    const sub = (tokens[0] ?? "").toLowerCase();
    const rest = tokens.slice(1).join(" ");

    switch (sub) {
      case "":
      case "show":
        return handleShow();
      case "model":
        return handleSetModel(rest);
      case "provider":
        return handleSetProvider(rest);
      case "models":
        return handleListModels();
      default:
        return {
          text: [
            "**`/configure` 子命令**",
            "• `show` — 顯示目前設定",
            "• `model <id> [--provider <id>]` — 更改 model",
            "• `provider <id>` — 切換預設 provider",
            "• `models` — 列出 pi-ai 支援的 Anthropic 模型",
          ].join("\n"),
        };
    }
  },
};
