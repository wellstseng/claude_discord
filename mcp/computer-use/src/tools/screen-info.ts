/**
 * @file tools/screen-info.ts
 * @description computer_screen_info — 螢幕資訊查詢
 */

import { screen, mouse } from "@nut-tree-fork/nut-js";
import { getDisplayScale } from "../utils/dpi.js";

export async function getScreenInfo(): Promise<Record<string, unknown>> {
  const w = await screen.width();
  const h = await screen.height();
  const cursorPos = await mouse.getPosition();
  const dpiScale = getDisplayScale();

  return {
    monitors: [
      {
        id: 0,
        width: w,
        height: h,
        dpiScale,
        isPrimary: true,
      },
    ],
    platform: process.platform,
    cursorPosition: { x: cursorPos.x, y: cursorPos.y },
    timestamp: new Date().toISOString(),
  };
}
