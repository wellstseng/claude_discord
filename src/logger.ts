/**
 * @file logger.ts
 * @description 簡易 log level 控制
 *
 * 層級由低到高：debug < info < warn < error < silent
 * 預設 info。可透過 setLogLevel() 在啟動時設定。
 */

/** 支援的 log level */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let currentLevel: LogLevel = "info";

/** 設定 log 層級（由 index.ts 在啟動時呼叫） */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `[${hh}:${mm}:${ss}.${ms}]`;
}

export const log = {
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) console.log(ts(), ...args);
  },
  info: (...args: unknown[]) => {
    if (shouldLog("info")) console.log(ts(), ...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(ts(), ...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) console.error(ts(), ...args);
  },
};
