/**
 * @file utils/safety.ts
 * @description 安全機制：座標邊界檢查、視窗白名單、操作速率限制
 */

import { screen } from "@nut-tree-fork/nut-js";

// ── 設定 ─────────────────────────────────────────────────────────────────────

const ALLOWED_WINDOWS = (process.env["COMPUTER_USE_ALLOWED_WINDOWS"] ?? "*").split(",").map(s => s.trim());
const MAX_OPS_PER_SEC = parseInt(process.env["COMPUTER_USE_MAX_OPS_PER_SEC"] ?? "10", 10);

// ── 座標邊界檢查 ─────────────────────────────────────────────────────────────

export async function validateCoordinates(x: number, y: number): Promise<void> {
  const w = await screen.width();
  const h = await screen.height();
  if (x < 0 || y < 0 || x > w || y > h) {
    throw new Error(`座標 (${x}, ${y}) 超出螢幕範圍 (${w}×${h})`);
  }
}

// ── 視窗白名單 ───────────────────────────────────────────────────────────────

export function isWindowAllowed(windowTitle: string): boolean {
  if (ALLOWED_WINDOWS.length === 1 && ALLOWED_WINDOWS[0] === "*") return true;
  return ALLOWED_WINDOWS.some(pattern => {
    if (pattern === "*") return true;
    // 簡單 glob：* 匹配任意字串
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
    return regex.test(windowTitle);
  });
}

// ── 速率限制 ─────────────────────────────────────────────────────────────────

const opTimestamps: number[] = [];

export function checkRateLimit(): void {
  const now = Date.now();
  // 移除 1 秒前的記錄
  while (opTimestamps.length > 0 && opTimestamps[0]! < now - 1000) {
    opTimestamps.shift();
  }
  if (opTimestamps.length >= MAX_OPS_PER_SEC) {
    throw new Error(`操作速率超限（最多 ${MAX_OPS_PER_SEC} 次/秒）`);
  }
  opTimestamps.push(now);
}
