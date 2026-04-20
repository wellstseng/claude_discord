/**
 * @file tools/scroll.ts
 * @description computer_scroll — 滾輪操作
 */

import { mouse, Point } from "@nut-tree-fork/nut-js";
import { validateCoordinates, checkRateLimit } from "../utils/safety.js";

export interface ScrollParams {
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export async function performScroll(params: ScrollParams): Promise<{ success: boolean; timestamp: string }> {
  checkRateLimit();
  await validateCoordinates(params.x, params.y);

  const amount = params.amount ?? 3;
  await mouse.setPosition(new Point(params.x, params.y));

  // nut-js scrollDown/scrollUp 每次滾動 1 行
  const scrollFn = params.direction === "down" ? mouse.scrollDown
    : params.direction === "up" ? mouse.scrollUp
    : params.direction === "left" ? mouse.scrollLeft
    : mouse.scrollRight;

  for (let i = 0; i < amount; i++) {
    await scrollFn(1);
  }

  return { success: true, timestamp: new Date().toISOString() };
}
