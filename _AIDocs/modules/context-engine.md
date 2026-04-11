# modules/context-engine — Context 壓縮策略

> 檔案：`src/core/context-engine.ts`
> 更新日期：2026-04-11

## 職責

Strategy Pattern 架構的 Context Engineering 引擎。
管理 messages 歷史的 token 使用量，在超出閾值時自動壓縮。

## 策略一覽

| 策略 | 預設啟用 | 觸發條件 | 行為 |
|------|---------|---------|------|
| `compaction` | ✓ | tokens > triggerTokens (4000) | LLM 摘要壓縮舊訊息 |
| `budget-guard` | ✓ | tokens > window × 0.8 | 從最舊 message 開始刪 |
| `sliding-window` | ✗ | messages > maxTurns × 2 | 保留最近 N 輪 |
| `overflow-hard-stop` | ✓ | tokens > window × 0.95 | 緊急截斷至 4 條 |

執行順序：compaction → budget-guard → sliding-window → overflow-hard-stop

## 核心型別

### ContextStrategy

```typescript
interface ContextStrategy {
  name: string;
  enabled: boolean;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext>;
}
```

### ContextBuildContext

```typescript
interface ContextBuildContext {
  messages: Message[];
  sessionKey: string;
  turnIndex: number;
  estimatedTokens: number;
}
```

### ContextBreakdown

```typescript
interface ContextBreakdown {
  totalMessages: number;
  estimatedTokens: number;
  strategiesApplied: string[];
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  overflowSignaled?: boolean;  // 第三段 failover 觸發
}
```

## CompactionStrategy

觸發條件：`estimatedTokens > triggerTokens`（預設 4000）

有 ceProvider → LLM 摘要壓縮：
1. 保留最近 `preserveRecentTurns × 2` 條 messages
2. 舊的 messages → 扁平化為文字 → LLM 摘要
3. 摘要結果作為 `[對話摘要]` user message 置入
4. System messages 不壓縮

無 ceProvider → fallback sliding-window（保留最近 N 輪 + repairToolPairing）

### CompactionConfig

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `triggerTokens` | 4000 | 觸發閾值 |
| `preserveRecentTurns` | 5 | 保留最近 N 輪不壓縮 |

## BudgetGuardStrategy

觸發條件：`estimatedTokens > contextWindowTokens × maxUtilization`

從最舊非 system message 逐條刪除，直到 tokens < targetTokens（contextWindowTokens × maxUtilization（預設 0.8）× 0.7）。
刪除後執行 `repairToolPairing`。

## OverflowHardStopStrategy

最後防線。觸發條件：tokens > window × 0.95。
截斷至最後 4 條 messages。設定 `overflowSignaled = true`。

## Tool Pairing Repair

`repairToolPairing(messages)` — 截斷後修補 tool_use/tool_result 孤立：
- 移除無對應 tool_result 的 tool_use
- 移除無對應 tool_use 的 tool_result
- 移除因此變空的 messages

## Token 估算

`estimateTokens(messages)` — 粗估（~4 chars/token）。
優先使用 `message.tokens`（per-message 精確值），無則用 chars ÷ 4。

## 全域單例

```typescript
initContextEngine(cfg?)  → ContextEngine
getContextEngine()       → ContextEngine | null
```
