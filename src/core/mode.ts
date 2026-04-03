/**
 * @file core/mode.ts
 * @description Mode Runtime — per-channel 模式管理（一般/精密/自訂）
 *
 * 模式影響：thinking level、CE 策略、system prompt 額外區段、tool budget
 * 模式定義在 config.modes.presets，可自訂。
 */

import { config, BUILTIN_MODE_PRESETS, type ModePreset, type ThinkingLevel } from "./config.js";
import { log } from "../logger.js";

// ── per-channel mode store ───────────────────────────────────────────────────

const _channelMode = new Map<string, string>();

/** 取得 channel 當前模式名稱 */
export function getChannelMode(channelId: string): string {
  return _channelMode.get(channelId) ?? getDefaultMode();
}

/** 設定 channel 模式 */
export function setChannelMode(channelId: string, modeName: string): void {
  _channelMode.set(channelId, modeName);
  log.info(`[mode] channel=${channelId} → ${modeName}`);
}

/** 重設 channel 為預設模式 */
export function resetChannelMode(channelId: string): void {
  _channelMode.delete(channelId);
}

// ── Mode Preset 解析 ─────────────────────────────────────────────────────────

/** 取得預設模式名稱 */
export function getDefaultMode(): string {
  return config.modes?.defaultMode ?? "normal";
}

/** 取得所有可用模式名稱 */
export function listModes(): string[] {
  const configPresets = config.modes?.presets ?? {};
  const allNames = new Set([...Object.keys(BUILTIN_MODE_PRESETS), ...Object.keys(configPresets)]);
  return Array.from(allNames);
}

/** 解析模式名稱 → ModePreset（config 覆寫 builtin） */
export function resolveMode(modeName: string): ModePreset | undefined {
  const configPresets = config.modes?.presets ?? {};
  // config 優先，允許覆寫 builtin
  const preset = configPresets[modeName] ?? BUILTIN_MODE_PRESETS[modeName];
  if (!preset) return undefined;
  // 合併：config preset 覆寫 builtin 同名欄位
  const builtin = BUILTIN_MODE_PRESETS[modeName];
  if (builtin && configPresets[modeName]) {
    return { ...builtin, ...configPresets[modeName] };
  }
  return preset;
}

/** 取得 channel 當前解析後的 ModePreset */
export function getChannelModePreset(channelId: string): ModePreset {
  const modeName = getChannelMode(channelId);
  return resolveMode(modeName) ?? BUILTIN_MODE_PRESETS["normal"]!;
}

/** 模式的 thinking level（null → undefined，供 agent-loop 使用） */
export function getModeThinking(preset: ModePreset): ThinkingLevel | undefined {
  return preset.thinking ?? undefined;
}
