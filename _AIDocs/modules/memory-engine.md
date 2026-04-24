# modules/memory-engine — 記憶引擎（global + project + account + agent）

> 檔案：`src/memory/engine.ts` + `src/memory/` 子模組
> 更新日期：2026-04-09

## 職責

組裝所有 memory 子模組，對外提供 MemoryEngine 介面。
生命週期：`init()` → `recall/extract/write` → `shutdown()`

## 子模組

| 檔案 | 職責 |
|------|------|
| `engine.ts` | 主引擎：初始化 + API facade |
| `recall.ts` | Vector-First recall：keyword 快篩 → vector → 純 cosine 排序 + keyword 微調（5 步管線） |
| `memory-api.ts` | Memory 管理 API：atom CRUD + recall-test + stats（供 Dashboard 使用） |
| `extract.ts` | 知識萃取：從對話中提取 KnowledgeItem |
| `consolidate.ts` | 整合：promotion / archive / ACT-R decay（與 recall 共用 `computeActivation()`） |
| `context-builder.ts` | Context 組裝：budget 截斷（ACT-R/層級預算已移除） |
| `atom.ts` | Atom CRUD：讀寫 markdown atom 檔案 |
| `write-gate.ts` | 寫入閘門：dedup（餘弦相似度閾值） |
| `index-manager.ts` | MEMORY.md 索引管理 |
| `episodic.ts` | Episodic memory：session 統計 + rut 偵測 + TTL 清理 |
| `session-memory.ts` | Session note：per-channel 對話筆記（Ollama 萃取） |

## 目錄結構

```
{memoryRoot}/
  ├── *.md                   — 全域 atom
  ├── MEMORY.md              — 索引
  ├── projects/{projectId}/  — 專案層 atom
  ├── accounts/{accountId}/  — 個人層 atom
  ├── episodic/              — episodic memory
  └── _vectordb/             — LanceDB 向量資料庫

~/.catclaw/workspace/agents/{agentId}/memory/  — agent 專屬記憶
```

### 記憶四層結構

| 層 | namespace | 目錄 | 用途 |
|---------|---------------|--------------------------------------|--------------------------|
| global  | `global`      | `{memoryRoot}/`                      | 平台共用知識             |
| project | `project/{id}`| `{memoryRoot}/projects/{id}/`        | 專案知識（暫停用）       |
| account | `account/{id}`| `{memoryRoot}/accounts/{id}/`        | 使用者偏好/個人資訊      |
| agent   | `agent/{id}`  | `~/.catclaw/workspace/agents/{id}/memory/`     | agent 專屬記憶           |

Recall 範圍 = global + account(當前使用者) + agent(若有 agentId)。
寫入：agent context 下寫入 agent 層。

## MemoryEngine API

### 生命週期

```typescript
init(): Promise<void>     // 初始化 vector service + 確保目錄
shutdown(): Promise<void>  // 關閉 vector service
```

### Recall

```typescript
recall(
  prompt: string,
  ctx: RecallContext,
  overrides?: { vectorSearch?: boolean; vectorTopK?: number }
): Promise<RecallResult>
```

RecallResult：
- `fragments: AtomFragment[]` — 命中的 atom 片段
- `blindSpot: boolean` — 所有層均無命中時為 true（Blind-Spot 警告）
- `degraded: boolean` — vector service 離線時走 keyword fallback（固定分數 0.5）

### Context 組裝

```typescript
buildContext(
  fragments: AtomFragment[],
  prompt: string,
  budget = 2000,
  _ratios?: { global: number; project: number; account: number },
  blindSpot = false
): ContextPayload
```

ContextPayload：
- `text: string` — 注入到 system prompt 的文字
- `tokenCount: number` — 估算 token 數
- `layerCounts: Record<MemoryLayer, number>` — 各層 fragment 數量（global/project/account/agent）
- `blindSpotWarning?: string` — BlindSpot 警告字串（若有）

### 萃取

```typescript
/** 逐輪萃取（fire-and-forget）— engine 自動注入 maxItems + cooldownMs from config */
extractPerTurn(
  newText: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]>
```

### 寫入閘門

```typescript
checkWrite(content: string, namespace: string, bypass = false): Promise<WriteGateResult>
```

WriteGateResult：
- `allowed: boolean`
- `reason: "bypass" | "injection" | "duplicate" | "ok"`
- `similarity?: number` — dedup 比對相似度（duplicate 時有值）

### Seed & Rebuild

```typescript
seedFromDir(
  dir: string,
  namespace: string
): Promise<{ seeded: number; skipped: number; errors: number }>
```

掃描記憶目錄下所有 atom `.md` 檔，嵌入並寫入 LanceDB。
用途：首次安裝或手動複製 atom 後補跑 embedding。
排除：`_vectordb`、`episodic`、`_staging`、`_reference` 目錄和 `MEMORY.md`。

```typescript
rebuildIndex(namespace: string): Promise<void>
```

重建指定 namespace 的向量索引（呼叫 VectorService.rebuild）。

### 狀態

```typescript
getStatus(): MemoryStatus
```

## Recall — Vector-First 5 步管線

```
recall(query)
  1. Cache 檢查（Jaccard ≥ 0.7, 60s TTL）
  2. Keyword 快篩（MEMORY.md trigger match）→ 微調加分用
  3. Embed query → vector（失敗 → keyword fallback）
  4. Vector search（各層並行，code defaults topK=8 / minScore=0.55，config defaults topK=10 / minScore=0.65 覆寫）（失敗 → keyword fallback）
  5. Merge + dedup + keyword 微調 + touchAtom + cache + return
```

### Keyword Fallback（向量不可用兜底）

Step 3 embed 或 Step 4 vector search 失敗時，自動退化為純 keyword 路徑：

- 以 Step 2 的 `keywordHits` 為來源
- `readAtom()` 讀取 atom → 固定分數 0.5
- 回傳 `degraded: true`，下游 trace 可見

### AtomFragment.matchedBy

| 值 | 來源 |
|------|------|
| `"vector"` | 正常向量搜尋命中 |
| `"keyword"` | keyword fallback 命中 |

### 常數

| 常數 | 值 | 說明 |
|------|------|------|
| `KEYWORD_BONUS` | 0.05 | keyword trigger 命中微調加分 |

## Context Builder

- **Budget**：函式預設 `budget = 2000`，config 預設 `contextBudget = 3000`（呼叫端由 config 傳入覆寫）。無層級分配（`contextBudgetRatio` 已定義但 context-builder 內未使用）
- 按 vector score 排序，超出 budget 截斷
- **Atom 過肥偵測**：若單顆 atom 本身就超過 budget（首顆且 blockTokens > budget），發 `log.warn` 建議拆分為多個較小的原子單元

## 設定（MemoryConfig）

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `root` | `{catclawDir}/memory` | 記憶根目錄 |
| `vectorDbPath` | `{root}/_vectordb` | 向量 DB 路徑 |
| `contextBudget` | 3000 | 注入 token 上限 |
| `writeGate.enabled` | true | 寫入閘門開關 |
| `writeGate.dedupThreshold` | 0.80 | 去重閾值 |
| `recall.vectorSearch` | true | 是否啟用向量搜尋 |
| `recall.vectorMinScore` | 0.65 | 向量最低相關度 |
| `recall.vectorTopK` | 10 | 向量 top-K |
| `extract.enabled` | true | 萃取功能開關 |
| `extract.perTurn` | true | 累積 flush 時是否跑萃取（關閉 = 全面停用） |
| `extract.maxItemsPerTurn` | 3 | 單次 flush 最多萃取幾條（非每 turn） |
| `extract.accumCharThreshold` | 200 | 累積字元閾值（達到後觸發萃取） |
| `extract.accumTurnThreshold` | 5 | 累積 turn 閾值 |
| `extract.cooldownMs` | 120000 | 同 session 萃取冷卻時間（ms） |
| `memoryPipeline.extraction.model` | (from ollama config) | 萃取用 LLM 模型（extract.ts doExtract 讀取此值傳給 Ollama） |

## 全域單例

```typescript
initMemoryEngine(cfg): MemoryEngine
getMemoryEngine(): MemoryEngine  // throw on null
```

由 `platform.ts` 步驟 9 初始化。

## Episodic Memory（`episodic.ts`）

Session 自動摘要，記錄修改/閱讀軌跡與覆轍信號。

### 觸發

`session:idle` / `platform:shutdown` 事件。

### 生成門檻

- `modifiedFiles ≥ 1` 且 session 持續 `≥ 2min`
- 或 `readFiles ≥ 5`

### 覆轍偵測（RutWarning）

| type | 條件 | 說明 |
|------|------|------|
| `same_file_3x` | 同一檔案修改 ≥ 3 次 | 可能在打轉 |
| `retry_escalation` | retryCount ≥ 2 | 建議啟動 Fix Escalation |

### 跨 Session 覆轍掃描

```typescript
detectRutPatterns(episodicDir, currentFile?): RutWarning[]
```

掃描近期 10 個 episodic，找到跨 session 反覆出現的同一檔案修改或 retry escalation（各需 ≥ 2 次）。
由 Workflow Guardian 在 session 啟動時注入警告。

### TTL

預設 24 天，`cleanExpired()` 在每次生成前自動清理過期檔案。

### API

```typescript
generateEpisodic(stats: SessionStats, opts: EpisodicOpts): Promise<string | null>
detectRutPatterns(episodicDir: string, currentFile?: string): RutWarning[]
```

## Session Memory（`session-memory.ts`）

對話中自動抄筆記（參考 Claude Code SessionMemory）。

### 機制

- **觸發**：每 `intervalTurns` 輪（預設 10）
- **萃取**：最近 `maxHistoryTurns` 輪（預設 15）→ Ollama chat → 摘要筆記
- **儲存**：`{memoryDir}/_session_notes/{channelId後8碼}.md`（覆寫，保留最新）
- **注入**：turn 開始前讀取，前置到 system prompt

### API

```typescript
getSessionNote(memoryDir, channelId): string | null           // 讀取筆記（供 prompt 注入）
checkAndSaveNote(channelId, turnCount, messages, memoryDir, opts): Promise<void>  // fire-and-forget 萃取
```

## Hook 整合

`MemoryEngine.recall()` 執行後觸發 **MemoryRecall** hook（observer），附 query / hitCount / durationMs。
