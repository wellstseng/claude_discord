/**
 * @file tools/cursor.ts
 * @description computer_cursor — 移動游標、取得位置、拖曳
 */

import { mouse, Point, Button } from "@nut-tree-fork/nut-js";
import { validateCoordinates, checkRateLimit } from "../utils/safety.js";

export interface CursorParams {
  action: "move" | "position" | "drag";
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
}

export async function performCursor(params: CursorParams): Promise<Record<string, unknown>> {
  checkRateLimit();

  if (params.action === "position") {
    const pos = await mouse.getPosition();
    return { x: pos.x, y: pos.y, timestamp: new Date().toISOString() };
  }

  if (params.action === "move") {
    if (params.x == null || params.y == null) throw new Error("move 需要 x, y");
    await validateCoordinates(params.x, params.y);
    await mouse.setPosition(new Point(params.x, params.y));
    return { success: true, movedTo: { x: params.x, y: params.y }, timestamp: new Date().toISOString() };
  }

  if (params.action === "drag") {
    const sx = params.startX ?? params.x;
    const sy = params.startY ?? params.y;
    if (sx == null || sy == null || params.x == null || params.y == null) {
      throw new Error("drag 需要起點和終點座標");
    }
    await validateCoordinates(sx, sy);
    await validateCoordinates(params.x, params.y);

    await mouse.setPosition(new Point(sx, sy));
    await mouse.pressButton(Button.LEFT);
    await mouse.setPosition(new Point(params.x, params.y));
    await new Promise(r => setTimeout(r, 100));
    await mouse.releaseButton(Button.LEFT);

    return {
      success: true,
      from: { x: sx, y: sy },
      to: { x: params.x, y: params.y },
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`未知的 action: ${params.action}`);
}
