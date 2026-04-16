# modules/hooks — Hook 系統

> 檔案：`src/hooks/{types,hook-registry,hook-runner,hook-runtime,hook-scanner,metadata-parser,sdk,file-watcher}.ts`
> 更新日期：2026-04-16

## 職責

Hook = 在 agent-loop / memory / cli-bridge / platform 關鍵時機點執行的腳本。
支援 TS / JS / Shell 三種 runtime，agent 可自助註冊。

## 34 個事件點

| 類別 | 事件 |
|------|------|
| Lifecycle | `PreToolUse` `PostToolUse` `SessionStart` `SessionEnd` |
| Turn / Message | `UserMessageReceived` `UserPromptSubmit` `PreTurn` `PostTurn` `PreLlmCall` `PostLlmCall` `AgentResponseReady` `ToolTimeout` |
| Memory / Atom | `PreAtomWrite` `PostAtomWrite` `PreAtomDelete` `PostAtomDelete` `AtomReplace` `MemoryRecall` |
| Subagent | `PreSubagentSpawn` `PostSubagentComplete` `SubagentError` |
| Context | `PreCompaction` `PostCompaction` `ContextOverflow` |
| CLI Bridge | `CliBridgeSpawn` `CliBridgeSuspend` `CliBridgeTurn` |
| File / Command | `PreFileWrite` `PreFileEdit` `PreCommandExec` |
| File Watcher | `FileChanged` `FileDeleted` |
| Error / Safety | `SafetyViolation` `AgentError` |
| Platform | `ConfigReload` `ProviderSwitch` |

每個事件對應的 Input 型別見 `src/hooks/types.ts` 的 `HookInputMap`。

## 掛載方式

**主要：目錄約定**

```
~/.catclaw/workspace/hooks/*.ts        ← 全域 hook（所有 agent）
agents/{id}/hooks/*.ts                  ← Agent 專屬 hook
```

每支腳本用 `defineHook` 自描述 metadata，scanner 啟動時掃資料夾自動註冊。
fs.watch 監聽變更熱重載。

**次要：config 覆蓋層**

`catclaw.json.hooks[]` / `agentConfig.hooks[]` 用來：
- 暫時停用某個 hook 檔（`enabled: false`）
- 改 timeout / toolFilter 而不動腳本

## HookDefinition

```typescript
interface HookDefinition {
  name: string;
  event: HookEvent;
  command?: string;          // 與 scriptPath 二擇一（純 shell command）
  scriptPath?: string;       // 與 command 二擇一（檔案路徑）
  runtime?: "auto" | "node" | "ts" | "shell";  // 預設 auto，依副檔名
  timeoutMs?: number;        // 預設 5000
  toolFilter?: string[];     // PreToolUse / PostToolUse / ToolTimeout / PreCommandExec 專用
  enabled?: boolean;         // 預設 true
  scope?: "global" | "agent"; // scanner 載入時賦值
  agentId?: string;           // scope=agent 時必填
}
```

## TS Hook SDK

```typescript
import { defineHook } from "catclaw/hooks/sdk";

export default defineHook({
  event: "PreToolUse",
  toolFilter: ["run_command"],
  timeoutMs: 3000,
}, async (input) => {
  if (String(input.toolParams.command).includes("rm -rf")) {
    return { action: "block", reason: "dangerous command" };
  }
  return { action: "allow" };
});
```

Shell hook 用檔頭註解描述：

```sh
#!/bin/sh
# @hook event=PostToolUse toolFilter=run_command timeoutMs=2000
cat - >> /tmp/audit.log
echo '{"action":"passthrough"}'
```

## Runtime 分派

| 副檔名 | Runtime | Spawn |
|--------|---------|-------|
| `.ts` | tsx | `bunx tsx hook-runtime.ts <script>` |
| `.js` `.mjs` | node | `node <script>` |
| `.sh` | shell | `sh <script>` |
| `.bat` | shell | `cmd /c <script>`（Windows） |
| `.ps1` | shell | `pwsh -File <script>` |
| 純字串 command | shell | `sh -c <command>`（向後相容） |

`hook-runtime.ts` 是 TS hook 的執行入口：載入 default export → 讀 stdin JSON → 呼叫 handler → 寫 stdout JSON。

## HookAction 輸出

```typescript
type HookAction =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; params?: Record<string, unknown>; result?: unknown; data?: Record<string, unknown> }
  | { action: "passthrough" };
```

- `allow` — 通過，繼續下一個 hook
- `block` — 中止鏈（PreToolUse / Pre*Write / Pre*Delete 適用）
- `modify` — 改寫 params / result / data（依事件而定）
- `passthrough` — 不做任何事（fail-open 預設）

## HookRegistry

```typescript
initHookRegistry(opts: { global: HookDefinition[]; byAgent: Map<string, HookDefinition[]> }): HookRegistry
getHookRegistry(): HookRegistry | null

class HookRegistry {
  reload(opts): void
  count(event: HookEvent, agentId?: string): number

  // Pre/Post 鏈式執行 — global → agent（Pre 類）或 agent → global（Post 類）
  runPreToolUse(input: PreToolUseInput): Promise<{ blocked: false; params } | { blocked: true; reason }>
  runPostToolUse(input: PostToolUseInput): Promise<{ result?; error? }>
  // ... 其他 32 個事件對應 API（含 runFileChanged / runFileDeleted）
}
```

## 執行語意

- **Pre 類**（PreToolUse / PreAtomWrite / PreFileWrite 等）：`global → agent`，第一個 block 即中止；modify 鏈式改寫 params 傳給下一個
- **Post 類**（PostToolUse / PostAtomWrite 等）：`agent → global`，modify 鏈式改寫 result
- **觀測類**（SessionStart/End / CliBridgeSpawn / ConfigReload 等）：fire-and-await 並行，錯誤只 log 不拋出

## 安全模型

- `scope=agent` hook 寫到自己 agent 目錄，免 approve
- `scope=global` hook 必須使用者 approve（control_request）
- `scriptPath` 強制落在白名單目錄（防 `../` 逃逸）
- 非 admin agent 不能寫 global hook
- `CATCLAW_HOOK_DEPTH` env guard 防 hook → tool → hook 遞迴

## FileWatcher（外部檔案監聽）

`src/hooks/file-watcher.ts` — 通用外部檔案監聽，變更時觸發 `FileChanged` / `FileDeleted` hook event。

**設定**：`catclaw.json.fileWatcher`
```jsonc
"fileWatcher": {
  "enabled": true,
  "watches": [{ "label": "obsidian", "path": "~/WellsDB", "ignoreDirs": [".obsidian", ".trash", ".git"] }]
}
```

**核心流程**：`fs.watch → debounce → SHA-256 hash dedup → runFileChanged/runFileDeleted`

**5 層迴圈防護**：
| 層 | 機制 | 說明 |
|----|------|------|
| L1 | `suppressPath()` API | hook 腳本主動抑制特定路徑 |
| L2 | Hook Execution Context | hook 執行期間自動抑制所有 fs event |
| L3 | Per-Path Cooldown (10s) | 同一路徑觸發後冷卻 |
| L4 | Global Rate Limit (50/60s) | 全域事件速率限制 |
| L5 | `CATCLAW_HOOK_DEPTH` | 既有 hook 遞迴深度防護 |

**動態管理**：`filewatch` tool（list/add/remove）+ 全域 singleton `getFileWatcher()`

**接線**：`bootstrap.ts` step 11（workflow 初始化最後），config 由 `platform.ts` 傳入。

## 整合點

- `platform.ts` 啟動時初始化 scanner + registry
- `agent-loop.ts` 28 個新事件 trigger 點
- `memory-engine.ts` atom 五事件
- `cli-bridge/bridge.ts` cli bridge 三事件
- `bootstrap.ts` step 11 啟動 FileWatcher

## 自助註冊工具

| Tool | 用途 |
|------|------|
| `hook_register` | 建立新 hook 檔 |
| `hook_list` | 列出已註冊 hooks |
| `hook_remove` | 刪除 hook 檔 |

對應 skill `/hook` 注入完整 SDK 知識（按需載入，不佔 system prompt）。
