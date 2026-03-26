/**
 * @file accounts/registration.ts
 * @description 帳號註冊管理 — 三種流程：Admin 直建 + 邀請碼 + 配對碼
 *
 * A. Admin 直建：/account create <id> --role <role> --discord <discordId>
 * B. 邀請碼：   /account invite → 產生 8 碼；使用者 DM /register <code> <id>
 * C. 配對碼：   陌生人 DM → bot 回覆 6 碼；owner /account approve <code> --name <id>
 *
 * 安全：
 *   - 配對碼 5 分鐘過期，single-use
 *   - 錯誤 3 次 → 鎖定 15 分鐘（per platformId）
 *   - rate limit：每 platformId 每 10 分鐘最多 3 次請求
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AccountRegistry, Role, Platform } from "./registry.js";
import { log } from "../logger.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const INVITE_EXPIRE_DEFAULT_MS = 24 * 60 * 60 * 1000;  // 24h
const PAIRING_EXPIRE_MS = 5 * 60 * 1000;               // 5min
const PAIRING_MAX_ATTEMPTS = 3;
const PAIRING_LOCKOUT_MS = 15 * 60 * 1000;             // 15min
const PAIRING_RATE_WINDOW_MS = 10 * 60 * 1000;         // 10min
const PAIRING_RATE_MAX = 3;
const MAX_PENDING_PAIRINGS = 10;                        // S10：全局待處理配對碼上限

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface InviteRecord {
  code: string;
  role: Role;
  projectId?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

export interface PairingRecord {
  code: string;
  platform: Platform;
  platformId: string;
  createdAt: number;   // Date.now()
  attempts: number;
}

interface PairingRateEntry {
  count: number;
  windowStart: number;
}

// ── RegistrationManager ───────────────────────────────────────────────────────

export class RegistrationManager {
  private readonly invitesPath: string;
  private invites: Record<string, InviteRecord> = {};

  // in-memory only（短暫存活）
  private pairings = new Map<string, PairingRecord>();
  private lockouts = new Map<string, number>();         // platformId → lockout expiry
  private rateMap = new Map<string, PairingRateEntry>();

  constructor(
    private readonly catclawDir: string,
    private readonly accountRegistry: AccountRegistry,
  ) {
    this.invitesPath = join(catclawDir, "_invites.json");
  }

  // ── 初始化 ─────────────────────────────────────────────────────────────────

  init(): void {
    mkdirSync(this.catclawDir, { recursive: true });
    if (existsSync(this.invitesPath)) {
      try {
        this.invites = JSON.parse(readFileSync(this.invitesPath, "utf-8")) as Record<string, InviteRecord>;
        log.info(`[registration] 載入邀請碼：${Object.keys(this.invites).length} 筆`);
      } catch {
        this.invites = {};
      }
    }
  }

  // ── 邀請碼 ─────────────────────────────────────────────────────────────────

  createInvite(opts: {
    createdBy: string;
    role: Role;
    expireMs?: number;
    projectId?: string;
  }): InviteRecord {
    const code = randomBytes(4).toString("hex").toUpperCase();  // 8-char hex
    const now = new Date();
    const record: InviteRecord = {
      code,
      role: opts.role,
      projectId: opts.projectId,
      createdBy: opts.createdBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (opts.expireMs ?? INVITE_EXPIRE_DEFAULT_MS)).toISOString(),
      used: false,
    };
    this.invites[code] = record;
    this.saveInvites();
    log.info(`[registration] 建立邀請碼 ${code} role=${opts.role} by=${opts.createdBy}`);
    return record;
  }

  claimInvite(
    code: string,
    accountId: string,
    platform: Platform,
    platformId: string,
    displayName?: string,
  ): { ok: boolean; reason?: string } {
    const record = this.invites[code.toUpperCase()];
    if (!record) return { ok: false, reason: "邀請碼無效" };
    if (record.used) return { ok: false, reason: "邀請碼已被使用" };
    if (new Date(record.expiresAt) < new Date()) return { ok: false, reason: "邀請碼已過期" };

    try {
      this.accountRegistry.create({
        accountId,
        displayName: displayName ?? accountId,
        role: record.role,
        identities: [{ platform, platformId, linkedAt: new Date().toISOString() }],
      });
      record.used = true;
      this.saveInvites();
      log.info(`[registration] 邀請碼 ${code} 被 ${accountId} 使用`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  listInvites(): InviteRecord[] {
    const now = new Date();
    return Object.values(this.invites)
      .filter(r => !r.used && new Date(r.expiresAt) > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── 配對碼 ─────────────────────────────────────────────────────────────────

  /**
   * 未知使用者 DM → 產生配對碼（含 rate limit + lockout 防護）
   */
  createPairingCode(
    platform: Platform,
    platformId: string,
  ): { ok: boolean; code?: string; reason?: string } {
    const now = Date.now();

    // 鎖定檢查
    const lockout = this.lockouts.get(platformId) ?? 0;
    if (lockout > now) {
      const minutesLeft = Math.ceil((lockout - now) / 60000);
      return { ok: false, reason: `嘗試次數過多，請等 ${minutesLeft} 分鐘後再試` };
    }

    // rate limit 檢查
    const rate = this.rateMap.get(platformId);
    if (rate && now - rate.windowStart < PAIRING_RATE_WINDOW_MS) {
      if (rate.count >= PAIRING_RATE_MAX) {
        return { ok: false, reason: "請求過頻繁，請稍後再試" };
      }
      rate.count++;
    } else {
      this.rateMap.set(platformId, { count: 1, windowStart: now });
    }

    // 若已有未過期的配對碼，直接回傳（同一用戶不重複產生）
    for (const rec of this.pairings.values()) {
      if (rec.platform === platform && rec.platformId === platformId) {
        if (now - rec.createdAt < PAIRING_EXPIRE_MS) return { ok: true, code: rec.code };
        this.pairings.delete(rec.code);
        break;
      }
    }

    // S10：全局待處理配對碼上限（先 cleanup 過期，再計數）
    this.cleanupPairings();
    if (this.pairings.size >= MAX_PENDING_PAIRINGS) {
      return { ok: false, reason: "系統目前待處理配對碼已達上限，請聯絡管理員" };
    }

    // 產生新配對碼（6碼英數，去掉易混淆字元）
    const code = this.generatePairingCode();
    this.pairings.set(code, { code, platform, platformId, createdAt: now, attempts: 0 });

    log.info(`[registration] 配對碼 ${code} 建立 platform=${platform} id=${platformId}`);
    return { ok: true, code };
  }

  listPairings(): PairingRecord[] {
    const now = Date.now();
    this.cleanupPairings();
    return [...this.pairings.values()];
  }

  /**
   * Owner 批准配對 → 建立帳號 + 綁定 identity
   */
  approvePairing(
    code: string,
    opts: { accountId: string; role: Role; displayName?: string },
  ): { ok: boolean; reason?: string } {
    const upperCode = code.toUpperCase();
    const rec = this.pairings.get(upperCode);
    if (!rec) return { ok: false, reason: "配對碼無效或已過期" };
    if (Date.now() - rec.createdAt > PAIRING_EXPIRE_MS) {
      this.pairings.delete(upperCode);
      return { ok: false, reason: "配對碼已過期" };
    }

    try {
      this.accountRegistry.create({
        accountId: opts.accountId,
        displayName: opts.displayName ?? opts.accountId,
        role: opts.role,
        identities: [{ platform: rec.platform, platformId: rec.platformId, linkedAt: new Date().toISOString() }],
      });
      this.pairings.delete(upperCode);
      log.info(`[registration] 配對碼 ${code} 批准 → 帳號 ${opts.accountId}`);
      return { ok: true };
    } catch (err) {
      // 帳號建立失敗計入 attempts
      rec.attempts++;
      if (rec.attempts >= PAIRING_MAX_ATTEMPTS) {
        this.lockouts.set(rec.platformId, Date.now() + PAIRING_LOCKOUT_MS);
        this.pairings.delete(upperCode);
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  private generatePairingCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 無 O/0/1/I 避免混淆
    const bytes = randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[bytes[i]! % chars.length];
    return code;
  }

  private cleanupPairings(): void {
    const now = Date.now();
    for (const [code, rec] of this.pairings) {
      if (now - rec.createdAt > PAIRING_EXPIRE_MS) this.pairings.delete(code);
    }
  }

  private saveInvites(): void {
    try {
      writeFileSync(this.invitesPath, JSON.stringify(this.invites, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[registration] 儲存邀請碼失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _manager: RegistrationManager | null = null;

export function initRegistrationManager(
  catclawDir: string,
  accountRegistry: AccountRegistry,
): RegistrationManager {
  _manager = new RegistrationManager(catclawDir, accountRegistry);
  _manager.init();
  return _manager;
}

export function getRegistrationManager(): RegistrationManager {
  if (!_manager) throw new Error("[registration] 尚未初始化，請先呼叫 initRegistrationManager()");
  return _manager;
}

export function resetRegistrationManager(): void {
  _manager = null;
}
