/**
 * @file cli-bridge/index.ts
 * @description CLI Bridge 模組匯出 + 全域單例管理
 *
 * 支援多 CLI Bridge 實例，每個有獨立的 CLI process、Bot/Sender、session。
 * 設定檔：~/.catclaw/cli-bridges.json（獨立於 catclaw.json）
 */

import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import type { Client, Message } from "discord.js";
import { log } from "../logger.js";
import { resolveCatclawDir, config } from "../core/config.js";
import { checkBotMessage, resetOnHumanMessage } from "../discord/bot-circuit-breaker.js";
import { CliBridge } from "./bridge.js";
import { createBridgeSender } from "./discord-sender.js";
import type { CliBridgeConfig, CliBridgeChannelConfig, CliBridgesConfig } from "./types.js";

// ── 型別匯出 ────────────────────────────────────────────────────────────────

export { CliProcess } from "./process.js";
export { CliBridge } from "./bridge.js";
export { StdoutLogger } from "./stdout-log.js";
export type {
  CliBridgeConfig,
  CliBridgesConfig,
  CliBridgeChannelConfig,
  CliBridgeEvent,
  CliProcessConfig,
  StreamJsonMessage,
  TurnHandle,
  TurnRecord,
  StdoutLogEntry,
  BridgeStatus,
} from "./types.js";
export type { BridgeSender } from "./discord-sender.js";

// ── 設定檔路徑 ──────────────────────────────────────────────────────────────

const CONFIG_FILENAME = "cli-bridges.json";

function getConfigPath(): string {
  return join(resolveCatclawDir(), CONFIG_FILENAME);
}

/** 讀取 cli-bridges.json，回傳 enabled 的 config 陣列 */
export function loadCliBridgeConfigs(): CliBridgeConfig[] {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return [];
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as CliBridgesConfig;
    if (!Array.isArray(parsed)) {
      log.warn(`[cli-bridge] ${configPath} 格式錯誤（非陣列）`);
      return [];
    }
    return parsed.filter(c => c.enabled);
  } catch (err) {
    log.error(`[cli-bridge] 讀取 ${configPath} 失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** 讀取 cli-bridges.json 全部內容（含 disabled，Dashboard 用） */
export function loadAllCliBridgeConfigs(): CliBridgesConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return [];
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as CliBridgesConfig;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 寫入 cli-bridges.json（Dashboard 用） */
export function saveCliBridgeConfigs(configs: CliBridgesConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(configs, null, 2), "utf-8");
  log.info(`[cli-bridge] 已寫入 ${configPath}`);
}

// ── 全域單例 ────────────────────────────────────────────────────────────────

/** channelId → CliBridge */
const bridges = new Map<string, CliBridge>();

/** label → CliBridge（Dashboard 查詢用） */
const bridgesByLabel = new Map<string, CliBridge>();

/** 保存 Discord Client 引用（hot-reload 用） */
let _discordClient: Client | null = null;

/** 已註冊 slash commands 的 Client（避免同 token 多 bridge 重複註冊） */
const _slashRegistered = new WeakSet<Client>();

/**
 * 從單一 config 初始化所有 bridge（一個 config 可含多個 channel）。
 */
function initBridgesFromConfig(config: CliBridgeConfig): CliBridge[] {
  const results: CliBridge[] = [];

  for (const [channelId, channelConfig] of Object.entries(config.channels)) {
    if (bridges.has(channelId)) {
      log.warn(`[cli-bridge] channel ${channelId} 已有 bridge，跳過`);
      continue;
    }

    const effectiveLabel = channelConfig.label || config.label;
    const bridge = new CliBridge(
      effectiveLabel,
      channelId,
      config,
      channelConfig,
    );

    bridges.set(channelId, bridge);
    bridgesByLabel.set(effectiveLabel, bridge);
    results.push(bridge);

    log.info(`[cli-bridge] 已建立 bridge: ${effectiveLabel} → channel ${channelId}`);
  }

  return results;
}

/**
 * 載入 cli-bridges.json 並啟動所有 CLI Bridge。
 *
 * @param discordClient 主 bot 的 Discord Client（MainBot fallback 用）
 */
export async function startAllBridges(discordClient: Client): Promise<void> {
  _discordClient = discordClient;

  const configs = loadCliBridgeConfigs();
  if (configs.length === 0) {
    log.info("[cli-bridge] 無啟用的 CLI Bridge");
    watchConfigFile();
    startIdleScanner();
    return;
  }

  const allBridges: CliBridge[] = [];
  for (const config of configs) {
    allBridges.push(...initBridgesFromConfig(config));
  }

  await Promise.allSettled(
    allBridges.map(async (bridge) => {
      try {
        const config = bridge.getBridgeConfig();
        // 建立並初始化 sender
        const sender = createBridgeSender(discordClient, {
          botToken: config.botToken,
        });
        await sender.init(bridge.channelId);
        bridge.setSender(sender);
        log.info(`[cli-bridge] ${bridge.label} sender=${sender.mode}`);

        // 獨立 bot 模式：掛 messageCreate 監聽 + 註冊 slash commands
        if (sender.mode === "independent-bot") {
          sender.onMessage((msg: Message) => {
            handleIndependentBotMessage(bridge, msg);
          });
          // 同 token 共用 Client — 只註冊一次 slash commands
          try {
            const indClient = (sender as import("./discord-sender.js").IndependentBotSender).getClient();
            if (!_slashRegistered.has(indClient)) {
              const { registerSlashCommands, setupSlashCommands } = await import("../slash.js");
              await registerSlashCommands(indClient);
              setupSlashCommands(indClient);
              _slashRegistered.add(indClient);
              log.info(`[cli-bridge] ${bridge.label} slash commands 已註冊到獨立 bot`);
            }
          } catch (err) {
            log.warn(`[cli-bridge] ${bridge.label} slash commands 註冊失敗：${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 記錄 config snapshot（hot-reload 比對用，排除 sessionId）
        _lastConfigJson.set(bridge.channelId, configSnapshotJson(config, bridge.channelId));

        const idleSuspendMs = config.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
        if (idleSuspendMs <= 0) {
          // keepalive 模式：啟動時立即 spawn process
          await bridge.start();
          log.info(`[cli-bridge] ${bridge.label} 啟動成功（keepalive）`);
        } else {
          log.info(`[cli-bridge] ${bridge.label} 就緒（suspended，等待訊息喚醒，idle=${idleSuspendMs}ms）`);
        }
      } catch (err) {
        log.error(`[cli-bridge] ${bridge.label} 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  log.info(`[cli-bridge] 啟動完成（${allBridges.length} 個 bridge）`);

  // 啟動 hot-reload 監聽 + idle scanner
  watchConfigFile();
  startIdleScanner();
}

/**
 * 獨立 bot messageCreate handler
 */
function handleIndependentBotMessage(bridge: CliBridge, msg: Message): void {
  const isHomeChannel = msg.channelId === bridge.channelId;

  const sender = bridge.getSender();
  const myBotId = sender.getBotUserId();

  // ── Mention 解析（channel check 前，跨頻道 mention 需要先判斷） ──
  const mentionPattern = /<@!?(\d+)>/g;
  const contentMentionIds = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = mentionPattern.exec(msg.content)) !== null) contentMentionIds.add(m[1]!);

  const allRegisteredBotIds = getCliBridgeBotUserIds();
  if (_discordClient?.user) allRegisteredBotIds.add(_discordClient.user.id);

  const mentionedBotIds = new Set<string>();
  for (const botId of allRegisteredBotIds) {
    if (contentMentionIds.has(botId)) mentionedBotIds.add(botId);
  }

  const mentionedExternalBot = msg.mentions.users.some(u => u.bot && !allRegisteredBotIds.has(u.id));
  const hasMentionedAnyBot = mentionedBotIds.size > 0 || mentionedExternalBot;
  const iAmMentioned = myBotId ? mentionedBotIds.has(myBotId) : false;

  // 非綁定頻道：只有被 mention 才處理
  if (!isHomeChannel) {
    if (!iAmMentioned) return;
    log.info(`[cli-bridge] ${bridge.label} 跨頻道 mention：channel=${msg.channelId}`);
  }

  // Bot-to-Bot circuit breaker
  if (msg.author.bot) {
    if (!checkBotMessage(msg.channelId, config.botCircuitBreaker)) {
      log.info(`[cli-bridge] bot-circuit-breaker 攔截：${bridge.label} channel=${msg.channelId}`);
      return;
    }
  } else {
    resetOnHumanMessage(msg.channelId);
  }

  if (hasMentionedAnyBot && !iAmMentioned) {
    _appendInboundHistory(bridge, msg);
    log.info(`[cli-bridge] ${bridge.label} 忽略：訊息 mention 了其他 bot (mentioned=${[...mentionedBotIds].join(",")})`);
    return;
  }

  const channelConfig = bridge.getChannelConfig();
  if (!hasMentionedAnyBot && channelConfig.requireMention) {
    _appendInboundHistory(bridge, msg);
    return;
  }

  void (async () => {
    try {
      await bridge.ensureAlive();
      const { handleCliBridgeReply, extractAttachments } = await import("./reply.js");
      const { text: attachmentText, imageBlocks } = await extractAttachments(msg);
      let fullText = msg.content + attachmentText;
      const bridgeConfig = bridge.getBridgeConfig();

      // 跨頻道 mention → 抓來源頻道最近訊息作為上下文
      if (!isHomeChannel) {
        try {
          const ch = msg.channel;
          if (ch.isTextBased() && "messages" in ch) {
            const recent = await ch.messages.fetch({ limit: 20, before: msg.id });
            const fmtTime = (d: Date) => d.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, hour: "2-digit", minute: "2-digit" });
            const lines = [...recent.values()]
              .reverse()
              .map(m => `${fmtTime(m.createdAt)} ${m.author.displayName}: ${m.content.slice(0, 300)}`)
              .filter(l => l.length > 0);
            if (lines.length > 0) {
              const channelName = "name" in ch ? (ch as { name: string }).name : msg.channelId;
              fullText = `[#${channelName} 近況]\n${lines.join("\n")}\n---\n${fullText}`;
              log.info(`[cli-bridge] ${bridge.label} 跨頻道 context inject: ${lines.length} msgs from #${channelName}`);
            }
          }
        } catch (err) {
          log.warn(`[cli-bridge] 跨頻道 context fetch 失敗：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 消費 inbound history，拼在訊息前（home channel scope）
      const inboundCtx = await consumeBridgeInboundHistory(bridge);
      if (inboundCtx) {
        fullText = inboundCtx + "\n\n---\n" + fullText;
      }

      // 移除 mention prefix
      fullText = fullText.replace(/<@!?\d+>/g, "").trim();

      // 跨頻道：用 withChannel 建立指向來源頻道的 proxy sender
      let senderOverride: import("./discord-sender.js").BridgeSender | undefined;
      if (!isHomeChannel) {
        const ch = msg.channel;
        if (ch.isTextBased() && !ch.isDMBased()) {
          senderOverride = sender.withChannel(ch as import("discord.js").GuildTextBasedChannel);
        }
      }

      log.info(`[cli-bridge] independent bot 路由：${bridge.label} channel=${msg.channelId}${isHomeChannel ? "" : " (跨頻道)"}`);
      void handleCliBridgeReply(bridge, fullText, msg, {
        showToolCalls: "none",
      } as Parameters<typeof handleCliBridgeReply>[3], bridgeConfig, imageBlocks, senderOverride,
        isHomeChannel ? undefined : msg.channelId);
    } catch (err) {
      log.error(`[cli-bridge] independent bot handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/** 記錄未處理訊息到 inbound history（bridge scope） */
function _appendInboundHistory(bridge: CliBridge, msg: Message): void {
  void (async () => {
    try {
      const { getInboundHistoryStore } = await import("../discord/inbound-history.js");
      const store = getInboundHistoryStore();
      if (!store || !msg.content.trim()) return;
      store.append(msg.channelId, {
        ts: new Date().toISOString(),
        platform: "discord",
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorName: msg.author.displayName,
        content: msg.content.trim(),
        wasProcessed: false,
      }, bridge.label);
    } catch { /* 靜默 */ }
  })();
}

/** 消費 inbound history（bridge scope），回傳 context string 或 null */
export async function consumeBridgeInboundHistory(bridge: CliBridge): Promise<string | null> {
  try {
    const { getInboundHistoryStore } = await import("../discord/inbound-history.js");
    const store = getInboundHistoryStore();
    if (!store) return null;
    const result = await store.consumeForInjection(
      bridge.channelId,
      { enabled: true, fullWindowHours: 24, decayWindowHours: 168, bucketBTokenCap: 600, decayIITokenCap: 300, inject: { enabled: true } },
      undefined,
      bridge.label,
    );
    if (!result) return null;
    log.info(`[cli-bridge] inbound-history inject: ${bridge.label} entries=${result.entriesCount}`);
    return result.text;
  } catch { return null; }
}

/**
 * 以 channelId 查詢對應的 CliBridge。
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
 * 取得所有 CLI bridge 的 bot user ID 集合（mention 路由判斷用）。
 */
export function getCliBridgeBotUserIds(): Set<string> {
  const ids = new Set<string>();
  for (const bridge of bridges.values()) {
    try {
      const sender = bridge.getSender();
      const botId = sender.getBotUserId();
      if (botId) ids.add(botId);
    } catch {
      // sender 未初始化（bridge 啟動失敗）→ 跳過
    }
  }
  return ids;
}

// ── Hot-reload ──────────────────────────────────────────────────────────────

let _watching = false;

function watchConfigFile(): void {
  if (_watching) return;
  const configPath = getConfigPath();
  _watching = true;

  watchFile(configPath, { interval: 2000 }, () => {
    log.info(`[cli-bridge] cli-bridges.json 變更偵測，執行 hot-reload`);
    void hotReload();
  });

  log.info(`[cli-bridge] 已啟動 ${CONFIG_FILENAME} 監聽（hot-reload）`);
}

/** 快速比較：config 是否有變化（JSON 序列化比對，排除 sessionId） */
const _lastConfigJson = new Map<string, string>();

/** 產生比較用 JSON（排除 sessionId，避免 persist 觸發不必要的 hot-reload） */
function configSnapshotJson(config: CliBridgeConfig, channelId: string): string {
  const chCfg = { ...config.channels[channelId] };
  delete (chCfg as Record<string, unknown>)["sessionId"];
  const top = { ...config, channels: { [channelId]: chCfg } };
  return JSON.stringify(top);
}

async function hotReload(): Promise<void> {
  if (!_discordClient) return;

  const newConfigs = loadCliBridgeConfigs();

  // 收集新 config 中所有 channelId → config 對照
  const newChannelMap = new Map<string, { config: CliBridgeConfig; json: string }>();
  for (const config of newConfigs) {
    for (const channelId of Object.keys(config.channels)) {
      newChannelMap.set(channelId, {
        config,
        json: configSnapshotJson(config, channelId),
      });
    }
  }

  // 關閉被移除或設定變更的 bridge
  for (const [channelId, bridge] of bridges) {
    const entry = newChannelMap.get(channelId);
    if (!entry) {
      // 已移除
      log.info(`[cli-bridge] hot-reload: 關閉 ${bridge.label}（已從設定移除）`);
      await bridge.shutdown();
      bridges.delete(channelId);
      bridgesByLabel.delete(bridge.label);
      _lastConfigJson.delete(channelId);
    } else if (_lastConfigJson.get(channelId) !== entry.json) {
      // 設定變更 → 關閉重建
      log.info(`[cli-bridge] hot-reload: ${bridge.label} 設定變更，重建`);
      await bridge.shutdown();
      bridges.delete(channelId);
      bridgesByLabel.delete(bridge.label);
      _lastConfigJson.delete(channelId);
    }
  }

  // 啟動新增 / 需重建的 bridge
  for (const config of newConfigs) {
    const newBridges = initBridgesFromConfig(config);
    for (const bridge of newBridges) {
      try {
        const sender = createBridgeSender(_discordClient, {
          botToken: config.botToken,
        });
        await sender.init(bridge.channelId);
        bridge.setSender(sender);

        if (sender.mode === "independent-bot") {
          sender.onMessage((msg: Message) => {
            handleIndependentBotMessage(bridge, msg);
          });
          try {
            const indClient = (sender as import("./discord-sender.js").IndependentBotSender).getClient();
            if (!_slashRegistered.has(indClient)) {
              const { registerSlashCommands, setupSlashCommands } = await import("../slash.js");
              await registerSlashCommands(indClient);
              setupSlashCommands(indClient);
              _slashRegistered.add(indClient);
            }
          } catch { /* slash 註冊失敗不影響 bridge 運作 */ }
        }

        // 記錄 config snapshot（排除 sessionId）
        _lastConfigJson.set(bridge.channelId, configSnapshotJson(config, bridge.channelId));

        const idleSuspendMs = config.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
        if (idleSuspendMs <= 0) {
          await bridge.start();
          log.info(`[cli-bridge] hot-reload: ${bridge.label} 啟動成功（keepalive） sender=${sender.mode}`);
        } else {
          log.info(`[cli-bridge] hot-reload: ${bridge.label} 就緒（suspended） sender=${sender.mode}`);
        }
      } catch (err) {
        log.error(`[cli-bridge] hot-reload: ${bridge.label} 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  log.info(`[cli-bridge] hot-reload 完成（${bridges.size} 個 bridge）`);
}

/**
 * 原子重建單一 channel 的 bridge：
 * 1. 載入當前 cli-bridges.json
 * 2. 呼叫 mutator 修改對應 config / channelConfig
 * 3. 預先更新 _lastConfigJson（pre-empt watchFile 觸發的 hotReload，防止 double-rebuild）
 * 4. 寫回 cli-bridges.json
 * 5. 關閉舊 bridge → 建立並啟動新 bridge
 *
 * 呼叫者：slash /cd、/session new、/session set
 * 取代原本的「setWorkingDir 直接重啟 + saveCliBridgeConfigs 觸發 hot-reload」雙重啟路徑
 */
export async function rebuildBridgeForChannel(
  channelId: string,
  mutator: (cfg: CliBridgeConfig, channelCfg: CliBridgeChannelConfig) => void,
): Promise<CliBridge | null> {
  if (!_discordClient) {
    throw new Error("[cli-bridge] rebuildBridgeForChannel: discordClient 未初始化");
  }

  const allConfigs = loadAllCliBridgeConfigs();
  const cfg = allConfigs.find(c => c.channels[channelId]);
  if (!cfg) {
    log.warn(`[cli-bridge] rebuildBridgeForChannel: 找不到 channel ${channelId} 的 config`);
    return null;
  }
  const channelCfg = cfg.channels[channelId]!;

  mutator(cfg, channelCfg);

  // Pre-empt hot-reload：先更新 snapshot，watchFile 後續觸發 hotReload 會判定無變更
  _lastConfigJson.set(channelId, configSnapshotJson(cfg, channelId));

  saveCliBridgeConfigs(allConfigs);

  // 關閉舊 bridge
  const oldBridge = bridges.get(channelId);
  if (oldBridge) {
    log.info(`[cli-bridge] rebuild: 關閉舊 bridge ${oldBridge.label}`);
    await oldBridge.shutdown();
    bridges.delete(channelId);
    bridgesByLabel.delete(oldBridge.label);
  }

  // 若 config 未 enabled 則不重建
  if (!cfg.enabled) {
    log.info(`[cli-bridge] rebuild: config ${cfg.label} 已停用，不重建`);
    _lastConfigJson.delete(channelId);
    return null;
  }

  // 建立新 bridge（單一 channel 範圍）
  const effectiveLabel = channelCfg.label || cfg.label;
  const bridge = new CliBridge(effectiveLabel, channelId, cfg, channelCfg);
  bridges.set(channelId, bridge);
  bridgesByLabel.set(effectiveLabel, bridge);

  try {
    const sender = createBridgeSender(_discordClient, { botToken: cfg.botToken });
    await sender.init(channelId);
    bridge.setSender(sender);
    log.info(`[cli-bridge] rebuild: ${bridge.label} sender=${sender.mode}`);

    if (sender.mode === "independent-bot") {
      sender.onMessage((msg: Message) => {
        handleIndependentBotMessage(bridge, msg);
      });
      try {
        const indClient = (sender as import("./discord-sender.js").IndependentBotSender).getClient();
        if (!_slashRegistered.has(indClient)) {
          const { registerSlashCommands, setupSlashCommands } = await import("../slash.js");
          await registerSlashCommands(indClient);
          setupSlashCommands(indClient);
          _slashRegistered.add(indClient);
        }
      } catch { /* slash 註冊��敗不影響 bridge 運作 */ }
    }

    await bridge.start();
    log.info(`[cli-bridge] rebuild: ${bridge.label} 啟動成功`);
    return bridge;
  } catch (err) {
    log.error(`[cli-bridge] rebuild: ${bridge.label} 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
    bridges.delete(channelId);
    bridgesByLabel.delete(effectiveLabel);
    throw err;
  }
}

/**
 * 關閉所有 bridge（graceful close）。
 */
export async function shutdownAllBridges(): Promise<void> {
  stopIdleScanner();
  // 停止監聽
  const configPath = getConfigPath();
  unwatchFile(configPath);
  _watching = false;
  const all = Array.from(bridges.values());
  await Promise.allSettled(all.map(b => b.shutdown()));
  bridges.clear();
  bridgesByLabel.clear();
  log.info(`[cli-bridge] 所有 bridge 已關閉`);
}

// ── Idle Suspend Scanner ────────────────────────────────────────────────────

const DEFAULT_IDLE_SUSPEND_MS = 600_000; // 10 分鐘
const IDLE_SCAN_INTERVAL_MS = 30_000;
let _idleScannerTimer: ReturnType<typeof setInterval> | null = null;

function startIdleScanner(): void {
  if (_idleScannerTimer) return;
  _idleScannerTimer = setInterval(() => {
    void scanIdleBridges();
  }, IDLE_SCAN_INTERVAL_MS);
  log.info("[cli-bridge] idle scanner 已啟動");
}

function stopIdleScanner(): void {
  if (_idleScannerTimer) {
    clearInterval(_idleScannerTimer);
    _idleScannerTimer = null;
  }
}

async function scanIdleBridges(): Promise<void> {
  const now = Date.now();
  for (const bridge of bridges.values()) {
    if (bridge.status !== "idle") continue;
    const idleMs = bridge.getBridgeConfig().idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
    if (idleMs <= 0) continue;
    if (now - bridge.lastUsedAt > idleMs) {
      log.info(`[cli-bridge] ${bridge.label} 閒置 ${Math.round((now - bridge.lastUsedAt) / 1000)}s，自動 suspend`);
      try {
        await bridge.suspend();
      } catch (err) {
        log.error(`[cli-bridge] ${bridge.label} suspend 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
