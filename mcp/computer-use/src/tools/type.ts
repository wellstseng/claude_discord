/**
 * @file tools/type.ts
 * @description computer_type — 鍵盤輸入文字或按鍵組合
 */

import { keyboard, Key } from "@nut-tree-fork/nut-js";
import { checkRateLimit } from "../utils/safety.js";

export interface TypeParams {
  text?: string;
  keys?: string[];
  delayMs?: number;
}

/** 特殊鍵名 → nut-js Key 對照 */
const KEY_MAP: Record<string, Key> = {
  enter: Key.Enter,
  return: Key.Enter,
  tab: Key.Tab,
  escape: Key.Escape,
  esc: Key.Escape,
  backspace: Key.Backspace,
  delete: Key.Delete,
  space: Key.Space,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
  f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4,
  f5: Key.F5, f6: Key.F6, f7: Key.F7, f8: Key.F8,
  f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  alt: Key.LeftAlt,
  option: Key.LeftAlt,
  shift: Key.LeftShift,
  meta: process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin,
  cmd: process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin,
  command: process.platform === "darwin" ? Key.LeftCmd : Key.LeftWin,
  win: Key.LeftWin,
  super: Key.LeftWin,
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E,
  f: Key.F, g: Key.G, h: Key.H, i: Key.I, j: Key.J,
  k: Key.K, l: Key.L, m: Key.M, n: Key.N, o: Key.O,
  p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T,
  u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y,
  z: Key.Z,
  "0": Key.Num0, "1": Key.Num1, "2": Key.Num2, "3": Key.Num3, "4": Key.Num4,
  "5": Key.Num5, "6": Key.Num6, "7": Key.Num7, "8": Key.Num8, "9": Key.Num9,
};

export async function performType(params: TypeParams): Promise<{ success: boolean; typed?: string; pressed?: string[]; timestamp: string }> {
  checkRateLimit();

  if (!params.text && !params.keys?.length) {
    throw new Error("必須提供 text 或 keys 其中之一");
  }

  if (params.keys?.length) {
    // 組合鍵模式：同時按下所有鍵
    const nutKeys = params.keys.map(k => {
      const mapped = KEY_MAP[k.toLowerCase()];
      if (!mapped) throw new Error(`不支援的按鍵：${k}`);
      return mapped;
    });

    // 按下所有鍵
    for (const k of nutKeys) await keyboard.pressKey(k);
    // 短暫延遲確保系統處理
    await new Promise(r => setTimeout(r, 50));
    // 反序釋放
    for (let i = nutKeys.length - 1; i >= 0; i--) await keyboard.releaseKey(nutKeys[i]!);

    return {
      success: true,
      pressed: params.keys,
      timestamp: new Date().toISOString(),
    };
  }

  // 文字輸入模式
  const delay = params.delayMs ?? 50;
  keyboard.config.autoDelayMs = delay;
  await keyboard.type(params.text!);

  return {
    success: true,
    typed: params.text,
    timestamp: new Date().toISOString(),
  };
}
