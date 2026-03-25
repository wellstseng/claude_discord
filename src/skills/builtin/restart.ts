/**
 * @file skills/builtin/restart.ts
 * @description 重啟 CatClaw skill
 *
 * 觸發：「重啟」「重啟catclaw」「restart」「restart catclaw」
 * 效果：寫入 signal/RESTART → PM2 偵測後自動重啟
 * tier：admin（現階段不強制，S5 Permission Gate 啟用後生效）
 */

import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 寫入 signal/RESTART 觸發 PM2 watch 重啟 */
function writeRestartSignal(channelId: string): void {
  // signal 目錄在專案根目錄（builtin/ → skills/ → src/ → 根目錄）
  const signalDir = resolve(__dirname, "..", "..", "..", "signal");
  mkdirSync(signalDir, { recursive: true });
  const signalPath = join(signalDir, "RESTART");

  // 先刪除舊檔，確保 PM2 watch 偵測到 create 事件
  if (existsSync(signalPath)) rmSync(signalPath);

  writeFileSync(
    signalPath,
    JSON.stringify({ channelId, time: new Date().toISOString() }),
    "utf-8"
  );
}

export const skill: Skill = {
  name: "restart",
  description: "重啟 CatClaw bot",
  tier: "admin",
  trigger: ["重啟", "重啟catclaw", "重啟 catclaw", "restart", "restart catclaw"],

  async execute(ctx) {
    writeRestartSignal(ctx.channelId);
    return { text: "🔄 重啟信號已送出，幾秒後重新上線。" };
  },
};
