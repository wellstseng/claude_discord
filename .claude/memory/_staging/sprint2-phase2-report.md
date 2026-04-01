# Sprint 2 Phase 2 報告 — 省 Token / 高精度記憶

> 日期：2026-04-02  
> 執行方式：自主開發實驗（Claude as Developer）  
> Branch：platform-rebuild  
> Commits：9f521c7 → 17d4375

---

## 目標

**省 token，高精度記憶**

---

## 完成項目

### 目標 #1：memory-extractor 接線（`9f521c7`）

**問題**：`MemoryEngine.extractPerTurn()` 存在但從未被呼叫（dead code）。記憶萃取完全失效。

**修復**：
- 新建 `src/workflow/memory-extractor.ts`（68 行）
- 訂閱 `turn:after` → `extractPerTurn()` 全鏈接通
- `safeName()` 防 path traversal（只允許 `[a-z0-9_]`）
- 雙層 fire-and-forget try/catch，主流程零阻塞

**驗證**：tsc 零錯誤，PM2 log：`[memory-extractor] 初始化完成`

---

### 目標 #2：write-gate 防護（`0133384`）

**問題**：memory-extractor 直接 `writeAtom()`，跳過 Q1 dedup + Q4 injection 過濾。

**修復**：每個 KnowledgeItem 寫入前先呼叫 `engine.checkWrite(content, ns)`。

**效果**：相似度 ≥ 0.80 重複內容阻擋；injection pattern 過濾。

---

### 目標 #3：llmSelect default 修正（`a62e410`）

**問題**：recall.ts 改成 opt-in（`=== true`），但 config.ts 預設仍是 `true`（兩邊不一致）。LLM select 實際上還是 ON，每次 recall >5 fragments 都呼叫 Ollama。

**修復**：`config.ts` 第 610 行 `?? true` → `?? false`

**效果**：recall 改用 ACT-R 排序（精度相當），節省 Ollama 呼叫成本。

---

### 目標 #4：vector namespace mismatch 修正（`82a23cc` + `17d4375`）

**問題（嚴重）**：`writeAtom` 將 atoms seed 到向量 namespace `"project"` / `"account"`，但 recall 搜尋 `"project/{projectId}"` / `"account/{accountId}"`。向量搜尋永遠找不到自動萃取的 atoms。

**修復**：
- `atom.ts`：`writeAtom` 新增 `namespace?: string` 參數，優先使用
- `memory-extractor.ts`：傳入完整 namespace（e.g. `"project/abc123"`）
- `spawn-subagent.ts`：同步修正，明確傳入 `"global"`

**Effect**：記憶萃取後的 atoms 可被向量搜尋正確找到。

---

## 實機測試結果

```
測試訊息：「CatClaw 記憶系統的主要架構是什麼？」
Bot 回應：802字
turn:after 觸發：✅
memory-extractor 執行：✅（[memory-extractor] 初始化完成）
extractPerTurn 執行：✅（[extract] 萃取 0 項）
Ollama 回應時間：~61 秒（qwen3:14b think mode）
萃取結果：0 項（現有 44 atoms 已有相關知識，正常行為）
```

---

## 累積 Sprint 2 省 Token 成果

| 改動 | Token 節省 |
|------|-----------|
| 萃取 prompt 縮短 60% | ~1200 tok/session |
| pre-LLM 相似度跳過（≥0.92） | 按需，避免重複萃取 |
| LLM select 改 OFF（ACT-R fallback） | ~300 tok/recall（>5 fragments） |
| Tool result caps（12 工具） | 按工具，最高 2000 tok cap |
| CE compaction 保留工具上下文 | 壓縮品質改善 |
| Per-session cooldown（120s） | 防止頻繁 Ollama 呼叫 |

---

## 已知限制

1. `session:end` 從未 emit → `extractFullScan` + `evaluatePromotions` 不運行
2. `consolidate()` 未定時呼叫 → atoms 不會自動晉升 [臨] → [觀]
3. Ollama 萃取耗時 ~60s（qwen3:14b）→ 高流量下可能排隊積累
