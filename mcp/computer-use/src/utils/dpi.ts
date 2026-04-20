/**
 * @file utils/dpi.ts
 * @description DPI scaling 偵測與座標換算
 *
 * macOS Retina: 邏輯座標 × 2 = 實際 pixel
 * Windows 150%: 邏輯座標 × 1.5 = 實際 pixel
 * nut.js 操作使用邏輯座標，截圖回傳實際 pixel
 */

import { execSync } from "node:child_process";

let _cachedScale: number | null = null;

/**
 * 取得主螢幕 DPI 縮放因子
 * macOS: 從 system_profiler 取得 pixel/point 比
 * Windows: 從 registry 或 WMI 取得
 */
export function getDisplayScale(): number {
  if (_cachedScale !== null) return _cachedScale;

  try {
    if (process.platform === "darwin") {
      // macOS: 用 system_profiler 偵測 Retina
      const out = execSync(
        "system_profiler SPDisplaysDataType -json 2>/dev/null",
        { encoding: "utf8", timeout: 5000 },
      );
      const data = JSON.parse(out);
      const displays = data?.SPDisplaysDataType?.[0]?.spdisplays_ndrvs;
      if (displays?.[0]) {
        const res = displays[0]["_spdisplays_resolution"] as string | undefined;
        if (res?.includes("Retina")) {
          _cachedScale = 2;
          return 2;
        }
      }
      _cachedScale = 1;
      return 1;
    }

    if (process.platform === "win32") {
      // Windows: 用 PowerShell 取得 DPI
      const out = execSync(
        'powershell -c "(Get-ItemProperty \'HKCU:\\Control Panel\\Desktop\\WindowMetrics\').AppliedDPI"',
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      const dpi = parseInt(out, 10);
      if (!isNaN(dpi) && dpi > 0) {
        _cachedScale = dpi / 96;
        return _cachedScale;
      }
    }
  } catch { /* 偵測失敗，fallback */ }

  _cachedScale = 1;
  return 1;
}

/**
 * 邏輯座標 → 截圖 pixel 座標（截圖用）
 */
export function logicalToPixel(x: number, y: number): { x: number; y: number } {
  const s = getDisplayScale();
  return { x: Math.round(x * s), y: Math.round(y * s) };
}

/**
 * 截圖 pixel 座標 → 邏輯座標（nut.js 操控用）
 */
export function pixelToLogical(x: number, y: number): { x: number; y: number } {
  const s = getDisplayScale();
  return { x: Math.round(x / s), y: Math.round(y / s) };
}

/**
 * 清除快取（螢幕設定變更時）
 */
export function resetScaleCache(): void {
  _cachedScale = null;
}
