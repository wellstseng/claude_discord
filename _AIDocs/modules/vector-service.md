# modules/vector-service — LanceDB 向量服務

> 檔案：`src/vector/lancedb.ts` + `src/vector/embedding.ts`
> 更新日期：2026-04-06

## 職責

In-process 向量資料庫，提供 embedding 索引與語意搜尋。
取代舊版 Python memory-vector-service（port 3849），不需額外 HTTP server。

## 架構

```
embedTexts() / embedOne()     ← src/vector/embedding.ts（Ollama /api/embed）
       ↓
LanceVectorService            ← src/vector/lancedb.ts（@lancedb/lancedb）
  ├── upsert(id, text, namespace)
  ├── search(query, opts)
  ├── delete(id, namespace)
  └── rebuild(namespace)
```

## Namespace 設計

每個 namespace 對應一個 LanceDB table。格式強制驗證：

| Namespace | 用途 |
|-----------|------|
| `global` | 全域記憶 |
| `project/{id}` | 專案層記憶 |
| `account/{id}` | 個人層記憶 |

Table 名稱 = namespace 中 `/` 轉 `__`（LanceDB 不接受 `/`）。

## VectorService 介面

```typescript
interface VectorService {
  init(): Promise<void>;
  upsert(id: string, text: string, namespace: string, opts?: { path?: string; meta?: object }): Promise<boolean>;
  search(query: string | number[], opts: SearchOpts): Promise<SearchResult[]>;
  delete(id: string, namespace: string): Promise<void>;
  rebuild(namespace: string): Promise<void>;
  isAvailable(): boolean;
}
```

## Upsert

1. `embedTexts([text])` → 取得向量
2. Embedding 不可用 → `return false`（graceful）
3. Table 不存在 → `createTable()`
4. Table 已存在 → 先 delete 舊記錄再 add（模擬 upsert）

## Search

1. query 為字串 → `embedOne(query)` 轉向量；為 `number[]` → 直接使用
2. Ollama offline → `return []`（graceful empty）
3. `vectorSearch(queryVec).limit(topK * 2)` → 多取再 filter
4. L2 metric → cosine similarity 轉換：`score = 1 - _distance²/2`（d = LanceDB 回傳的 `_distance` 欄位，L2 距離值）
5. 過濾 `minScore`（預設 0.65）→ 排序 → 取 topK

### SearchOpts

| 參數 | 預設 | 說明 |
|------|------|------|
| `namespace` | 必填 | 搜尋範圍 |
| `topK` | 10 | 回傳筆數 |
| `minScore` | 0.65 | 最低 cosine 相似度 |

## Graceful Degradation

Ollama offline 時：
- `upsert()` → `return false`
- `search()` → `return []`
- `rebuild()` → no-op
- 不 throw error，上層模組可正常運作

## VectorRecord Schema

```typescript
interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  namespace: string;
  path?: string;        // 來源檔案路徑
  meta?: string;        // JSON string 額外 metadata
  updatedAt: string;    // ISO 8601
}
```

## 全域單例

```typescript
initVectorService(dbPath: string): LanceVectorService
getVectorService(): LanceVectorService
resetVectorService(): void
```

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `memory/engine.ts` | `init()` 時呼叫 `initVectorService()` 初始化 |
| `memory/recall.ts` | `search()` 向量語意搜尋 atom |
| `memory/engine.ts` | `upsert()` 萃取後索引 atom |
| `skills/vector.ts` | `/vector` skill 管理介面 |
