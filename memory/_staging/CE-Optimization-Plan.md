# CatClaw Context Engine 優化計劃

> 日期：2026-04-11（v2 — 加入漸進式衰減模型、config 整合、Trace/Dashboard 追蹤）
> 範圍：context-engine.ts + agent-loop.ts + config.ts + message-trace.ts + dashboard.ts

---

## 一、現況盤點

### 1.1 現有 Context 管理機制

CatClaw 目前有 **4 層** context 管理，各自獨立運作：

```
┌─────────────────────────────────────────────────────────┐
│                    訊息進入                              │
│                       ↓                                  │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ① Memory Context Budget (context-builder.ts)    │    │
│  │    記憶注入時 greedy fill，預設 2,000 tokens     │    │
│  │    Token Diet + Section 選擇 + Staleness Check   │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         ↓                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ② Tool Result 截斷 (agent-loop.ts:80-174)      │    │
│  │    每次 tool 回傳時即時截斷                      │    │
│  │    resultTokenCap: 8,000 tokens / 次             │    │
│  │    perTurnTotalCap: 0 (無限制)                   │    │
│  │    toolTimeoutMs: 30,000ms                       │    │
│  │    maxWriteFileBytes: 512,000 (500KB)            │    │
│  │    按 tool 類型分派截斷策略                      │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         ↓                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ③ CompactionStrategy (context-engine.ts:127)    │    │
│  │    tokens > 20,000 時觸發                        │    │
│  │    保留最近 5 turn，舊訊息 LLM 摘要壓縮         │    │
│  │    無 ceProvider 時 fallback sliding-window 硬切  │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         ↓                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ④ OverflowHardStop (context-engine.ts:237)      │    │
│  │    tokens > 95,000 (95%) 時觸發                  │    │
│  │    緊急截斷：只保留最後 4 messages               │    │
│  │    觸發後終止對話                                │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 1.2 現有設定散落問題

目前 CE 相關設定分散在兩個 config 區塊：

```jsonc
// catclaw.json — 現狀
{
  "contextEngineering": {           // ← CE 策略在這
    "enabled": true,
    "strategies": {
      "compaction": { "triggerTokens": 20000 }
    }
  },
  "toolBudget": {                   // ← Tool 截斷在這（獨立區塊）
    "resultTokenCap": 8000,
    "perTurnTotalCap": 0,
    "toolTimeoutMs": 30000,
    "maxWriteFileBytes": 512000
  }
}
```

**問題**：toolBudget 本質上是 CE 的一環（控制 tool 回傳量），但和 CE 策略分開放，不直觀。

### 1.3 現有 Trace 記錄

`message-trace.ts` Phase 4 記錄：

```typescript
contextEngineering?: {
  strategiesApplied: string[];   // 套用了哪些策略
  tokensBeforeCE: number;        // CE 前 token 數
  tokensAfterCE: number;         // CE 後 token 數
  tokensSaved: number;           // 省下多少
};
```

**缺口**：
- 只記錄「有/沒有觸發」，不記錄每個策略的個別影響
- 無 per-message 的壓縮記錄（哪些 message 被壓、壓了多少）
- Session messages API（dashboard `/api/sessions/messages`）回傳壓縮後內容，但無標記區分原始 vs 壓縮

### 1.4 Token 消耗實際情境模擬

假設一般對話，每 turn 呼叫 2-3 個 tool：

| Turn | 新增 tokens (估) | 累計 tokens | 說明 |
|------|------------------|-------------|------|
| 1 | ~6,000 | 6,000 | user 訊息 + assistant 回覆 + 2 個 tool result |
| 2 | ~8,000 | 14,000 | 3 個 tool（read_file + grep + edit） |
| 3 | ~7,000 | 21,000 | **觸發 compaction** → 壓縮到 ~5,000 |
| 4 | ~8,000 | 13,000 | |
| 5 | ~7,000 | 20,000 | **再次觸發 compaction** |
| ... | | | 每 2-3 turn 就壓一次 |

**問題**：
- 每次 compaction 要摘要 ~15K tokens 的內容，本地小模型品質不穩定
- 壓縮頻率高（每 2-3 turn），但每次壓的量大
- 舊 turn 的 tool_result 完整保留到 compaction 才處理，佔空間
- compaction 後早期對話細節全部丟失（只剩摘要）

### 1.5 現有機制缺口

| 缺口 | 影響 |
|------|------|
| 歷史 tool_result 不會隨時間衰減 | 2 turn 前的 grep 結果佔 8K tokens，但已無用 |
| 壓縮是一次性全量重寫 | 每次壓都是從頭摘要，品質不穩定 |
| 無 turn-level 精細控制 | 只有「全壓」或「不壓」兩種狀態 |
| 重複/失敗 turn 不清理 | 連續重試 edit 3 次，3 次完整結果都保留 |
| tool_result 壓縮無專屬策略 | compaction 用通用摘要 prompt，不知道 tool 語意 |
| CE 設定分散 | toolBudget 和 contextEngineering 分開，不直觀 |
| Trace 不夠細緻 | 只知道整體壓了多少，不知道每個策略/每個 message 的壓縮細節 |
| Session 壓縮後無標記 | Dashboard 看到的 session messages 無法區分原始 vs 壓縮 |

---

## 二、優化方案

### 總體策略：從「大批壓縮」轉向「漸進衰減」

```
現狀：累積 → 爆量壓縮 → 資訊損失大
目標：每個 message 持續衰減 → 自然瘦身 → compaction 極少觸發 → 品質好
```

### 2.1 核心模型：漸進式衰減壓縮

每個 message 帶壓縮 metadata，隨 turn 年齡或時間推移逐級壓縮：

```
Level 0 (原始)  → Level 1 (精簡)  → Level 2 (核心)  → Level 3 (stub)  → 消滅
  100%              80-90%             40-50%            ~10%              0%
  8,000 tok         ~1,600 tok         ~600 tok          ~80 tok          移除
```

**關鍵規則：已壓縮的不從頭壓**——Level 2 是壓 Level 1 的輸出，不回讀原始內容。

#### Message Metadata 擴充

```typescript
interface Message {
  role: string;
  content: string | ContentBlock[];
  tokens?: number;
  // ── 新增 CE metadata ──
  turnIndex?: number;           // 所屬 turn（用於計算年齡）
  timestamp?: number;           // 建立時間（用於 time-aware 衰減）
  compressionLevel?: number;    // 0=原始, 1=精簡, 2=核心, 3=stub
  originalTokens?: number;      // 壓縮前的 token 數（追蹤用）
  compressedBy?: string;        // 壓縮策略名稱（追蹤用）
}
```

#### 四種衰減模式（config 切換）

| 模式 | 觸發條件 | 適用場景 |
|------|---------|---------|
| **discrete** | 固定 turn 年齡閾值 | 最簡單，可預測，debug 容易 |
| **continuous** | 指數衰減函數 | 更平滑的壓縮曲線 |
| **time-aware** | 時間 + 對話節奏 | 高頻/低頻討論自動調適 |
| **auto**（預設） | discrete 底線 + 指數衰減 × tempo 加速 | 三合一混合，兼顧保底、平滑與動態調適 |

**discrete 模式**：
```
age >= levels[i].minAge → 壓到對應 level
```

**continuous 模式**：
```
retainRatio = e^(-baseDecay × age)
targetLevel = floor(retainRatio 對應的 level)
```

**time-aware 模式**：
```
tempo = avg_turn_interval / referenceIntervalSec
tempoMultiplier = clamp(tempo, tempoRange[0], tempoRange[1])
effectiveAge = age × tempoMultiplier
→ 高頻討論衰減快（相鄰 turn 資訊重疊高）
→ 低頻討論衰減慢（每個 turn 是獨立意圖）
```

**auto 模式（預設，建議使用）**：

三合一：指數衰減提供平滑曲線，tempo 調整衰減速度，discrete 當硬底線。

```
// Step 1: tempo 動態調整指數衰減速度
tempoMultiplier = clamp(avg_interval / referenceInterval, 0.5, 2.0)
effectiveDecay  = baseDecay × tempoMultiplier

// Step 2: 指數衰減算出連續保留率
retainRatio = e^(-effectiveDecay × turnAge)

// Step 3: 保留率 → level 對照
continuousLevel =
  retainRatio > 0.80 → Level 0 (原始)
  retainRatio > 0.40 → Level 1 (精簡)
  retainRatio > 0.10 → Level 2 (核心)
  retainRatio > 0.05 → Level 3 (stub)
  else               → 消滅

// Step 4: discrete 底線保護（永遠不會比固定規則更寬鬆）
targetLevel = max(discreteLevel(turnAge), continuousLevel)
```

衰減曲線對照（baseDecay=0.3）：

```
一般節奏 (tempo=1.0, effectiveDecay=0.3)：
  age 0 → retain 1.00  → Level 0 (原始)
  age 1 → retain 0.74  → Level 1 (精簡)     ← 指數衰減比 discrete 早觸發
  age 2 → retain 0.55  → Level 1
  age 3 → retain 0.41  → Level 1             ← discrete 底線拉到 Level 2
  age 5 → retain 0.22  → Level 2
  age 8 → retain 0.09  → Level 3
  age 11→ retain 0.04  → 消滅

高頻 (tempo=2.0, effectiveDecay=0.6)：
  age 0 → retain 1.00  → Level 0
  age 1 → retain 0.55  → Level 1
  age 2 → retain 0.30  → Level 2             ← 比一般快一級
  age 4 → retain 0.09  → Level 3
  age 6 → retain 0.03  → 消滅               ← 比一般早 5 turn 消滅

低頻 (tempo=0.5, effectiveDecay=0.15)：
  age 0 → retain 1.00  → Level 0
  age 1 → retain 0.86  → Level 0             ← 衰減很慢
  age 3 → retain 0.64  → Level 1             ← discrete 底線拉到 Level 2
  age 6 → retain 0.41  → Level 2             ← discrete 底線拉到 Level 3
```

行為示意：

| 場景 | discrete | 指數衰減×tempo | auto 取值 | 原因 |
|------|----------|---------------|-----------|------|
| 低頻（5分鐘/turn），age=2 | Level 1 | Level 0 | **Level 1** | discrete 保底 |
| 高頻（10秒/turn），age=2 | Level 1 | Level 2 | **Level 2** | 指數衰減加速 |
| 一般節奏，age=5 | Level 2 | Level 2 | **Level 2** | 兩者一致 |
| 高頻 burst 後沉寂，age=8 | Level 3 | Level 3 | **Level 3** | 指數衰減自然收斂 |
| 低頻長對話，age=12 | 消滅 | Level 2 | **消滅** | discrete 底線強制清除 |

**白話**：
- 指數衰減提供平滑的壓縮曲線（不像 discrete 的階梯跳躍）
- tempo 讓衰減速度跟著對話節奏走（高頻快壓、低頻慢壓）
- discrete 當硬底線（不管節奏多慢，超齡就壓，不會無限寬鬆）
- 三者互補，任何情況都不會比 discrete 設定的閾值更寬鬆

### 2.2 Phase 1：衰減裁切（純規則，不需 LLM）

Level 0 → 1 → 2 → 3 → 消滅，全部用截斷/stub 實作，零 LLM 依賴。

**衰減表（discrete 預設值）**：

| Level | 觸發條件 | 處理方式 | Token 估算 |
|-------|---------|---------|-----------|
| 0 (原始) | 當前 turn | 不動 | ≤ 8,000 |
| 1 (精簡) | age ≥ 1 | 截斷到 2,000 tokens（head+tail） | ≤ 2,000 |
| 2 (核心) | age ≥ 3 | 截斷到 500 tokens | ≤ 500 |
| 3 (stub) | age ≥ 6 | `[工具: read_file src/foo.ts → 200行]` | ~30 |
| 消滅 | age ≥ 10 | 從 history 移除 | 0 |

**已壓縮不重壓**：`if (m.compressionLevel >= targetLevel) skip`

### 2.3 Phase 2：Turn 結束 LLM 摘要（可選）

Phase 1 是截斷（丟細節），Phase 2 是濃縮（保留語意）。

**流程**：turn 結束後異步，用本地模型把 tool_result 壓成語意摘要。

**與 Phase 1 的交互**：
- Phase 2 開啟時，Level 0→1 改用 LLM 摘要（而非截斷）
- Level 1→2→3 仍用截斷（摘要已經夠短，不值得再跑 LLM）
- Phase 2 關閉時，Phase 1 的純截斷仍然有效

**按 tool 類型客製摘要 prompt**：

| Tool | 摘要重點 |
|------|---------|
| read_file | 檔案結構、關鍵函式/類別、行數 |
| grep/glob | 命中檔案列表、命中行摘要 |
| run_command | exit code、關鍵輸出、錯誤訊息 |
| edit_file | 修改了什麼、影響範圍 |
| web_fetch | 頁面主題、關鍵資訊 |

### 2.4 Phase 3：重複 Turn 去重

偵測連續對同一目標的重複操作，只保留最終結果。

- 保留最後成功的 turn 完整內容
- 中間 turn 壓成 stub：`[重試 edit_file src/foo.ts ×3 → 第 4 次成功]`
- 可接 rut-detector 信號

### 2.5 Phase 4：語意裁切（延後）

用 embedding 算舊 turn 和當前 prompt 的相似度，低相關 turn 裁掉。優先級最低。

---

## 三、Config 整合

### 3.1 統一 Context Engineering 區塊

將 `toolBudget` 整合進 `contextEngineering`，所有 CE 相關設定集中管理：

```jsonc
// catclaw.json — 優化後
{
  "contextEngineering": {
    "enabled": true,
    
    // ── Tool Budget（從頂層搬入）──
    "toolBudget": {
      "resultTokenCap": 8000,       // 單次 tool 回傳 token 上限（預設 8000，0=無限制）
      "perTurnTotalCap": 0,         // 單 turn 所有 tool 合計上限（預設 0=無限制）
      "toolTimeoutMs": 30000,       // 單次 tool 執行超時 ms（預設 30000，0=無限制）
      "maxWriteFileBytes": 512000   // write/edit 單次上限 bytes（預設 512000=500KB，0=無限制）
    },
    
    // ── 衰減壓縮策略 ──
    "strategies": {
      "decay": {
        "enabled": true,
        "mode": "auto",              // "discrete" | "continuous" | "time-aware" | "auto"
        
        // discrete 底線（auto 模式下也生效，作為最低壓縮保證）
        "levels": [
          { "minAge": 1, "maxTokens": 2000 },        // Level 1: 精簡
          { "minAge": 3, "maxTokens": 500 },          // Level 2: 核心
          { "minAge": 6, "maxTokens": 80 },           // Level 3: stub
          { "minAge": 10, "action": "remove" }        // 消滅
        ],
        
        // continuous 模式參數
        "baseDecay": 0.3,
        "minRetainRatio": 0.05,
        
        // time-aware / auto 模式參數
        "referenceIntervalSec": 60,
        "tempoRange": [0.5, 2.0]
      },
      
      // 重複 turn 去重
      "dedup": {
        "enabled": false,
        "minRepeat": 2
      },
      
      // Turn 結束 LLM 摘要
      "turnSummary": {
        "enabled": false,
        "model": "gemma4",
        "maxConcurrent": 2
      },
      
      // LLM 全量壓縮（現有）
      "compaction": {
        "enabled": true,
        "triggerTokens": 20000,
        "preserveRecentTurns": 5,
        "model": null                // null = 用平台 ceProvider
      },
      
      // 緊急截斷（現有）
      "overflowHardStop": {
        "enabled": true,
        "hardLimitUtilization": 0.95,
        "contextWindowTokens": 100000
      }
    },
    
    // ── 記憶注入 Budget ──
    "memoryBudget": 2000              // context-builder.ts 的 token 上限
  }
  
  // "toolBudget" 頂層欄位仍支援（向後相容），讀取時 merge 到 contextEngineering.toolBudget
}
```

### 3.2 遷移策略（不留向後相容）

- 頂層 `toolBudget` 直接移除，不做 fallback
- `config.ts` 中刪除頂層 `toolBudget` 型別和解析
- 所有讀取 `config.toolBudget` 的程式碼改為 `config.contextEngineering.toolBudget`
- 啟動時若偵測到舊 config 有頂層 `toolBudget` → log.warn 提示遷移

### 3.3 預設值完整列表

| 設定路徑 | 預設值 | 說明 |
|---------|--------|------|
| `contextEngineering.enabled` | `true` | CE 總開關 |
| `.toolBudget.resultTokenCap` | `8000` | 單次 tool 回傳 token 上限 |
| `.toolBudget.perTurnTotalCap` | `0` | 單 turn tool 合計（0=無限制）|
| `.toolBudget.toolTimeoutMs` | `30000` | tool 執行超時 ms |
| `.toolBudget.maxWriteFileBytes` | `512000` | write/edit 上限 bytes |
| `.strategies.decay.enabled` | `true` | 衰減策略開關 |
| `.strategies.decay.mode` | `"auto"` | 衰減模式（discrete/continuous/time-aware/auto） |
| `.strategies.dedup.enabled` | `false` | 去重策略開關 |
| `.strategies.turnSummary.enabled` | `false` | LLM 摘要開關 |
| `.strategies.compaction.enabled` | `true` | LLM 壓縮開關 |
| `.strategies.compaction.triggerTokens` | `20000` | 壓縮觸發閾值 |
| `.strategies.compaction.preserveRecentTurns` | `5` | 保留最近 N turn |
| `.strategies.overflowHardStop.enabled` | `true` | 緊急截斷開關 |
| `.strategies.overflowHardStop.hardLimitUtilization` | `0.95` | 截斷比例 |
| `.strategies.overflowHardStop.contextWindowTokens` | `100000` | context window 大小 |
| `.memoryBudget` | `2000` | 記憶注入 token 上限 |

---

## 四、Trace & Dashboard 追蹤

### 4.1 Trace 擴充

現有 `contextEngineering` trace 只記錄整體數據。擴充為 per-strategy 明細：

```typescript
// message-trace.ts — 擴充後
contextEngineering?: {
  // 整體（保留現有，向後相容）
  strategiesApplied: string[];
  tokensBeforeCE: number;
  tokensAfterCE: number;
  tokensSaved: number;
  
  // 新增：per-strategy 明細
  strategyDetails?: Array<{
    name: string;                    // 策略名稱
    tokensBeforeThis: number;        // 此策略套用前
    tokensAfterThis: number;         // 此策略套用後
    messagesAffected: number;        // 影響了多少 messages
    // decay 專屬
    levelChanges?: Array<{
      messageIndex: number;
      fromLevel: number;
      toLevel: number;
      tokensBefore: number;
      tokensAfter: number;
    }>;
    // dedup 專屬
    deduplicatedTurns?: number;
    // compaction 專屬
    compactionSummaryTokens?: number;
  }>;
  
  // 新增：原始訊息摘要（壓縮前的標題級資訊）
  originalMessageDigest?: Array<{
    index: number;
    role: string;
    turnIndex: number;
    originalTokens: number;
    currentTokens: number;
    compressionLevel: number;
    toolName?: string;               // 若為 tool_result，記錄 tool 名稱
  }>;
};
```

### 4.2 Session Messages 標記

Dashboard `/api/sessions/messages` 回傳的是壓縮後的 session 內容（因為那就是真正送 LLM 的）。
壓縮後的 message 加上標記，讓 Dashboard UI 能區分：

```typescript
// Dashboard API 回傳格式
{
  role: "user",
  content: "[工具: read_file src/foo.ts → 200行]",
  // 新增標記
  _ce: {
    compressed: true,
    compressionLevel: 3,
    originalTokens: 7800,
    currentTokens: 30,
    compressedBy: "decay"
  }
}
```

Dashboard UI 可以：
- 壓縮的 message 顯示不同底色/圖標
- 滑鼠懸停顯示「原始 7800 tokens → 壓縮後 30 tokens（by decay Level 3）」
- 提供「展開原始」按鈕（如果有保留原始快照）

### 4.3 Trace 和 Session 的關係

```
┌──────────────────────────────────────────────────┐
│ Trace（記錄 CE 行為過程）                         │
│  - 每個 turn 一筆 trace entry                     │
│  - 記錄：套用了哪些策略、每個策略的 before/after   │
│  - 記錄：每個 message 的壓縮 level 變化           │
│  - 目的：事後分析、debug、效果追蹤                │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│ Session Messages（LLM 實際看到的內容）             │
│  - 壓縮後的 messages（附 _ce 標記）               │
│  - 這是「真相」——LLM 基於這些內容做決策           │
│  - Dashboard 顯示時標記壓縮狀態                   │
└──────────────────────────────────────────────────┘
```

**Trace 回答「CE 做了什麼」，Session 回答「LLM 看到什麼」。**

### 4.4 Trace Tab 過濾與分類

現有 Trace tab 只有 Agent ID 篩選，所有 trace 混在一起。新增過濾列：

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Session ▾]  [Status ▾]  [CE ▾]  [Category ▾]  Agent: [___]  [50] │
└─────────────────────────────────────────────────────────────────────┘
```

| 過濾器 | 選項 | 資料來源 |
|--------|------|---------|
| **Session** | 全部 / 各 sessionKey | `trace.sessionKey` |
| **Status** | 全部 / ✅ completed / ⏳ in_progress / ⏹ aborted / ❌ error | `trace.status` |
| **CE** | 全部 / 📦 有 CE 觸發 / 無 CE | `trace.contextEngineering?.strategiesApplied` |
| **Category** | 全部 / discord / api / cron | `trace.category` |
| **Agent ID** | 文字搜尋（現有） | `trace.agentId` |

**CE 欄顯示強化**：

現狀：`📦compaction` 或 `-`
優化後：`📦 decay(3) compaction` — 顯示每個策略 + 影響數量

滑鼠懸停 tooltip：
```
decay: 3 messages 受影響，省下 12,400 tokens
  - msg#2: Level 0→2 (8000→500)
  - msg#4: Level 1→3 (1600→80)
  - msg#6: Level 0→1 (6000→2000)
compaction: 觸發，壓縮 10 messages → 摘要 800 tokens
```

**實作方式**：純前端篩選（資料已在 trace entry 上），不需改 API。

### 4.5 Dashboard CE 設定面板

現有 Dashboard 已有 `toolBudget` 設定區塊（dashboard.ts:1507-1510）。
整合後改為統一的 Context Engineering 面板：

```
[Context Engineering]
  ├── Tool Budget
  │    ├── Result Token Cap: [8000]  (預設 8000, 0=無限制)
  │    ├── Per Turn Total Cap: [0]   (預設 0=無限制)
  │    ├── Tool Timeout (ms): [30000]
  │    └── Max Write Bytes: [512000]
  │
  ├── Decay Strategy
  │    ├── Enabled: [✓]
  │    ├── Mode: [auto ▾]  (discrete / continuous / time-aware / auto)
  │    └── Levels: (table editor)
  │
  ├── Dedup Strategy
  │    ├── Enabled: [□]
  │    └── Min Repeat: [2]
  │
  ├── Turn Summary (LLM)
  │    ├── Enabled: [□]
  │    └── Model: [qwen3:1.7b]
  │
  ├── Compaction (LLM)
  │    ├── Enabled: [✓]
  │    ├── Trigger Tokens: [20000]
  │    └── Preserve Recent Turns: [5]
  │
  ├── Overflow Hard Stop
  │    ├── Hard Limit %: [0.95]
  │    └── Context Window: [100000]
  │
  └── Memory Budget: [2000]
```

---

## 五、策略套用順序（CE Pipeline）

```
contextEngine.build(messages, opts)
  │
  ├── ① decay              — 每次都跑，漸進衰減（純規則 or LLM 摘要看開關）
  │      ↓ 已壓縮的 message 帶 compressionLevel 標記
  ├── ② dedup              — 每次都跑（若開啟），重複 turn 去重
  │      ↓
  ├── ③ compaction          — tokens > 閾值才觸發（觸發頻率大幅降低）
  │      ↓
  └── ④ overflow-hard-stop  — tokens > 95% 緊急截斷
  
  turn 結束後（異步）：
  └── ⑤ turnSummary         — 本地 LLM 摘要該 turn 的 tool_result（若開啟）
```

---

## 六、效果對比

### 現狀 vs 優化後

| 指標 | 現狀 | Phase 1 後 | Phase 1+2 後 | 全部完成 |
|------|------|-----------|-------------|---------|
| Compaction 觸發頻率 | 每 2-3 turn | 每 ~10 turn | 每 ~20-30 turn | 每 ~30-50 turn |
| 單次 compaction 壓縮量 | ~15K tokens | ~10K tokens | ~5K tokens | ~3K tokens |
| 壓縮品質 | 不穩定（量大） | 較好（量小） | 好（量更小） | 好 |
| 每 turn 額外延遲 | 0 | 0 | 3-6 秒（異步） | 3-6 秒（異步） |
| 有效對話長度 | ~10 turn | ~25 turn | ~40 turn | ~50 turn |
| LLM 依賴 | compaction 時 | compaction 時 | 每 turn + compaction | 每 turn + compaction |
| 實作難度 | — | 低 | 中 | 中高 |

### Token 消耗模擬（10 turn 對話）

```
現狀：
  Turn 1  ████████████████ 6K
  Turn 2  ████████████████████████████████████ 14K
  Turn 3  ██████████████████████████████████████████████ 21K → COMPACT → 5K
  Turn 4  █████████████████████████ 13K
  Turn 5  ████████████████████████████████████ 20K → COMPACT → 5K
  ...反覆壓縮，早期資訊逐漸消失

Phase 1 (衰減裁切)：
  Turn 1  ████████████████ 6K
  Turn 2  ███████████████████████ 10K   (turn 1 tool 裁到 2K)
  Turn 3  ████████████████████████████ 13K   (turn 1→500, turn 2→2K)
  Turn 4  ██████████████████████████████ 15K
  Turn 5  ████████████████████████████████ 16K
  ...
  Turn 10 ████████████████████████████████████████ 20K → 才觸發 COMPACT
  對話骨架完整保留，只有 tool 細節逐漸模糊

Phase 1+2 (衰減 + LLM 摘要)：
  Turn 1  ████████████████ 6K
  Turn 2  ██████████████████ 8K   (turn 1 tool 已摘要到 500)
  Turn 3  ████████████████████ 10K
  ...
  Turn 20 ████████████████████████████████████████ 20K → 才觸發 COMPACT
  tool 結果語意完整保留，只是濃縮了
```

---

## 七、執行計劃

| Phase | 內容 | 預估工時 | 依賴 | 風險 |
|-------|------|---------|------|------|
| Phase | 內容 | 預估工時 | 依賴 | 風險 |
|-------|------|---------|------|------|
| **0** | Config 整合（toolBudget → CE 區塊，不留舊位置） | 1-2 小時 | 無 | 低 |
| **1** | 衰減裁切（auto 模式：discrete+continuous+time-aware 三合一）+ Message metadata | 3-4 小時 | Phase 0 | 低 |
| **1b** | Trace 擴充 + Session 壓縮標記 + Trace tab 過濾 + Dashboard CE 面板 | 3-4 小時 | Phase 1 | 低 |
| **2** | Turn 結束 LLM 摘要（gemma4，異步） | 4-6 小時 | Ollama client | 中 |
| **3** | 重複 Turn 去重 | 3-4 小時 | Phase 1 | 低 |
| **4** | 語意裁切 | 評估中 | embedding service | 延後 |

**執行順序：0 → 1 → 1b → 驗證 → 2 → 3**
**作業分支：`feature/ce-optimization`**

---

## 八、決策結果（2026-04-11 確認）

| # | 問題 | 決定 | 備註 |
|---|------|------|------|
| 1 | 衰減閾值 | **1/3/6/10 四段（我的方案）** | Dashboard 可調即可 |
| 2 | 預設衰減模式 | **auto（三合一：discrete+continuous+time-aware）** | — |
| 3 | Phase 2 本地模型 | **gemma4**（via Ollama） | — |
| 4 | 摘要時機 | **異步** | gemma4 較大延遲更高，異步不阻塞使用者；下一 turn 若摘要未完成，Phase 1 截斷先頂 |
| 5 | 開 branch | **是，`feature/ce-optimization`** | — |
| 6 | 向後相容 | **不留舊 `toolBudget`，直接遷移** | 一次到位，以絕後患 |
| 7 | 原始訊息快照 | **保留** | Trace context snapshot 的 `messagesBeforeCE` 已有原始內容，不會砍；Dashboard 可從 trace 展開查看 |
