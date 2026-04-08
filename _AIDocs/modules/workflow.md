# modules/workflow — 工作流引擎

> 檔案：`src/workflow/bootstrap.ts` + `src/workflow/`
> 更新日期：2026-04-05

## 職責

事件驅動的工作流引擎，訂閱 EventBus 事件，執行偵測 / 提醒 / 自動化。

## 子模組

| 檔案 | 說明 | 訂閱事件 |
|------|------|---------|
| `bootstrap.ts` | 統一初始化入口 | — |
| `file-tracker.ts` | 檔案修改追蹤 | `file:modified` |
| `sync-reminder.ts` | 未同步提醒 | `turn:after` |
| `rut-detector.ts` | 重複模式偵測 | `turn:after` |
| `oscillation-detector.ts` | 擺盪偵測 | `file:modified` |
| `wisdom-engine.ts` | 經驗累積引擎 | `turn:after` |
| `failure-detector.ts` | 失敗偵測 → 記錄 failures/ | `tool:error` |
| `aidocs-manager.ts` | _AIDocs 自動維護 | `file:modified` |
| `memory-extractor.ts` | 自動記憶萃取 | `turn:after` |
| `consolidate-scheduler.ts` | 定期整合排程 | timer |
| `fix-escalation.ts` | 精確修正升級 | 手動觸發 |
| `types.ts` | 共用型別 | — |

## 初始化

```typescript
initWorkflow(config, dataDir, memoryDir, projectRoot): void
```

由 `platform.ts` 步驟 10 呼叫。`config.workflow.enabled = false` 可完全停用。

## WorkflowConfig

```typescript
interface WorkflowConfig {
  enabled?: boolean;
  wisdomEngine?: { enabled?: boolean };
  fixEscalation?: { enabled?: boolean; retryThreshold?: number; timeoutMs?: number };
  aidocs?: { enabled?: boolean; contentGate?: boolean };
  rutDetection?: { enabled?: boolean; windowSize?: number; minOccurrences?: number };
  oscillation?: { enabled?: boolean };
}
```

## 模組說明

### file-tracker

監聽 `file:modified` 事件（由 tool 執行後發出），累積每個 session 的修改路徑和時間。
也監聽 `turn:before`（重置 turn 狀態）和 `session:end`（清理）。

```typescript
initFileTracker(eventBus: EventBus): void
trackFileEdit(sessionKey: string, filePath: string): void
getModifiedFiles(sessionKey: string): string[]
getEditCount(sessionKey: string, filePath: string): number
getFrequentEdits(sessionKey: string, minCount?: number): Array<{ path: string; count: number }>
clearSession(sessionKey: string): void
getAllSessionStats(): Map<string, Set<string>>
```

### sync-reminder

監聽 `turn:after`，檢查該 turn 是否有修改檔案。
達到閾值時發出 `workflow:sync_needed` 事件。

```typescript
initSyncReminder(eventBus: EventBus): void
```

### rut-detector

監聽 `turn:after`，分析對話模式。
偵測重複 pattern（同一錯誤出現 N 次）→ 發出 `workflow:rut` 事件。

```typescript
initRutDetector(eventBus: EventBus, dataDir: string): void
recordRutSignals(sessionId: string, signals: string[]): Promise<void>
triggerRutScan(eventBus: EventBus): Promise<void>
getSignalsPath(): string | null
```

### oscillation-detector

監聽 `file:modified`，偵測同一檔案在同一 session 內反覆被修改。
發出 `workflow:oscillation` 事件。

```typescript
initOscillationDetector(eventBus: EventBus, dataDir?: string): void
getSessionOscillationStats(sessionKey: string): Map<string, number>
```

### wisdom-engine

監聽 `turn:after`，從成功的對話中提取經驗。
累積到經驗庫（wisdom atoms）。

```typescript
initWisdomEngine(eventBus: EventBus): void
getWisdomAdvice(/* 內部參數 */): WisdomAdvice[]
buildWisdomSystemPromptAddition(advices: WisdomAdvice[]): string
getReflectionMetrics(sessionKey: string): ReflectionMetrics
```

### failure-detector

監聽 `tool:error`，記錄失敗到 `memory/failures/` 目錄。
供後續分析和避免重蹈覆轍。

**Failure Recall**：`getRecentFailureSummary()` 掃描 `failures/*.md`，統計近 N 天出現 ≥ minCount 次的失敗模式，回傳摘要字串。由 prompt-assembler 的 `failure-recall` module 在 system prompt 注入「已知 tool 陷阱」，實現跨 session 錯誤學習。

```typescript
initFailureDetector(eventBus: EventBus, memoryDir: string): void
getRecentFailureSummary(opts?: { days?: number; minCount?: number; maxEntries?: number }): Promise<string>
```

### aidocs-manager

監聽 `file:modified`，偵測核心檔案變更。
提示更新 _AIDocs 對應文件（contentGate 可停用自動寫入）。

```typescript
initAidocsManager(eventBus: EventBus, projectRoot?: string): void
setProjectRoots(roots: string[]): void
getPendingAidocsFiles(): string[]
clearPendingAidocs(): void
getAidocsSyncHint(): string
```

### memory-extractor

監聽 `turn:after`，每輪（turn:after）自動觸發記憶萃取。
呼叫 engine.extractPerTurn()。

```typescript
initMemoryExtractor(eventBus: EventBus): void
```

### consolidate-scheduler

定期排程，執行記憶整合：
- Auto-promote：命中次數達閾值 → 提升 tier
- Archive：衰減分數低於閾值 → 歸檔

```typescript
scheduleConsolidate(): void
```

### fix-escalation

手動觸發（`/fix-escalation` skill），精確修正升級協定：
1. 分析連續失敗的根因
2. 提出精確修正方案（非表面修復）
3. 記錄到 atom 防止再犯

```typescript
recordRetry(sessionKey: string): boolean       // 回傳是否超過閾值
resetRetry(sessionKey: string): void
clearSession(sessionKey: string): void
getRetryCount(sessionKey: string): number
runFixEscalation(/* 內部參數 */): Promise<void>
```

## Trace 整合

agent-loop.ts 的 workflow 事件橋接：
- `workflow:rut` → `trace.recordWorkflowEvent("rut", ...)`
- `workflow:oscillation` → `trace.recordWorkflowEvent("oscillation", ...)`
- `workflow:sync_needed` → `trace.recordWorkflowEvent("sync_needed", ...)`
- `file:modified` → `trace.recordWorkflowEvent("file_modified", ...)`
