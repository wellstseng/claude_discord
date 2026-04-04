/**
 * @file providers/auth-profile-store.ts
 * @description Auth Profile 多憑證管理 — Round-Robin 選取 + Cooldown 追蹤 + 持久化
 *
 * V2 格式（對齊 OpenClaw）：
 * - profileId 格式："provider:name"（如 "anthropic:default"）
 * - 三種 credential type：api_key / token / oauth
 * - order 控制輪替順序
 * - usageStats 追蹤每組的使用/冷卻狀態
 *
 * 檔案結構（auth-profile.json）：
 * {
 *   "version": 1,
 *   "profiles": { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-..." } },
 *   "order": { "anthropic": ["anthropic:default"] },
 *   "usageStats": { "anthropic:default": { lastUsed: 0, cooldownUntil: 0 } }
 * }
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";
import type { AuthProfileCredential, AuthProfilesJson, ProfileUsageStats } from "../core/config.js";

// ── Cooldown 時間常數 ─────────────────────────────────────────────────────────

export type CooldownReason = "rate_limit" | "overloaded" | "billing" | "auth";

const COOLDOWN_DURATION_MS: Record<CooldownReason, number> = {
  rate_limit:  5 * 60 * 60 * 1000,   // 5 小時（429）
  overloaded:      5 * 60 * 1000,    // 5 分鐘（503）
  billing:    24 * 60 * 60 * 1000,   // 24 小時（402）
  auth:                  Infinity,   // 永久（401/403）→ disabled
};

// ── 型別 ─────────────────────────────────────────────────────────────────────

/** 選取結果（pick 回傳） */
export interface PickResult {
  profileId: string;
  credential: AuthProfileCredential;
  /** 取出的 API key / token（統一欄位） */
  apiKey: string;
}

// ── AuthProfileStore ──────────────────────────────────────────────────────────

export class AuthProfileStore {
  private _filePath: string;
  private _data: AuthProfilesJson;

  constructor(filePath: string) {
    this._filePath = filePath;
    this._data = { version: 1, profiles: {}, order: {}, usageStats: {} };
  }

  // ── 載入 ─────────────────────────────────────────────────────────────────────

  load(): void {
    if (!existsSync(this._filePath)) {
      log.info(`[auth-profile] 檔案不存在，使用空 store：${this._filePath}`);
      return;
    }

    try {
      const raw = readFileSync(this._filePath, "utf-8");
      const parsed = JSON.parse(raw) as AuthProfilesJson;

      // V1 → V2 遷移：舊格式是 Array<{id, credential}>
      if (Array.isArray(parsed)) {
        log.info(`[auth-profile] 偵測到 V1 陣列格式，自動遷移為 V2`);
        this._migrateFromV1(parsed as unknown as Array<{ id: string; credential: string }>);
        return;
      }

      this._data = {
        version: parsed.version ?? 1,
        profiles: parsed.profiles ?? {},
        order: parsed.order ?? {},
        lastGood: parsed.lastGood ?? {},
        usageStats: parsed.usageStats ?? {},
      };
      this._pruneExpiredCooldowns();
      log.info(`[auth-profile] 載入 ${Object.keys(this._data.profiles).length} 組憑證：${this._filePath}`);
    } catch (err) {
      log.warn(`[auth-profile] 讀取失敗，使用空 store：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** V1 陣列格式遷移 */
  private _migrateFromV1(arr: Array<{ id: string; credential: string }>): void {
    const profiles: Record<string, AuthProfileCredential> = {};
    for (const { id, credential } of arr) {
      // V1 格式沒有 provider 資訊，預設 anthropic
      const profileId = `anthropic:${id}`;
      profiles[profileId] = { type: "api_key", provider: "anthropic", key: credential };
    }
    this._data = { version: 1, profiles, order: {}, usageStats: {} };
    this._persist();
    log.info(`[auth-profile] V1 → V2 遷移完成，${arr.length} 組憑證`);
  }

  // ── Round-Robin 選取 ─────────────────────────────────────────────────────────

  /**
   * 選取指定 provider 中最適合的 credential。
   * 優先序：明確 order > lastUsed 最舊 > 第一組。
   * 回傳 null 表示無可用 credential。
   */
  pickForProvider(provider: string): PickResult | null {
    const now = Date.now();
    const candidates = this._getProfilesForProvider(provider);

    // 按 order 排序（有 order 的優先）
    const orderList = this._data.order?.[provider] ?? [];

    const available = candidates
      .filter(([pid]) => {
        const stats = this._data.usageStats?.[pid];
        if (!stats) return true;
        if (stats.disabledUntil === Infinity) return false;
        if (stats.cooldownUntil && stats.cooldownUntil > now) return false;
        return true;
      })
      .sort((a, b) => {
        // order 中的排前面
        const aIdx = orderList.indexOf(a[0]);
        const bIdx = orderList.indexOf(b[0]);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        // 否則按 lastUsed 最舊優先
        const aUsed = this._data.usageStats?.[a[0]]?.lastUsed ?? 0;
        const bUsed = this._data.usageStats?.[b[0]]?.lastUsed ?? 0;
        return aUsed - bUsed;
      });

    if (available.length === 0) return null;

    const [profileId, cred] = available[0];
    const apiKey = this._extractApiKey(cred);
    if (!apiKey) return null;

    // 更新 lastUsed
    if (!this._data.usageStats) this._data.usageStats = {};
    if (!this._data.usageStats[profileId]) this._data.usageStats[profileId] = {};
    this._data.usageStats[profileId].lastUsed = now;
    if (!this._data.lastGood) this._data.lastGood = {};
    this._data.lastGood[provider] = profileId;
    this._persist();

    return { profileId, credential: cred, apiKey };
  }

  // ── Cooldown 管理 ─────────────────────────────────────────────────────────────

  setCooldown(profileId: string, reason: CooldownReason): void {
    if (!this._data.usageStats) this._data.usageStats = {};
    if (!this._data.usageStats[profileId]) this._data.usageStats[profileId] = {};
    const stats = this._data.usageStats[profileId];

    if (reason === "auth") {
      stats.disabledUntil = Infinity;
      stats.disabledReason = "auth";
      log.warn(`[auth-profile] ${profileId} 永久停用（auth 失敗）`);
    } else {
      stats.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS[reason];
      stats.disabledReason = reason;
      log.info(`[auth-profile] ${profileId} cooldown ${reason} 直到 ${new Date(stats.cooldownUntil).toISOString()}`);
    }
    stats.errorCount = (stats.errorCount ?? 0) + 1;
    this._persist();
  }

  clearCooldown(profileId: string): void {
    const stats = this._data.usageStats?.[profileId];
    if (!stats) return;
    stats.cooldownUntil = undefined;
    stats.disabledUntil = undefined;
    stats.disabledReason = undefined;
    this._persist();
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  addProfile(profileId: string, credential: AuthProfileCredential): void {
    this._data.profiles[profileId] = credential;
    this._persist();
  }

  removeProfile(profileId: string): void {
    delete this._data.profiles[profileId];
    if (this._data.usageStats) delete this._data.usageStats[profileId];
    // 從 order 移除
    if (this._data.order) {
      for (const [provider, list] of Object.entries(this._data.order)) {
        this._data.order[provider] = list.filter(id => id !== profileId);
      }
    }
    this._persist();
  }

  // ── 查詢 ─────────────────────────────────────────────────────────────────────

  getProfile(profileId: string): AuthProfileCredential | undefined {
    return this._data.profiles[profileId];
  }

  listAll(): Record<string, AuthProfileCredential> {
    return { ...this._data.profiles };
  }

  listForProvider(provider: string): Array<{ profileId: string; credential: AuthProfileCredential; stats?: ProfileUsageStats }> {
    return this._getProfilesForProvider(provider).map(([pid, cred]) => ({
      profileId: pid,
      credential: cred,
      stats: this._data.usageStats?.[pid],
    }));
  }

  getAvailableCount(provider: string): number {
    const now = Date.now();
    return this._getProfilesForProvider(provider)
      .filter(([pid]) => {
        const stats = this._data.usageStats?.[pid];
        if (!stats) return true;
        if (stats.disabledUntil === Infinity) return false;
        if (stats.cooldownUntil && stats.cooldownUntil > now) return false;
        return true;
      }).length;
  }

  isAllOnCooldown(provider: string): boolean {
    return this.getAvailableCount(provider) === 0 &&
      this._getProfilesForProvider(provider).length > 0;
  }

  getEarliestAvailableTime(provider: string): number | null {
    const now = Date.now();
    const cooldownProfiles = this._getProfilesForProvider(provider)
      .map(([pid]) => this._data.usageStats?.[pid])
      .filter((s): s is ProfileUsageStats =>
        !!s && s.disabledUntil !== Infinity && !!s.cooldownUntil && s.cooldownUntil > now
      )
      .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));
    return cooldownProfiles[0]?.cooldownUntil ?? null;
  }

  /** 取得完整 data（供 dashboard API 使用） */
  getData(): AuthProfilesJson {
    return { ...this._data };
  }

  // ── 內部工具 ─────────────────────────────────────────────────────────────────

  private _getProfilesForProvider(provider: string): Array<[string, AuthProfileCredential]> {
    return Object.entries(this._data.profiles)
      .filter(([pid, cred]) => {
        // 優先用 cred.provider，fallback 從 profileId "provider:name" 解析
        const credProvider = cred.provider ?? pid.split(":")[0];
        return credProvider === provider;
      });
  }

  private _extractApiKey(cred: AuthProfileCredential): string | null {
    // key 是統一欄位，token/access 為相容舊格式
    switch (cred.type) {
      case "api_key": return cred.key || null;
      case "token": return cred.key || cred.token || null;
      case "oauth": return cred.key || cred.access || null;
      default: return (cred as Record<string, unknown>).key as string || null;
    }
  }

  private _pruneExpiredCooldowns(): void {
    const now = Date.now();
    if (!this._data.usageStats) return;
    for (const stats of Object.values(this._data.usageStats)) {
      if (stats.disabledUntil !== Infinity && stats.cooldownUntil && stats.cooldownUntil < now) {
        stats.cooldownUntil = undefined;
        stats.disabledReason = undefined;
      }
    }
  }

  private _persist(): void {
    try {
      mkdirSync(dirname(this._filePath), { recursive: true });
      const tmp = `${this._filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this._data, null, 2), "utf-8");
      renameSync(tmp, this._filePath);
    } catch (err) {
      log.warn(`[auth-profile] 持久化失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _store: AuthProfileStore | null = null;

export function initAuthProfileStore(filePath: string): AuthProfileStore {
  _store = new AuthProfileStore(filePath);
  _store.load();
  return _store;
}

export function getAuthProfileStore(): AuthProfileStore | null {
  return _store;
}

export function resetAuthProfileStore(): void {
  _store = null;
}
