/**
 * @file skills/types.ts
 * @description Skill 系統型別定義
 *
 * Phase 0：Command-type Skill — 使用者觸發，CatClaw 直接執行，不送 Claude CLI。
 * tier 欄位現階段不強制檢查，後接 S5 Permission Gate 時啟用。
 */

import type { Message } from "discord.js";
import type { BridgeConfig } from "../config.js";

// ── Tier 定義（先定義好，S5 啟用 Permission Gate 時用） ──────────────────────

export type SkillTier = "public" | "standard" | "elevated" | "admin" | "owner";

// ── Skill Context ────────────────────────────────────────────────────────────

export interface SkillContext {
  /** trigger 後的剩餘文字（參數） */
  args: string;
  /** 原始 Discord 訊息物件 */
  message: Message;
  channelId: string;
  authorId: string;
  config: BridgeConfig;
}

// ── Skill Result ─────────────────────────────────────────────────────────────

export interface SkillResult {
  text: string;
  isError?: boolean;
}

// ── Skill 介面 ───────────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  /** 權限層級，現階段不強制，後接 S5 Permission Gate */
  tier: SkillTier;
  /** 觸發字串清單（lowercase 比對，前綴匹配） */
  trigger: string[];

  /** 前置環境檢查（可選），失敗直接回傳錯誤 */
  preflight?(ctx: SkillContext): Promise<{ ok: boolean; reason?: string }>;

  /** 執行邏輯 */
  execute(ctx: SkillContext): Promise<SkillResult>;
}
