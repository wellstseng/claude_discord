/**
 * @file cli-bridge/index.ts
 * @description CLI Bridge 模組匯出 + 全域單例管理
 *
 * 提供全域函式管理所有 CliBridge 實例：
 * - initCliBridges()    — 從 config 初始化所有 bridge
 * - getCliBridge()      — 以 channelId 查詢對應的 bridge
 * - getAllBridges()     — 列出所有 bridge
 * - shutdownAllBridges() — 關閉所有 bridge
 */

import { log } from "../logger.js";
import { CliBridge } from "./bridge.js";
import type { CliBridgeConfig } from "./types.js";

// ── 型別匯出 ────────────────────────────────────────────────────────────────

export { CliProcess } from "./process.js";
export { CliBridge } from "./bridge.js";
export { StdoutLogger } from "./stdout-log.js";
export type {
  CliBridgeConfig,
  CliBridgeChannelConfig,
  CliBridgeEvent,
  CliProcessConfig,
  StreamJsonMessage,
  TurnHandle,
  TurnRecord,
  StdoutLogEntry,
  BridgeStatus,
} from "./types.js";

// ── 全域單例 ────────────────────────────────────────────────────────────────

/** channelId → CliBridge */
const bridges = new Map<string, CliBridge>();

/** label → CliBridge（Dashboard 查詢用） */
const bridgesByLabel = new Map<string, CliBridge>();

/**
 * 從 catclaw.json 的 cliBridge 設定初始化所有 bridge。
 * 不自動啟動 — 呼叫方需自行 await bridge.start()。
 */
export function initCliBridges(config: CliBridgeConfig): CliBridge[] {
  if (!config.enabled) {
    log.info("[cli-bridge] disabled");
    return [];
  }

  const results: CliBridge[] = [];

  for (const [channelId, channelConfig] of Object.entries(config.channels)) {
    if (bridges.has(channelId)) {
      log.warn(`[cli-bridge] channel ${channelId} 已有 bridge，跳過`);
      continue;
    }

    const bridge = new CliBridge(
      channelConfig.label,
      channelId,
      config,
      channelConfig,
    );

    bridges.set(channelId, bridge);
    bridgesByLabel.set(channelConfig.label, bridge);
    results.push(bridge);

    log.info(`[cli-bridge] 已建立 bridge: ${channelConfig.label} → channel ${channelId}`);
  }

  return results;
}

/**
 * 初始化並啟動所有 bridge。
 * 各 bridge 獨立啟動，單一 bridge 啟動失敗不影響其他。
 */
export async function startAllBridges(config: CliBridgeConfig): Promise<void> {
  const created = initCliBridges(config);

  await Promise.allSettled(
    created.map(async (bridge) => {
      try {
        await bridge.start();
        log.info(`[cli-bridge] ${bridge.label} 啟動成功`);
      } catch (err) {
        log.error(`[cli-bridge] ${bridge.label} 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

/**
 * 以 channelId 查詢對應的 CliBridge。
 * Discord 路由層用此判定是否走 CLI Bridge 路徑。
 */
export function getCliBridge(channelId: string): CliBridge | undefined {
  return bridges.get(channelId);
}

/**
 * 以 label 查詢 CliBridge（Dashboard API 用）。
 */
export function getCliBridgeByLabel(label: string): CliBridge | undefined {
  return bridgesByLabel.get(label);
}

/**
 * 列出所有 bridge（Dashboard 用）。
 */
export function getAllBridges(): Array<{
  label: string;
  channelId: string;
  status: string;
  sessionId: string | null;
}> {
  return Array.from(bridges.entries()).map(([channelId, bridge]) => ({
    label: bridge.label,
    channelId,
    status: bridge.status,
    sessionId: bridge.currentSessionId,
  }));
}

/**
 * 關閉所有 bridge（graceful shutdown）。
 */
export async function shutdownAllBridges(): Promise<void> {
  const all = Array.from(bridges.values());
  await Promise.allSettled(all.map(b => b.shutdown()));
  bridges.clear();
  bridgesByLabel.clear();
  log.info(`[cli-bridge] 所有 bridge 已關閉`);
}
