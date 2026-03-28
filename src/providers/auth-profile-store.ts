/**
 * @file providers/auth-profile-store.ts
 * @description Auth Profile 多憑證管理 — Round-Robin 選取 + Cooldown 追蹤 + 持久化
 *
 * 設計：
 * - AuthProfileStore 管理同一 Provider 的多組憑證
 * - pick() 選取 lastUsed 最舊且無 cooldown 的憑證（round-robin 效果）
 * - setCooldown() 依錯誤類型設定退避時間
 * - 狀態持久化至磁碟（atomic write），bot 重啟後 cooldown 仍有效
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger.js";

// ── Cooldown 時間常數 ─────────────────────────────────────────────────────────

export type CooldownReason = "rate_limit" | "overloaded" | "billing" | "auth";

const COOLDOWN_DURATION_MS: Record<CooldownReason, number> = {
  rate_limit:  5 * 60 * 60 * 1000,   // 5 小時（429）
  overloaded:      5 * 60 * 1000,    // 5 分鐘（503）
  billing:    24 * 60 * 60 * 1000,   // 24 小時（402）
  auth:                  Infinity,   // 永久（401/403）→ disabled = true
};

// ── 型別定義 ─────────────────────────────────────────────────────────────────

export interface AuthProfile {
  id: string;
  credential: string;
  lastUsed: number;         // timestamp ms，0 = 從未使用
  cooldownUntil: number;    // timestamp ms，0 = 無 cooldown
  cooldownReason?: CooldownReason;
  disabled: boolean;        // auth 失敗永久停用
}

interface StoreData {
  providerId: string;
  profiles: AuthProfile[];
  updatedAt: number;
}

// ── AuthProfileStore ──────────────────────────────────────────────────────────

export class AuthProfileStore {
  private _providerId: string;
  private _filePath: string;
  private _credentialsFilePath?: string;
  private _profiles: AuthProfile[] = [];

  constructor(opts: { providerId: string; persistPath: string; credentialsFilePath?: string }) {
    this._providerId = opts.providerId;
    mkdirSync(opts.persistPath, { recursive: true });
    this._filePath = join(opts.persistPath, `${opts.providerId}-profiles.json`);
    this._credentialsFilePath = opts.credentialsFilePath;
  }

  // ── 載入 ─────────────────────────────────────────────────────────────────────

  /**
   * 載入順序：
   * 1. 讀取狀態檔（lastUsed / cooldown / disabled）
   * 2. 若有 credentialsFilePath，讀取憑證並合併
   */
  load(): void {
    // 1. 載入狀態
    if (existsSync(this._filePath)) {
      try {
        const raw = readFileSync(this._filePath, "utf-8");
        const data = JSON.parse(raw) as StoreData;
        this._profiles = data.profiles ?? [];
        this._pruneExpiredCooldowns();
      } catch (err) {
        log.warn(`[auth-profile:${this._providerId}] 狀態檔讀取失敗，重置：${err instanceof Error ? err.message : String(err)}`);
        this._profiles = [];
      }
    } else {
      this._profiles = [];
    }

    // 2. 從外部憑證檔合併
    if (this._credentialsFilePath) {
      if (existsSync(this._credentialsFilePath)) {
        try {
          const raw = readFileSync(this._credentialsFilePath, "utf-8");
          const creds = JSON.parse(raw) as Array<{ id: string; credential: string }>;
          this._mergeCredentials(creds);
          log.info(`[auth-profile:${this._providerId}] 從憑證檔載入 ${creds.length} 組：${this._credentialsFilePath}`);
        } catch (err) {
          log.warn(`[auth-profile:${this._providerId}] 憑證檔讀取失敗：${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log.info(`[auth-profile:${this._providerId}] 憑證檔不存在，已跳過：${this._credentialsFilePath}`);
      }
    }

    log.debug(`[auth-profile:${this._providerId}] 載入完成，共 ${this._profiles.length} 組憑證`);
  }

  // ── 合併憑證 ─────────────────────────────────────────────────────────────────

  private _mergeCredentials(creds: Array<{ id: string; credential: string }>): void {
    const existing = new Map(this._profiles.map(p => [p.id, p]));
    for (const { id, credential } of creds) {
      if (existing.has(id)) {
        existing.get(id)!.credential = credential;  // 更新憑證，保留狀態
      } else {
        this._profiles.push({ id, credential, lastUsed: 0, cooldownUntil: 0, disabled: false });
        log.debug(`[auth-profile:${this._providerId}] 新增憑證 ${id}`);
      }
    }
    this._persist();
  }

  // ── 同步設定（保留供外部呼叫）────────────────────────────────────────────────

  sync(profiles: Array<{ id: string; credential: string }>): void {
    this._mergeCredentials(profiles);
  }

  // ── Round-Robin 選取 ─────────────────────────────────────────────────────────

  /**
   * 選取 lastUsed 最舊且無 cooldown 的憑證，更新 lastUsed。
   * 回傳 null 表示所有憑證都在 cooldown 或已停用。
   */
  pick(): AuthProfile | null {
    const now = Date.now();
    const available = this._profiles
      .filter(p => !p.disabled && p.cooldownUntil < now)
      .sort((a, b) => a.lastUsed - b.lastUsed);  // 最舊優先

    if (available.length === 0) return null;

    const chosen = available[0];
    chosen.lastUsed = now;
    this._persist();  // fire-and-forget（hot path）
    return chosen;
  }

  // ── Cooldown 管理 ─────────────────────────────────────────────────────────────

  setCooldown(profileId: string, reason: CooldownReason): void {
    const profile = this._profiles.find(p => p.id === profileId);
    if (!profile) return;

    if (reason === "auth") {
      profile.disabled = true;
      profile.cooldownUntil = Number.MAX_SAFE_INTEGER;
      log.warn(`[auth-profile:${this._providerId}] 憑證 ${profileId} 永久停用（auth 失敗）`);
    } else {
      profile.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS[reason];
      log.info(`[auth-profile:${this._providerId}] 憑證 ${profileId} cooldown ${reason} 直到 ${new Date(profile.cooldownUntil).toISOString()}`);
    }
    profile.cooldownReason = reason;
    this._persist();
  }

  clearCooldown(profileId: string): void {
    const profile = this._profiles.find(p => p.id === profileId);
    if (!profile || profile.disabled) return;
    profile.cooldownUntil = 0;
    profile.cooldownReason = undefined;
    this._persist();
  }

  // ── 查詢 ─────────────────────────────────────────────────────────────────────

  list(): AuthProfile[] {
    return [...this._profiles];
  }

  getAvailableCount(): number {
    const now = Date.now();
    return this._profiles.filter(p => !p.disabled && p.cooldownUntil < now).length;
  }

  isAllOnCooldown(): boolean {
    return this.getAvailableCount() === 0;
  }

  /**
   * 回傳最快可用時間（ms timestamp）。
   * 若有永久停用但無 cooldown 條目則回傳 null。
   */
  getEarliestAvailableTime(): number | null {
    const cooldownProfiles = this._profiles
      .filter(p => !p.disabled && p.cooldownUntil > Date.now())
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return cooldownProfiles[0]?.cooldownUntil ?? null;
  }

  // ── 內部工具 ─────────────────────────────────────────────────────────────────

  private _pruneExpiredCooldowns(): void {
    const now = Date.now();
    for (const p of this._profiles) {
      if (!p.disabled && p.cooldownUntil > 0 && p.cooldownUntil < now) {
        p.cooldownUntil = 0;
        p.cooldownReason = undefined;
      }
    }
  }

  private _persist(): void {
    try {
      const data: StoreData = {
        providerId: this._providerId,
        profiles: this._profiles,
        updatedAt: Date.now(),
      };
      const tmp = `${this._filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, this._filePath);
    } catch (err) {
      log.warn(`[auth-profile:${this._providerId}] 持久化失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
