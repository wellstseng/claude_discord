/**
 * @file tools/windows.ts
 * @description computer_windows — 視窗列表、聚焦、最小化/最大化/關閉
 */

import { getWindows } from "@nut-tree-fork/nut-js";
import { isWindowAllowed } from "../utils/safety.js";

export interface WindowsParams {
  action: "list" | "focus" | "minimize";
  title?: string;
  pid?: number;
}

interface WindowInfo {
  title: string;
  pid?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function performWindows(params: WindowsParams): Promise<Record<string, unknown>> {
  const wins = await getWindows();

  if (params.action === "list") {
    const infos: WindowInfo[] = [];
    for (const w of wins) {
      try {
        const title = await w.getTitle();
        if (!title) continue;
        const region = await w.getRegion();
        infos.push({
          title,
          x: region.left,
          y: region.top,
          width: region.width,
          height: region.height,
        });
      } catch { /* 跳過無法讀取的視窗 */ }
    }
    return { windows: infos, count: infos.length, timestamp: new Date().toISOString() };
  }

  // 找到目標視窗
  const target = await findWindow(wins, params.title, params.pid);
  if (!target) {
    throw new Error(`找不到視窗${params.title ? `：${params.title}` : ""}${params.pid ? ` (pid=${params.pid})` : ""}`);
  }

  const title = await target.getTitle();
  if (!isWindowAllowed(title)) {
    throw new Error(`視窗 "${title}" 不在白名單中`);
  }

  switch (params.action) {
    case "focus":
      await target.focus();
      return { success: true, focused: title, timestamp: new Date().toISOString() };
    case "minimize":
      await target.minimize();
      return { success: true, minimized: title, timestamp: new Date().toISOString() };
    default:
      throw new Error(`不支援的 action: ${params.action}（nut-js 僅支援 focus/minimize）`);
  }
}

async function findWindow(
  wins: Awaited<ReturnType<typeof getWindows>>,
  title?: string,
  pid?: number,
): Promise<Awaited<ReturnType<typeof getWindows>>[number] | null> {
  for (const w of wins) {
    try {
      if (pid != null) {
        const wPid = (w as unknown as { processId?: number }).processId;
        if (wPid === pid) return w;
      }
      if (title) {
        const wTitle = await w.getTitle();
        if (wTitle.toLowerCase().includes(title.toLowerCase())) return w;
      }
    } catch { /* skip */ }
  }
  return null;
}
