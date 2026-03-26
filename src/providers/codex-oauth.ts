/**
 * @file providers/codex-oauth.ts
 * @description OpenAI Codex OAuth Provider
 *
 * 認證流程：
 * 1. 讀取 ~/.codex/auth.json（或 oauthTokenPath 自訂路徑）
 * 2. 檢查 expires_at → 過期時發 HTTP refresh 請求
 * 3. 更新 auth.json + 用 access_token 作 Bearer header
 *
 * auth.json 格式（OpenAI OAuth 標準格式）：
 * {
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "expires_at": 1234567890,   // epoch seconds
 *   "token_type": "Bearer"
 * }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderEntry } from "../core/config.js";

// ── OAuth token JSON 格式 ─────────────────────────────────────────────────────

interface CodexAuthJson {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;    // epoch seconds
  token_type?: string;
}

// ── 預設值 ────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_PATH = "~/.codex/auth.json";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5.3-codex";

// token 提前 5 分鐘刷新
const REFRESH_BUFFER_MS = 5 * 60_000;

// ── CodexOAuthProvider ────────────────────────────────────────────────────────

export class CodexOAuthProvider extends OpenAICompatProvider {
  private tokenPath: string;
  private refreshUrl: string;
  private clientId?: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;  // epoch ms

  constructor(id: string, entry: ProviderEntry) {
    // 先以空 apiKey 初始化父類，stream() 前再注入 token
    super(id, {
      ...entry,
      baseUrl: entry.baseUrl ?? DEFAULT_BASE_URL,
      model: entry.model ?? DEFAULT_MODEL,
      apiKey: undefined,
    });

    const rawPath = (entry as unknown as Record<string, unknown>)["oauthTokenPath"] as string | undefined
      ?? DEFAULT_TOKEN_PATH;
    this.tokenPath = rawPath.startsWith("~") ? rawPath.replace("~", homedir()) : resolve(rawPath);

    this.refreshUrl = (entry as unknown as Record<string, unknown>)["oauthRefreshUrl"] as string | undefined
      ?? DEFAULT_REFRESH_URL;

    this.clientId = (entry as unknown as Record<string, unknown>)["oauthClientId"] as string | undefined;
  }

  // ── Token 取得（含自動刷新） ───────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    // 仍有效 → 直接回傳
    if (this.cachedToken && now < this.tokenExpiresAt - REFRESH_BUFFER_MS) {
      return this.cachedToken;
    }

    // 讀取 auth.json
    if (!existsSync(this.tokenPath)) {
      throw new Error(
        `[codex-oauth] auth.json 不存在：${this.tokenPath}\n` +
        `請先安裝 Codex CLI 並執行 codex auth login`
      );
    }

    let auth: CodexAuthJson;
    try {
      auth = JSON.parse(readFileSync(this.tokenPath, "utf-8")) as CodexAuthJson;
    } catch (err) {
      throw new Error(`[codex-oauth] 解析 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    // 尚未過期 → 直接用
    const expiresAtMs = (auth.expires_at ?? 0) * 1000;
    if (auth.access_token && now < expiresAtMs - REFRESH_BUFFER_MS) {
      this.cachedToken = auth.access_token;
      this.tokenExpiresAt = expiresAtMs;
      return auth.access_token;
    }

    // 需要刷新
    if (!auth.refresh_token) {
      throw new Error(`[codex-oauth] token 已過期且無 refresh_token，請重新執行 codex auth login`);
    }

    log.info(`[codex-oauth] token 過期，刷新中...`);
    const newAuth = await this._refresh(auth.refresh_token);

    // 寫回 auth.json
    try {
      writeFileSync(this.tokenPath, JSON.stringify(newAuth, null, 2), "utf-8");
    } catch (err) {
      log.warn(`[codex-oauth] 寫回 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    this.cachedToken = newAuth.access_token;
    this.tokenExpiresAt = (newAuth.expires_at ?? 0) * 1000;
    return newAuth.access_token;
  }

  private async _refresh(refreshToken: string): Promise<CodexAuthJson> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    };
    if (this.clientId) body["client_id"] = this.clientId;

    const resp = await fetch(this.refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`[codex-oauth] refresh 失敗 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as Record<string, unknown>;

    // 標準化回傳（不同服務欄位名稱略有差異）
    const expiresIn = (data["expires_in"] as number | undefined) ?? 3600;
    return {
      access_token: data["access_token"] as string,
      refresh_token: (data["refresh_token"] as string | undefined) ?? refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: (data["token_type"] as string | undefined) ?? "Bearer",
    };
  }

  // ── 覆寫 stream()：每次呼叫前注入最新 token ────────────────────────────────

  override async stream(
    ...args: Parameters<OpenAICompatProvider["stream"]>
  ): ReturnType<OpenAICompatProvider["stream"]> {
    const token = await this.getAccessToken();
    // 注入 token 到父類的 apiKey（透過內部 property）
    (this as unknown as { apiKey: string }).apiKey = token;
    return super.stream(...args);
  }
}
