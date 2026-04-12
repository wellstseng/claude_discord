/**
 * @file core/agent-loader.ts
 * @description CLI `--agent <id>` 支援
 *
 * 啟動時解析 `--agent <id>` 參數，將對應的 agent 設定深合併到頂層 config。
 * Per-agent 資料路徑自動設定為 ~/.catclaw/agents/{id}/。
 *
 * 使用方式：
 *   node dist/index.js --agent support-bot
 *   npx catclaw --agent dev-bot
 *
 * PM2 ecosystem 範例：
 *   { name: "catclaw-support", script: "dist/index.js", args: "--agent support-bot" }
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { log } from "../logger.js";
import type { BridgeConfig, AgentConfig } from "./config.js";
import { resolveCatclawDir } from "./config.js";
import { deepMerge } from "./agent-registry.js";

// ── CLI 解析 ──────────────────────────────────────────────────────────────────

export function parseAgentArg(argv: string[] = process.argv): string | undefined {
  const idx = argv.indexOf("--agent");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];

  const prefixed = argv.find(a => a.startsWith("--agent="));
  if (prefixed) return prefixed.slice("--agent=".length);

  return undefined;
}

// ── Boot Agent ID singleton ──────────────────────────────────────────────────

/** 啟動時的 agent ID（--agent 模式有值，主體模式 = "default"） */
let _bootAgentId: string = "wendy";
let _bootIsAdmin: boolean = true;

/** index.ts 啟動時呼叫，設定 boot agent 身份 */
export function setBootAgent(agentId: string, isAdmin: boolean): void {
  _bootAgentId = agentId;
  _bootIsAdmin = isAdmin;
}

/** 取得 boot agent ID（主體 = "default"） */
export function getBootAgentId(): string { return _bootAgentId; }

/** 取得 boot agent 是否為 admin */
export function getBootIsAdmin(): boolean { return _bootIsAdmin; }

/** 取得 boot agent 的資料目錄（~/.catclaw/agents/{bootAgentId}/） */
export function getBootAgentDataDir(catclawDir?: string): string {
  return resolveAgentDataDir(_bootAgentId, catclawDir);
}

// ── Per-agent 路徑工具 ────────────────────────────────────────────────────────

export function resolveAgentDataDir(agentId: string, catclawDir?: string): string {
  const base = catclawDir ?? resolveCatclawDir();
  return join(base, "agents", agentId);
}

// ── 設定解析 ──────────────────────────────────────────────────────────────────

/**
 * 若命令列有 `--agent <id>`，回傳合併後的 agent 專屬設定；
 * 否則回傳原始 base config。
 *
 * Per-agent data 路徑（sessions、vectordb）自動設定。
 */
export function loadAgentBootConfig(base: BridgeConfig, agentId: string): BridgeConfig {
  const agentOverrides = base.agents?.[agentId];
  if (!agentOverrides) {
    throw new Error(`catclaw.json 找不到 agents.${agentId}，無法啟動`);
  }

  // Deep merge agent overrides on top of base config
  const merged = deepMerge(base, agentOverrides as Partial<BridgeConfig>);

  // Per-agent data 路徑（sessions / vectordb 獨立）
  const dataDir = resolveAgentDataDir(agentId);
  const agentDataPatch: Partial<BridgeConfig> = {
    session: {
      ...merged.session,
      persistPath: merged.session?.persistPath?.includes("/agents/")
        ? merged.session.persistPath
        : join(dataDir, "sessions"),
    },
    memory: merged.memory ? {
      ...merged.memory,
      vectorDbPath: merged.memory.vectorDbPath?.includes("/agents/")
        ? merged.memory.vectorDbPath
        : join(dataDir, "_vectordb"),
    } : merged.memory,
  };

  const final = deepMerge(merged, agentDataPatch);
  log.info(`[agent-loader] agent=${agentId} dataDir=${dataDir}`);
  return final;
}

// ── Agent Config 載入（供 spawn_subagent 使用）──────────────────────────────

/**
 * 讀取 `~/.catclaw/agents/{agentId}/config.json`，回傳 AgentConfig。
 * 檔案不存在時回傳 undefined（agent 目錄可能只有 CATCLAW.md）。
 */
export function loadAgentConfig(agentId: string): AgentConfig | undefined {
  const configPath = join(resolveAgentDataDir(agentId), "config.json");
  if (!existsSync(configPath)) {
    log.debug(`[agent-loader] agent config 不存在：${configPath}`);
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as AgentConfig;
    log.info(`[agent-loader] agent config 載入：${agentId}`);
    return raw;
  } catch (err) {
    log.warn(`[agent-loader] agent config 解析失敗：${configPath} — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * 讀取 agent 的 CATCLAW.md（agent 專屬行為規則），作為 system prompt 的一部分。
 * 不存在時回傳 undefined。
 */
export function loadAgentPrompt(agentId: string): string | undefined {
  const promptPath = join(resolveAgentDataDir(agentId), "CATCLAW.md");
  if (!existsSync(promptPath)) return undefined;
  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    return undefined;
  }
}
