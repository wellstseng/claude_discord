/**
 * @file tools/screenshot.ts
 * @description computer_screenshot — 截取螢幕或指定區域/視窗
 */

import { screen, Region, getWindows } from "@nut-tree-fork/nut-js";
import { processScreenshot, cropImage } from "../utils/image.js";
import { updateScreenshotScale } from "../utils/coordinate.js";

export interface ScreenshotParams {
  windowTitle?: string;
  region?: { x: number; y: number; width: number; height: number };
  scale?: number;
  monitor?: number;
}

export interface ScreenshotResult {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export async function takeScreenshot(params: ScreenshotParams): Promise<ScreenshotResult> {
  let rawBuf: Buffer;

  if (params.windowTitle) {
    // 嘗試找到指定視窗並截取
    try {
      const wins = await getWindows();
      const target = wins.find(w => {
        try {
          const title = (w as unknown as { title: string }).title ?? "";
          return title.toLowerCase().includes(params.windowTitle!.toLowerCase());
        } catch { return false; }
      });

      if (target) {
        const region = await target.getRegion();
        const grabbed = await screen.grabRegion(region);
        rawBuf = await grabbed.toRGB().then(rgb => {
          // nut-js 回傳 Image，需要轉成 PNG buffer
          return imageToBuffer(grabbed);
        });
      } else {
        // 找不到視窗，截全螢幕
        rawBuf = await grabFullScreen();
      }
    } catch {
      rawBuf = await grabFullScreen();
    }
  } else if (params.region) {
    const r = params.region;
    const grabbed = await screen.grabRegion(new Region(r.x, r.y, r.width, r.height));
    rawBuf = await imageToBuffer(grabbed);
  } else {
    rawBuf = await grabFullScreen();
  }

  const result = await processScreenshot(rawBuf, params.scale);
  updateScreenshotScale(result.width, result.originalWidth);
  return result;
}

async function grabFullScreen(): Promise<Buffer> {
  const grabbed = await screen.grab();
  return imageToBuffer(grabbed);
}

/**
 * 將 nut-js Image 轉成 PNG Buffer
 * nut-js v4 的 Image: { width, height, data (Buffer), pixelDensity }
 * Windows 回傳 BGRA，macOS 回傳 RGBA — 需要交換 R/B 通道
 */
async function imageToBuffer(img: Awaited<ReturnType<typeof screen.grab>>): Promise<Buffer> {
  const { width, height, data } = img;
  const buf = Buffer.from(data);

  // Windows: nut-js 回傳 BGRA，需轉為 RGBA（交換 R 和 B）
  if (process.platform === "win32") {
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i]!;
      buf[i] = buf[i + 2]!;
      buf[i + 2] = r;
    }
  }

  const { default: sharp } = await import("sharp");
  return sharp(buf, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
}
