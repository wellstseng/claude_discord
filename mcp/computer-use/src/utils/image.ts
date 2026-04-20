/**
 * @file utils/image.ts
 * @description 圖片處理：縮放、base64 轉換
 *
 * Anthropic Vision 最佳實踐：長邊 ≤1568px，短邊 ≤768px
 * 超過時自動等比縮放，減少 token 消耗
 */

import sharp from "sharp";

const MAX_LONG_SIDE = 1568;
const MAX_SHORT_SIDE = 768;

export interface ImageResult {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/**
 * 將原始截圖 buffer 縮放到適合 Vision API 的尺寸
 * @param buf 原始圖片 buffer（PNG）
 * @param scale 手動縮放比例（0.1-1.0），null = 自動
 */
export async function processScreenshot(buf: Buffer, scale?: number | null): Promise<ImageResult> {
  const meta = await sharp(buf).metadata();
  const origW = meta.width ?? 1920;
  const origH = meta.height ?? 1080;

  let targetW = origW;
  let targetH = origH;

  if (scale != null && scale > 0 && scale < 1) {
    targetW = Math.round(origW * scale);
    targetH = Math.round(origH * scale);
  } else {
    // 自動縮放：符合 Anthropic Vision 最佳實踐
    const longSide = Math.max(origW, origH);
    const shortSide = Math.min(origW, origH);

    let ratio = 1;
    if (longSide > MAX_LONG_SIDE) ratio = Math.min(ratio, MAX_LONG_SIDE / longSide);
    if (shortSide * ratio > MAX_SHORT_SIDE) ratio = Math.min(ratio, MAX_SHORT_SIDE / shortSide);

    if (ratio < 1) {
      targetW = Math.round(origW * ratio);
      targetH = Math.round(origH * ratio);
    }
  }

  const resized = (targetW !== origW || targetH !== origH)
    ? await sharp(buf).resize(targetW, targetH, { fit: "fill" }).png().toBuffer()
    : buf;

  return {
    base64: resized.toString("base64"),
    mimeType: "image/png",
    width: targetW,
    height: targetH,
    originalWidth: origW,
    originalHeight: origH,
  };
}

/**
 * 裁切圖片指定區域
 */
export async function cropImage(buf: Buffer, region: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  return sharp(buf)
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .toBuffer();
}
