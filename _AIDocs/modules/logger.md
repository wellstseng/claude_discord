# modules/logger — Log Level 控制

> 檔案：`src/logger.ts`

## 職責

提供層級化 log 輸出，取代直接使用 `console.log`。

## 層級

| 層級 | 數值 | 輸出方式 | 用途 |
|------|------|---------|------|
| `debug` | 0 | `console.log` | 串流細節、訊息過濾結果 |
| `info` | 1 | `console.log` | Bot 上線、session 建立（預設） |
| `warn` | 2 | `console.warn` | 警告 |
| `error` | 3 | `console.error` | 錯誤 |
| `silent` | 4 | — | 完全靜音 |

## 內部實作

### 常數

```typescript
const LEVELS: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, silent: 4,
};
```

### 內部狀態

```typescript
let currentLevel: LogLevel = "info";  // 預設 info
```

### `shouldLog(level): boolean`（私有）

`LEVELS[level] >= LEVELS[currentLevel]` — 數值比較。

### `log` 物件（對外 export）

```typescript
export const log = {
  debug: (...args) => { if (shouldLog("debug")) console.log(...args); },
  info:  (...args) => { if (shouldLog("info"))  console.log(...args); },
  warn:  (...args) => { if (shouldLog("warn"))  console.warn(...args); },
  error: (...args) => { if (shouldLog("error")) console.error(...args); },
};
```

`debug` 和 `info` 用 `console.log`，`warn` 用 `console.warn`，`error` 用 `console.error`。

## API

```typescript
import { log, setLogLevel } from "./logger.js";

setLogLevel("debug");   // 由 index.ts 啟動時呼叫

log.debug("...");        // 只在 debug 層級顯示
log.info("...");         // debug + info 層級顯示
log.warn("...");         // debug + info + warn 層級顯示
log.error("...");        // debug + info + warn + error 層級顯示
```

## 設定

`config.json` 的 `logLevel` 欄位，由 `index.ts` 呼叫 `setLogLevel()` 設定。

## 注意事項

- `silent` 層級設定後所有 log 靜默（shouldLog 永遠 false）
- 沒有 `log.silent` 方法，`silent` 只是設定值
