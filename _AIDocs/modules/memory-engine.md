# modules/memory-engine — 三層記憶引擎

> 檔案：`src/memory/engine.ts` + `src/memory/` 子模組
> 更新日期：2026-04-05

## 職責

組裝所有 memory 子模組，對外提供 MemoryEngine 介面。
生命週期：`init()` → `recall/extract/write` → `shutdown()`

## 子模組

| 檔案 | 職責 |
|------|------|
| `engine.ts` | 主引擎：初始化 + API facade |
| `recall.ts` | 三層 recall：全域 + 專案 + 個人（trigger match + vector search） |
| `extract.ts` | 知識萃取：從對話中提取 KnowledgeItem |
| `consolidate.ts` | 整合：promotion / archive / decay |
| `context-builder.ts` | Context 組裝：ACT-R 衰減 + budget + staleness check |
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
- `degraded: boolean` — vector service 離線時降級為 trigger-only
- `blindSpot?: string` — 未命中的 trigger 提示

### Context 組裝

```typescript
buildContext(
  fragments: AtomFragment[],
  query: string,
  blindSpot?: string
): ContextPayload
```

ContextPayload：
- `text: string` — 注入到 system prompt 的文字
- `tokenCount: number` — 估算 token 數
- `atoms: string[]` — 使用的 atom 名稱

### 萃取

```typescript
extract(
  messages: Message[],
  opts: ExtractOpts
): Promise<KnowledgeItem[]>
```

### 寫入

```typescript
writeAtom(layer, name, content, opts): Promise<WriteGateResult>
```

WriteGateResult：
- `written: boolean`
- `reason?: string` — dedup 拒絕原因

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
status(): MemoryStatus
```

## Recall 三層邏輯

```
recall(query)
  ├── 1. 全域層：globalDir/*.md
  ├── 2. 專案層：projects/{projectId}/*.md
  ├── 3. 個人層：accounts/{accountId}/*.md
  │
  ├── Trigger match：MEMORY.md 索引的 Trigger 欄��
  └── Vector search：embedding → LanceDB → top-K
      → 合併 → 去重 → 排序（relevance）
```

## Context Builder（ACT-R）

- **衰減**：atom 的 Last-used 越久 → 相關度越低
- **Budget**：分配比例 global:project:account = 0.3:0.4:0.3
- **Staleness Check**：超過閾值天數的 atom 標記 `[可能過時]`

## 設定（MemoryConfig）

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `root` | `{catclawDir}/memory` | 記憶根目錄 |
| `vectorDbPath` | `{root}/_vectordb` | 向量 DB 路徑 |
| `contextBudget` | 3000 | 注入 token 上限 |
| `contextBudgetRatio` | 0.3/0.4/0.3 | 三層分配比例 |
| `writeGate.dedupThreshold` | 0.80 | 去重閾值 |
| `recall.vectorSearch` | false | 是否啟用向量搜尋 |
| `recall.vectorMinScore` | 0.65 | 向量最低相關度 |
| `recall.vectorTopK` | 5 | 向量 top-K |
| `extract.perTurn` | true | 每輪自動萃取 |
| `extract.maxItemsPerTurn` | 3 | 每輪最多萃取數 |

## 全域單例

```typescript
initMemoryEngine(cfg): MemoryEngine
getMemoryEngine(): MemoryEngine | null
```

由 `platform.ts` 步驟 9 初始化。
