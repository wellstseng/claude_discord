/**
 * @file accounts/registry.ts
 * @description 帳號總表 + identity 反查索引
 *
 * 帳號資料存於 ~/.catclaw/accounts/
 * 索引檔：accounts/_registry.json
 *   {
 *     "accounts": { "wells": { "role": "platform-owner", "displayName": "Wells" } },
 *     "identityMap": { "discord:480042204346449920": "wells" }
 *   }
 *
 * 個人資料：accounts/{accountId}/profile.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

export type Role = "platform-owner" | "admin" | "developer" | "member" | "guest";

export type Platform = "discord" | "line" | "telegram" | "slack" | "web";

export interface Identity {
  platform: Platform;
  platformId: string;
  linkedAt: string;  // ISO 8601
}

export interface AccountPreferences {
  language?: string;
  style?: string;
  provider?: string;
  systemPromptAddition?: string;
}

export interface Account {
  accountId: string;
  displayName: string;
  role: Role;
  identities: Identity[];
  projects: string[];
  preferences: AccountPreferences;
  disabled?: boolean;
  createdAt: string;
  lastActiveAt: string;
}

// ── 索引結構 ─────────────────────────────────────────────────────────────────

interface RegistryFile {
  /** accountId → 簡要資訊（供快速查詢） */
  accounts: Record<string, { role: Role; displayName: string }>;
  /** "platform:platformId" → accountId */
  identityMap: Record<string, string>;
}

// ── AccountRegistry 類別 ─────────────────────────────────────────────────────

export class AccountRegistry {
  private readonly accountsDir: string;
  private readonly registryPath: string;

  // 記憶體快取
  private registry: RegistryFile = { accounts: {}, identityMap: {} };
  private accountCache = new Map<string, Account>();

  constructor(catclawDir: string) {
    this.accountsDir = join(catclawDir, "accounts");
    this.registryPath = join(this.accountsDir, "_registry.json");
  }

  // ── 初始化 ─────────────────────────────────────────────────────────────────

  /** 載入索引（啟動時呼叫） */
  init(): void {
    mkdirSync(this.accountsDir, { recursive: true });

    if (existsSync(this.registryPath)) {
      try {
        this.registry = JSON.parse(readFileSync(this.registryPath, "utf-8")) as RegistryFile;
        log.info(`[accounts] 載入索引：${Object.keys(this.registry.accounts).length} 個帳號`);
      } catch (err) {
        log.warn(`[accounts] 索引讀取失敗，重建空索引：${err instanceof Error ? err.message : String(err)}`);
        this.registry = { accounts: {}, identityMap: {} };
      }
    } else {
      log.info("[accounts] 索引不存在，初始化空索引");
      this.saveRegistry();
    }
  }

  // ── Identity 反查 ──────────────────────────────────────────────────────────

  /**
   * 從平台 ID 反查 accountId
   * @param platform 平台名稱
   * @param platformId 平台使用者 ID
   * @returns accountId 或 null（未知使用者）
   */
  resolveIdentity(platform: Platform, platformId: string): string | null {
    const key = `${platform}:${platformId}`;
    return this.registry.identityMap[key] ?? null;
  }

  // ── 帳號 CRUD ─────────────────────────────────────────────────────────────

  /**
   * 讀取帳號完整資料
   * 先從快取找，快取未命中才讀磁碟
   */
  get(accountId: string): Account | null {
    if (this.accountCache.has(accountId)) {
      return this.accountCache.get(accountId)!;
    }

    const profilePath = join(this.accountsDir, accountId, "profile.json");
    if (!existsSync(profilePath)) return null;

    try {
      const account = JSON.parse(readFileSync(profilePath, "utf-8")) as Account;
      this.accountCache.set(accountId, account);
      return account;
    } catch (err) {
      log.warn(`[accounts] 讀取帳號 ${accountId} 失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 建立新帳號
   * 同時更新索引 + 寫入 profile.json
   */
  create(opts: {
    accountId: string;
    displayName: string;
    role: Role;
    identities?: Identity[];
    preferences?: AccountPreferences;
  }): Account {
    if (this.registry.accounts[opts.accountId]) {
      throw new Error(`帳號 ${opts.accountId} 已存在`);
    }

    const now = new Date().toISOString();
    const account: Account = {
      accountId: opts.accountId,
      displayName: opts.displayName,
      role: opts.role,
      identities: opts.identities ?? [],
      projects: [],
      preferences: opts.preferences ?? {},
      createdAt: now,
      lastActiveAt: now,
    };

    this.saveAccount(account);
    return account;
  }

  /**
   * 更新帳號資料（部分更新）
   */
  update(accountId: string, patch: Partial<Omit<Account, "accountId" | "createdAt">>): Account {
    const account = this.get(accountId);
    if (!account) throw new Error(`帳號 ${accountId} 不存在`);

    const updated: Account = { ...account, ...patch, accountId, createdAt: account.createdAt };
    this.saveAccount(updated);
    return updated;
  }

  /**
   * 綁定新 identity 到帳號
   */
  linkIdentity(accountId: string, platform: Platform, platformId: string): void {
    const account = this.get(accountId);
    if (!account) throw new Error(`帳號 ${accountId} 不存在`);

    const key = `${platform}:${platformId}`;

    // 防止重複綁定到不同帳號
    const existing = this.registry.identityMap[key];
    if (existing && existing !== accountId) {
      throw new Error(`${key} 已綁定至帳號 ${existing}`);
    }

    const identity: Identity = { platform, platformId, linkedAt: new Date().toISOString() };
    account.identities = [...account.identities.filter(i => !(i.platform === platform && i.platformId === platformId)), identity];
    this.saveAccount(account);
  }

  /**
   * 更新 lastActiveAt（每次 turn 後呼叫）
   */
  touch(accountId: string): void {
    const profilePath = join(this.accountsDir, accountId, "profile.json");
    if (!existsSync(profilePath)) return;
    try {
      const account = this.get(accountId);
      if (!account) return;
      account.lastActiveAt = new Date().toISOString();
      this.accountCache.set(accountId, account);
      writeFileSync(profilePath, JSON.stringify(account, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[accounts] touch ${accountId} 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 列舉 ──────────────────────────────────────────────────────────────────

  /** 列出所有 accountId */
  listAccountIds(): string[] {
    return Object.keys(this.registry.accounts);
  }

  /** 取得索引摘要（accountId → role + displayName） */
  getIndex(): RegistryFile["accounts"] {
    return this.registry.accounts;
  }

  // ── 內部：持久化 ──────────────────────────────────────────────────────────

  private saveAccount(account: Account): void {
    const dir = join(this.accountsDir, account.accountId);
    mkdirSync(dir, { recursive: true });

    // 寫入 profile.json
    writeFileSync(join(dir, "profile.json"), JSON.stringify(account, null, 2), "utf-8");

    // 更新記憶體快取
    this.accountCache.set(account.accountId, account);

    // 更新索引
    this.registry.accounts[account.accountId] = {
      role: account.role,
      displayName: account.displayName,
    };

    // 更新 identity map
    for (const id of account.identities) {
      this.registry.identityMap[`${id.platform}:${id.platformId}`] = account.accountId;
    }

    this.saveRegistry();
  }

  private saveRegistry(): void {
    try {
      writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[accounts] 索引寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
