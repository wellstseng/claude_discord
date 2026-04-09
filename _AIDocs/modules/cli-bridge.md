# CLI Bridge 模組

> 原始碼：`src/cli-bridge/` | 建立：2026-04-09

## 定位

第三條訊息處理路徑，與 Agent Loop（溫蒂）並行。透過持久 `claude -p --input-format stream-json` process，讓 Claude CLI（含原子記憶系統）可經由 CatClaw Discord 介面遠端通訊。

## 檔案結構

| 檔案 | 職責 |
|------|------|
| `types.ts` | 所有共用型別：stdin/stdout 事件、設定、TurnHandle、TurnRecord |
| `process.ts` | `CliProcess` — 持久 child process 封裝（EventEmitter、stdout diff 解析） |
| `bridge.ts` | `CliBridge` — 生命週期管理（直送 stdin、自動重啟、keep-alive、中斷） |
| `stdout-log.ts` | `StdoutLogger` — JSONL 日誌 + 記憶體快取 + WebSocket hook |
| `index.ts` | 全域單例：`initCliBridges` / `getCliBridge` / `shutdownAllBridges` |

## 關鍵設計

- **不排隊，直送 stdin** — CLI 自己管內部 queue，CatClaw 只管送和收
- **一 channel 一 process** — CLI session 是單對話，避免 context 混亂
- **指數退避自動重啟** — 1s, 2s, 4s, 8s, 16s, 30s
- **SIGINT 中斷** — 5s 超時 → 重啟 process
- **與 Agent Loop 完全獨立** — 不共享 Provider / Session / Memory

## 路由

`discord.ts` 中，在 Agent Loop 路由之前判斷：
```typescript
const cliBridge = getCliBridge(effectiveChannelId);
if (cliBridge) { ... return; }
```

## 設定

`catclaw.json` 的 `cliBridge` 區塊，`channels` map 每個 channel ID 對應一個 bridge 實例。

## stdout 事件解析

沿用 `acp.ts` 的 diff 邏輯（累積文字比對取 delta），但改為 EventEmitter 模式。支援事件：`session_init` / `text_delta` / `thinking_delta` / `tool_call` / `tool_result` / `result` / `control_request` / `status`。
