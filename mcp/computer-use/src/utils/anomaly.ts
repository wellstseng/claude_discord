/**
 * @file utils/anomaly.ts
 * @description 卡住偵測 — 連續截圖 diff 比對，畫面無變化時警告
 */

import sharp from "sharp";

const STUCK_THRESHOLD = parseInt(process.env["COMPUTER_USE_STUCK_THRESHOLD"] ?? "3", 10);
const DIFF_TOLERANCE = parseFloat(process.env["COMPUTER_USE_DIFF_TOLERANCE"] ?? "0.02");

let previousScreenshot: Buffer | null = null;
let unchangedCount = 0;

/**
 * 比較當前截圖與前一張，回傳差異比例和卡住狀態
 * 使用簡化的像素比較（不依賴 pixelmatch，用 sharp 降解析度後逐 pixel 比）
 */
export async function checkForStuck(currentScreenshot: Buffer): Promise<{
  diffRatio: number;
  isStuck: boolean;
  unchangedCount: number;
}> {
  if (!previousScreenshot) {
    previousScreenshot = currentScreenshot;
    unchangedCount = 0;
    return { diffRatio: 1, isStuck: false, unchangedCount: 0 };
  }

  const diffRatio = await computeDiffRatio(previousScreenshot, currentScreenshot);
  previousScreenshot = currentScreenshot;

  if (diffRatio < DIFF_TOLERANCE) {
    unchangedCount++;
  } else {
    unchangedCount = 0;
  }

  return {
    diffRatio,
    isStuck: unchangedCount >= STUCK_THRESHOLD,
    unchangedCount,
  };
}

/**
 * 計算兩張圖片的差異比例（0=完全相同，1=完全不同）
 * 先縮小到 100x100 再逐 pixel 比較，效能好
 */
async function computeDiffRatio(a: Buffer, b: Buffer): Promise<number> {
  const size = 100;
  const [rawA, rawB] = await Promise.all([
    sharp(a).resize(size, size, { fit: "fill" }).raw().toBuffer(),
    sharp(b).resize(size, size, { fit: "fill" }).raw().toBuffer(),
  ]);

  if (rawA.length !== rawB.length) return 1;

  let diffPixels = 0;
  const totalPixels = size * size;
  const channels = rawA.length / totalPixels; // 3 (RGB) or 4 (RGBA)

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * channels;
    let pixelDiff = false;
    for (let c = 0; c < Math.min(channels, 3); c++) {
      if (Math.abs((rawA[offset + c] ?? 0) - (rawB[offset + c] ?? 0)) > 10) {
        pixelDiff = true;
        break;
      }
    }
    if (pixelDiff) diffPixels++;
  }

  return diffPixels / totalPixels;
}

/**
 * 重置卡住偵測狀態
 */
export function resetStuckDetection(): void {
  previousScreenshot = null;
  unchangedCount = 0;
}
