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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { Skill, SkillContext, SkillResult } from "../types.js";
import { config } from "../../core/config.js";
import { log } from "../../logger.js";
import { getProviderRegistry } from "../../providers/registry.js";

// ── 設定檔路徑 ────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("CATCLAW_CONFIG_DIR 未設定");
  return resolve(dir, "catclaw.json");
}

function getModelsConfigPath(): string {
  const dir = process.env.CATCLAW_CONFIG_DIR;
  if (!dir) throw new Error("CATCLAW_CONFIG_DIR 未設定");
  return resolve(dir, "models-config.json");
}

// ── 讀寫設定檔 ───────────────────────────────────────────────────────────────

function readRawConfig(): Record<string, unknown> {
  const raw = readFileSync(getConfigPath(), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function readModelsConfig(): Record<string, unknown> {
  const raw = readFileSync(getModelsConfigPath(), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeModelsConfig(data: Record<string, unknown>): void {
  writeFileSync(getModelsConfigPath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeRawConfig(obj: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

function handleShow(): SkillResult {
  const lines: string[] = ["**目前 Provider 設定**"];

  // V2：agentDefaults 存在時
  if (config.agentDefaults?.model?.primary) {
    const ad = config.agentDefaults;
    lines.push(`模式：V2 三層分離`);
    lines.push(`Primary：\`${ad.model!.primary}\``);
    if (ad.model!.fallbacks?.length) {
      lines.push(`Fallbacks：${ad.model!.fallbacks.map(f => `\`${f}\``).join(" → ")}`);
    }
    // 從 registry 列出已註冊的 provider
    try {
      const registry = getProviderRegistry();
      for (const p of registry.list()) {
        lines.push(`• \`${p.id}\`  model=${p.modelId ?? "(預設)"}`);
      }
    } catch { /* registry 未初始化 */ }
  } else {
    // V1
    lines.push(`預設 provider：\`${config.provider}\``);
    for (const [id, entry] of Object.entries(config.providers)) {
      const active = id === config.provider ? " ◀ 預設" : "";
      lines.push(`• \`${id}\`  type=${entry.type}  model=${entry.model ?? "(預設)"}${active}`);
    }
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

  try {
    const mcfg = readModelsConfig();
    const aliases = mcfg["aliases"] as Record<string, string> | undefined;

    // 驗證 modelId 是否為有效的 alias 或 provider/model 格式
    if (aliases) {
      const validAliases = Object.keys(aliases);
      const validRefs = Object.values(aliases);
      const isValid = validAliases.includes(modelId) || validRefs.includes(modelId);
      if (!isValid) {
        const available = validAliases.join(", ");
        return { text: `❌ 模型 \`${modelId}\` 不存在。可用的別名：${available}`, isError: true };
      }
    }

    mcfg["primary"] = modelId;
    writeModelsConfig(mcfg);
    log.info(`[configure] models-config.json primary → ${modelId}`);
    return { text: `✅ primary model 已設為 \`${modelId}\`（重啟後生效）` };
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
    // V2：從 models.json 列出所有模型
    if (config.agentDefaults?.model?.primary) {
      const { loadModelsJson } = await import("../../providers/models-config.js");
      const wsDir = process.env.CATCLAW_WORKSPACE;
      if (!wsDir) return { text: "❌ CATCLAW_WORKSPACE 未設定", isError: true };
      const modelsJson = loadModelsJson(wsDir);
      const lines = ["**可用模型（models.json）**"];
      for (const [provider, def] of Object.entries(modelsJson.providers)) {
        lines.push(`\n**${provider}**`);
        for (const m of def.models) {
          lines.push(`• \`${provider}/${m.id}\`  ctx=${(m.contextWindow / 1000).toFixed(0)}k  maxOut=${m.maxTokens}`);
        }
      }
      return { text: lines.join("\n") };
    }

    // V1：pi-ai
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

// ── Codex OAuth 登入 ─────────────────────────────────────────────────────────

const CODEX_AUTH_PATH = resolve(homedir(), ".codex/auth.json");

async function handleLoginCodex(ctx: SkillContext): Promise<SkillResult> {
  const { message } = ctx;

  // 確保 channel 可發送訊息
  if (!("send" in message.channel)) {
    return { text: "❌ 此頻道不支援發送訊息", isError: true };
  }
  const channel = message.channel as import("discord.js").TextChannel;

  try {
    // 動態 import pi-ai oauth（避免頂層 import 影響啟動）
    const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");

    // 通知使用者 OAuth 流程開始
    await channel.send("正在啟動 OpenAI Codex OAuth 登入流程...\n`localhost:1455` callback server 已就緒");

    const creds = await loginOpenAICodex({
      onAuth: ({ url }) => {
        channel.send(
          `請在瀏覽器開啟此網址登入：\n${url}\n\n` +
          `登入後瀏覽器會自動跳轉回 localhost:1455 完成認證。\n` +
          `若自動跳轉失敗，請將重導向 URL 貼回此頻道。`
        );
      },
      onPrompt: async (prompt) => {
        await channel.send(`自動回呼失敗，請手動貼上：\n${prompt.message}`);

        const collected = await channel.awaitMessages({
          filter: (m: import("discord.js").Message) => m.author.id === message.author.id,
          max: 1,
          time: 60_000,
        });
        const reply = collected.first()?.content?.trim();
        if (!reply) throw new Error("等待回覆逾時");
        return reply;
      },
      onProgress: (msg) => {
        log.debug(`[codex-oauth] ${msg}`);
      },
    });

    // 轉換格式並寫入 ~/.codex/auth.json
    const authJson = {
      access_token: creds.access,
      refresh_token: creds.refresh,
      expires_at: Math.floor(creds.expires / 1000),  // epoch ms → epoch seconds
      token_type: "Bearer",
    };

    mkdirSync(dirname(CODEX_AUTH_PATH), { recursive: true });
    writeFileSync(CODEX_AUTH_PATH, JSON.stringify(authJson, null, 2), "utf-8");
    log.info(`[configure] Codex OAuth credentials saved to ${CODEX_AUTH_PATH}`);

    return { text: `✅ Codex OAuth 登入成功！\nToken 已存入 \`${CODEX_AUTH_PATH}\`\n到期時間：${new Date(creds.expires).toLocaleString("zh-TW")}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[configure] Codex OAuth login failed: ${msg}`);
    return { text: `❌ Codex OAuth 登入失敗：${msg}`, isError: true };
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
      case "login": {
        const target = rest.trim().toLowerCase();
        if (target === "codex" || target === "openai") {
          return handleLoginCodex(ctx);
        }
        return { text: "❌ 用法：`/configure login codex`\n目前僅支援 Codex OAuth 登入", isError: true };
      }
      default:
        return {
          text: [
            "**`/configure` 子命令**",
            "• `show` — 顯示目前設定",
            "• `model <id> [--provider <id>]` — 更改 model",
            "• `provider <id>` — 切換預設 provider",
            "• `models` — 列出可用模型",
            "• `login codex` — OpenAI Codex OAuth 登入",
          ].join("\n"),
        };
    }
  },
};
