/**
 * @file tools/click.ts
 * @description computer_click — 滑鼠點擊指定座標
 */

import { mouse, Button, Point, Key, keyboard } from "@nut-tree-fork/nut-js";
import { validateCoordinates, checkRateLimit } from "../utils/safety.js";

export interface ClickParams {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clicks?: number;
  modifiers?: Array<"ctrl" | "alt" | "shift" | "meta" | "cmd">;
  holdMs?: number;
}

const BUTTON_MAP: Record<string, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

const MODIFIER_MAP: Record<string, Key> = {
  ctrl: Key.LeftControl,
  alt: Key.LeftAlt,
  shift: Key.LeftShift,
  meta: process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin,
  cmd: process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin,
};

export async function performClick(params: ClickParams): Promise<{ success: boolean; clickedAt: { x: number; y: number }; button: string; timestamp: string }> {
  checkRateLimit();
  await validateCoordinates(params.x, params.y);

  const btn = BUTTON_MAP[params.button ?? "left"] ?? Button.LEFT;
  const clicks = params.clicks ?? 1;
  const point = new Point(params.x, params.y);

  // 按下 modifier keys
  const modKeys = (params.modifiers ?? []).map(m => MODIFIER_MAP[m]).filter((k): k is Key => k != null);
  for (const k of modKeys) await keyboard.pressKey(k);

  try {
    await mouse.setPosition(point);

    if (params.holdMs && params.holdMs > 0) {
      await mouse.pressButton(btn);
      await new Promise(r => setTimeout(r, params.holdMs));
      await mouse.releaseButton(btn);
    } else {
      for (let i = 0; i < clicks; i++) {
        await mouse.click(btn);
        if (i < clicks - 1) await new Promise(r => setTimeout(r, 50));
      }
    }
  } finally {
    // 釋放 modifier keys
    for (const k of modKeys) await keyboard.releaseKey(k);
  }

  return {
    success: true,
    clickedAt: { x: params.x, y: params.y },
    button: params.button ?? "left",
    timestamp: new Date().toISOString(),
  };
}
