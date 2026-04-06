# modules/hooks — Hook 系統

> 檔案：`src/hooks/types.ts` + `src/hooks/hook-registry.ts` + `src/hooks/hook-runner.ts`
> 更新日期：2026-04-05

## 職責

Hook = 外部 shell command，在 agent-loop 的關鍵時機點執行。
設計參考 Claude Code 的 PreToolUse / PostToolUse hooks。

## 四個事件點

| 事件 | 時機 | 可做什麼 |
|------|------|---------|
| `PreToolUse` | Tool 執行前 | allow / block / modify params |
| `PostToolUse` | Tool 執行後 | modify result / 觸發副作用 |
| `SessionStart` | Session 建立時 | 初始化 |
| `SessionEnd` | Session 結束時 | 清理 |

## HookDefinition（config 設定）

```typescript
interface HookDefinition {
  name: string;
  event: HookEvent;
  command: string;           // Shell command
  timeoutMs?: number;        // 預設 5000
  toolFilter?: string[];     // 只在指定 tool 觸發
  enabled?: boolean;         // 預設 true
}
```

catclaw.json 設定：

```jsonc
"hooks": [
  {
    "name": "block-rm-rf",
    "event": "PreToolUse",
    "command": "node /path/to/check.js",
    "toolFilter": ["run_command"],
    "timeoutMs": 3000
  }
]
```

## Hook I/O 協定

**輸入**：JSON 寫入 stdin
**輸出**：JSON 從 stdout 讀取

### PreToolUse 輸入

```typescript
interface PreToolUseInput {
  event: "PreToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  accountId: string;
  sessionKey: string;
  channelId: string;
  toolTier: string;
}
```

### PostToolUse 輸入

```typescript
interface PostToolUseInput {
  event: "PostToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  toolResult: { result?: unknown; error?: string };
  durationMs: number;
  accountId: string;
  sessionKey: string;
  channelId: string;
}
```

### 輸出 Action

```typescript
type HookAction =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; params?: Record<string, unknown>; result?: unknown }
  | { action: "passthrough" };
```

## HookRegistry

```typescript
initHookRegistry(definitions: HookDefinition[]): HookRegistry
getHookRegistry(): HookRegistry | null

class HookRegistry {
  /** 重新載入 hook 定義（config hot-reload 時呼叫） */
  reload(definitions: HookDefinition[]): void

  count(event: HookEvent): number

  runPreToolUse(input: PreToolUseInput): Promise<
    | { blocked: false; params: Record<string, unknown> }
    | { blocked: true; reason: string }
  >

  runPostToolUse(input: PostToolUseInput): Promise<{ result?: unknown; error?: string }>

  /** fire-and-await，錯誤不拋出（只 log.warn） */
  runSessionStart(input: SessionStartInput): Promise<void>
  runSessionEnd(input: SessionEndInput): Promise<void>
}
```

### SessionStart / SessionEnd 輸入

```typescript
interface SessionStartInput {
  event: "SessionStart";
  sessionKey: string;
  accountId: string;
  channelId: string;
}

interface SessionEndInput {
  event: "SessionEnd";
  sessionKey: string;
  accountId: string;
  channelId: string;
  turnCount: number;
}
```

## HookRunner

執行流程：
1. 根據 event + toolFilter 篩選匹配的 hooks
2. 依序執行（非並行，第一個 block 即停止）
3. Spawn shell command，stdin 寫入 JSON，等待 stdout JSON
4. 超時 → 預設 passthrough（不阻塞 agent loop）
5. 解析 HookAction，套用到 tool params/result

## 整合點

- `platform.ts` 步驟 12 初始化 HookRegistry
- `agent-loop.ts` 的 `runPreToolUseHook()` / `runPostToolUseHook()` 呼叫
