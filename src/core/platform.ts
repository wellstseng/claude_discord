/**
 * @file core/platform.ts
 * @description 平台子系統初始化器
 *
 * 一次性初始化所有新子系統（provider / session / tool / permission / safety）
 * 並提供「是否啟用新平台路徑」的判斷。
 *
 * 策略：config.providers 有設定 → 啟用新 agentLoop 路徑
 *       否則 → 保留舊 Claude CLI 路徑（向下相容）
 *
 * 身份解析（S6 暫時版，S9 補完整帳號系統）：
 *   - admin.allowedUserIds 中的 Discord ID → platform-owner
 *   - 其餘 → guest（暫用 discord:{platformId} 作為 accountId）
 */

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { BridgeConfig } from "./config.js";

import { AccountRegistry } from "../accounts/registry.js";
import { ToolRegistry, initToolRegistry } from "../tools/registry.js";
import { PermissionGate, initPermissionGate } from "../accounts/permission-gate.js";
import { SafetyGuard, initSafetyGuard } from "../safety/guard.js";
import { SessionManager, initSessionManager } from "./session.js";
import { buildProviderRegistry, initProviderRegistry } from "../providers/registry.js";
import { initWorkflow } from "../workflow/bootstrap.js";
import { initRegistrationManager } from "../accounts/registration.js";
import { initIdentityLinker } from "../accounts/identity-linker.js";
import { initProjectManager, type ProjectManager } from "../projects/manager.js";
import { initMemoryEngine, type MemoryEngine } from "../memory/engine.js";
import { initRateLimiter, getRateLimiter, type RateLimiter } from "./rate-limiter.js";

// ── 子系統實例（module-level singleton） ─────────────────────────────────────

let _accountRegistry: AccountRegistry | null = null;
let _toolRegistry: ToolRegistry | null = null;
let _projectManager: ProjectManager | null = null;
let _memoryEngine: MemoryEngine | null = null;
let _rateLimiter: RateLimiter | null = null;
let _permissionGate: PermissionGate | null = null;
let _safetyGuard: SafetyGuard | null = null;
let _sessionManager: SessionManager | null = null;
let _ready = false;

// ── 初始化 ────────────────────────────────────────────────────────────────────

/**
 * 初始化所有平台子系統。
 * 僅在 config.providers 有設定時才啟動（否則 skip，保持舊路徑）。
 *
 * @param config 全域設定
 * @param catclawDir ~/.catclaw 路徑
 * @param distDir dist/ 路徑（用於 loadFromDirectory）
 */
export async function initPlatform(
  config: BridgeConfig,
  catclawDir: string,
  distDir: string,
): Promise<void> {
  if (!config.providers || Object.keys(config.providers).length === 0) {
    log.info("[platform] 未設定 providers，保持舊 Claude CLI 模式");
    return;
  }

  log.info("[platform] 初始化新平台子系統...");

  // ── 1. AccountRegistry ─────────────────────────────────────────────────────
  _accountRegistry = new AccountRegistry(catclawDir);
  _accountRegistry.init();

  // 自動建立 admin 帳號（S6 暫時：從 config.admin.allowedUserIds 取得）
  for (const discordId of (config.admin?.allowedUserIds ?? [])) {
    const existing = _accountRegistry.resolveIdentity("discord", discordId);
    if (!existing) {
      const accountId = `discord-owner-${discordId}`;
      try {
        _accountRegistry.create({
          accountId,
          displayName: `Admin(${discordId})`,
          role: "platform-owner",
          identities: [{ platform: "discord", platformId: discordId, linkedAt: new Date().toISOString() }],
        });
        log.info(`[platform] 自動建立 platform-owner 帳號：${accountId}`);
      } catch {
        // 帳號已存在（重啟時）
      }
    }
  }

  // ── 2. Tool Registry ───────────────────────────────────────────────────────
  _toolRegistry = initToolRegistry();
  const builtinDir = join(distDir, "tools", "builtin");
  await _toolRegistry.loadFromDirectory(builtinDir);

  // ── 3. Permission Gate ─────────────────────────────────────────────────────
  _permissionGate = initPermissionGate(_accountRegistry, _toolRegistry);

  // ── 4. Safety Guard ────────────────────────────────────────────────────────
  _safetyGuard = initSafetyGuard(config.safety);

  // ── 5. Provider Registry ───────────────────────────────────────────────────
  const providerRegistry = await buildProviderRegistry(
    config.provider ?? Object.keys(config.providers)[0]!,
    config.providers,
    config.providerRouting ?? {},
  );
  initProviderRegistry(providerRegistry);

  // ── 6. Session Manager ─────────────────────────────────────────────────────
  const sessionCfg = config.session ?? {
    ttlHours: config.sessionTtlHours ?? 168,
    maxHistoryTurns: 50,
    compactAfterTurns: 30,
    persistPath: join(catclawDir, "workspace", "data", "sessions-v2"),
  };
  _sessionManager = initSessionManager(sessionCfg);
  await _sessionManager.init();

  // ── 7. Registration + Identity Linker ─────────────────────────────────────
  initRegistrationManager(catclawDir, _accountRegistry);
  initIdentityLinker(_accountRegistry);

  // ── 8. Project Manager ─────────────────────────────────────────────────────
  _projectManager = initProjectManager(join(catclawDir, "workspace", "data"));

  // ── 9. Memory Engine ───────────────────────────────────────────────────────
  if (config.memory?.enabled !== false) {
    _memoryEngine = initMemoryEngine(config.memory ?? {
      enabled: true,
      globalPath: join(catclawDir, "memory", "global"),
      vectorDbPath: join(catclawDir, "memory", "_vectordb"),
      contextBudget: 3000,
      contextBudgetRatio: { global: 0.3, project: 0.4, account: 0.3 },
      writeGate: { enabled: true, dedupThreshold: 0.80 },
      recall: { triggerMatch: true, vectorSearch: false, relatedEdgeSpreading: true, vectorMinScore: 0.65, vectorTopK: 5 },
      extract: { enabled: false, perTurn: false, onSessionEnd: false, maxItemsPerTurn: 3, maxItemsSessionEnd: 5, minNewChars: 500 },
      consolidate: { autoPromoteThreshold: 20, suggestPromoteThreshold: 8, decay: { enabled: false, halfLifeDays: 30, archiveThreshold: 0.1 } },
      episodic: { enabled: false, ttlDays: 24 },
      rutDetection: { enabled: false, windowSize: 14, minOccurrences: 2 },
      oscillation: { enabled: false },
    });
    try { await _memoryEngine.init(); } catch (err) {
      log.warn(`[platform] MemoryEngine init 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 9.5 Rate Limiter ───────────────────────────────────────────────────────
  _rateLimiter = initRateLimiter(config.rateLimit ?? {
    guest:    { requestsPerMinute: 5 },
    member:   { requestsPerMinute: 30 },
    admin:    { requestsPerMinute: 120 },
  });

  // ── 10. Workflow Engine ─────────────────────────────────────────────────────
  const workflowDataDir = join(catclawDir, "workspace", "data", "workflow");
  const memoryDir = join(catclawDir, "memory");
  initWorkflow(
    config.workflow,
    workflowDataDir,
    memoryDir,
    process.cwd(),
  );

  _ready = true;
  log.info(`[platform] 初始化完成 providers=${Object.keys(config.providers).join(",")}`);
}

// ── 子系統存取 ────────────────────────────────────────────────────────────────

export function isPlatformReady(): boolean {
  return _ready;
}

export function getAccountRegistry(): AccountRegistry {
  if (!_accountRegistry) throw new Error("[platform] AccountRegistry 尚未初始化");
  return _accountRegistry;
}

export function getPlatformToolRegistry(): ToolRegistry {
  if (!_toolRegistry) throw new Error("[platform] ToolRegistry 尚未初始化");
  return _toolRegistry;
}

export function getPlatformPermissionGate(): PermissionGate {
  if (!_permissionGate) throw new Error("[platform] PermissionGate 尚未初始化");
  return _permissionGate;
}

export function getPlatformSafetyGuard(): SafetyGuard {
  if (!_safetyGuard) throw new Error("[platform] SafetyGuard 尚未初始化");
  return _safetyGuard;
}

export function getPlatformProjectManager(): ProjectManager {
  if (!_projectManager) throw new Error("[platform] ProjectManager 尚未初始化");
  return _projectManager;
}

/** 記憶引擎（可選，未初始化時回傳 null） */
export function getPlatformMemoryEngine(): MemoryEngine | null {
  return _memoryEngine;
}

export function getPlatformRateLimiter(): RateLimiter | null {
  return _rateLimiter;
}

export function getPlatformSessionManager(): SessionManager {
  if (!_sessionManager) throw new Error("[platform] SessionManager 尚未初始化");
  return _sessionManager;
}

// ── 身份解析（S6 暫時版）─────────────────────────────────────────────────────

/**
 * 從 Discord userId 解析 accountId。
 *
 * S6 策略：
 *   1. AccountRegistry 有記錄 → 用已知帳號
 *   2. admin.allowedUserIds 內 → 視為 platform-owner（自動建立帳號）
 *   3. 其餘 → guest 角色（accountId = `guest:{userId}`）
 */
export function resolveDiscordIdentity(
  discordUserId: string,
  adminUserIds: string[],
): { accountId: string; isGuest: boolean } {
  if (!_accountRegistry) return { accountId: `guest:${discordUserId}`, isGuest: true };

  // 查 registry
  const accountId = _accountRegistry.resolveIdentity("discord", discordUserId);
  if (accountId) return { accountId, isGuest: false };

  // admin → 有帳號但 resolveIdentity 找不到（可能 registry 剛建立）
  if (adminUserIds.includes(discordUserId)) {
    const fallbackId = `discord-owner-${discordUserId}`;
    const acc = _accountRegistry.get(fallbackId);
    if (acc) return { accountId: fallbackId, isGuest: false };
  }

  // guest
  return { accountId: `guest:${discordUserId}`, isGuest: true };
}

/**
 * 確保 guest accountId 已在 AccountRegistry 中存在（lazy 建立）
 */
export function ensureGuestAccount(accountId: string): void {
  if (!_accountRegistry) return;
  if (accountId.startsWith("guest:") && !_accountRegistry.get(accountId)) {
    const discordId = accountId.slice(6);
    try {
      _accountRegistry.create({
        accountId,
        displayName: `Guest(${discordId})`,
        role: "guest",
        identities: [{ platform: "discord", platformId: discordId, linkedAt: new Date().toISOString() }],
      });
    } catch {
      // 已存在
    }
  }
}
