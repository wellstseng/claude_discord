# modules/memory-engine — 三層記憶引擎

> 檔案：`src/memory/engine.ts` + `src/memory/` 子模組
> 更新日期：2026-04-07

## 職責

組裝所有 memory 子模組，對外提供 MemoryEngine 介面。
生命週期：`init()` → `recall/extract/write` → `shutdown()`

## 子模組

| 檔案 | 職責 |
|------|------|
| `engine.ts` | 主引擎：初始化 + API facade |
| `recall.ts` | Progressive Hybrid recall：keyword 快篩 → vector → ACT-R 混合排序 → related spreading（7 步管線） |
| `extract.ts` | 知識萃取：從對話中提取 KnowledgeItem |
| `consolidate.ts` | 整合：promotion / archive / decay |
| `context-builder.ts` | Context 組裝：budget 截斷（ACT-R/層級預算已移除） |
| `atom.ts` | Atom CRUD：讀寫 markdown atom 檔案 |
| `write-gate.ts` | 寫入閘門：dedup（餘弦相似度閾值） |
| `index-manager.ts` | MEMORY.md 索引管理 |
| `episodic.ts` | Episodic memory：session 統計 + rut 偵測 |
| `session-memory.ts` | Session note：per-channel 對話筆記 |

## 目錄結構

```
{memoryRoot}/
  ├── *.md                   — 全域 atom
  ├── MEMORY.md              — 索引
  ├── projects/{projectId}/  — 專案層 atom
  ├── accounts/{accountId}/  — 個人層 atom
  ├── episodic/              — episodic memory
  └── _vectordb/             — LanceDB 向量資料庫
```

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
- `degraded: boolean` — vector service 離線時回傳空結果（不再 fallback trigger-only）

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
- `layerCounts: Record<MemoryLayer, number>` — 三層各自 fragment 數量
- `blindSpotWarning?: string` — BlindSpot 警告字串（若有）

### 萃取

```typescript
/** 逐輪萃取（fire-and-forget） */
extractPerTurn(
  newText: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]>

/** 全量掃描萃取（session end） */
extractFullScan(
  response: string,
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

## Recall — Progressive Hybrid 7 步管線

```
recall(query)
  1. Cache 檢查（Jaccard ≥ 0.7, 60s TTL）
  2. Progressive Retrieval — keyword 快篩（MEMORY.md trigger match）
  3. Embed query → vector
  4. Vector search（各層並行，LanceDB topK=8, minScore=0.55）
  5. Merge + dedup + ACT-R activation 混合排序 + keyword bonus
     finalScore = 0.7 × cosine + 0.3 × activation_norm + kwBonus(0.15)
  6. Related-Edge Spreading（top-N 的 related atom 展開，score × 0.6 折扣，每 atom 最多展開 3 個）
  7. touchAtom + cache + return
```

### 常數

| 常數 | 值 | 說明 |
|------|------|------|
| `KEYWORD_BONUS` | 0.15 | keyword trigger 命中加分 |
| `COSINE_WEIGHT` | 0.7 | cosine 相似度權重 |
| `ACTIVATION_WEIGHT` | 0.3 | ACT-R activation 權重 |
| `RELATED_SCORE_DISCOUNT` | 0.6 | related atom 分數折扣 |
| `RELATED_MAX_EXPAND` | 3 | 每個 atom 最多展開 related 數 |

## Context Builder

- **Budget**：全域 token 預算 3000（無層級分配）
- 按 vector score 排序，超出 budget 截斷

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
| `extract.perTurn` | true | 每輪自動萃取 |
| `extract.onSessionEnd` | true | Session 結束時全量掃描萃取 |
| `extract.maxItemsPerTurn` | 3 | 每輪最多萃取數 |
| `extract.maxItemsSessionEnd` | 5 | Session 結束時最多萃取數 |
| `extract.minNewChars` | 200 | 逐輪萃取最低新增字元門檻 |

## 全域單例

```typescript
initMemoryEngine(cfg): MemoryEngine
getMemoryEngine(): MemoryEngine  // throw on null
```

由 `platform.ts` 步驟 9 初始化。
