# modules/context-engine — Context 壓縮策略

> 檔案：`src/core/context-engine.ts`
> 更新日期：2026-04-20

## 職責

Strategy Pattern 架構的 Context Engineering 引擎。
管理 messages 歷史的 token 使用量，透過漸進式衰減 + 壓縮控制 context window。

## 策略一覽

| 策略 | 預設啟用 | 觸發條件 | 行為 |
|------|---------|---------|------|
| `decay` | ✓ | 每次 build（always） | 依 turn age 漸進壓縮/移除舊訊息 |
| `compaction` | ✓ | tokens > triggerTokens (20000) | LLM 摘要壓縮舊訊息 |
| `overflow-hard-stop` | ✓ | tokens > window × 0.95 | 緊急截斷至 4 條 |

執行順序：decay → compaction → overflow-hard-stop

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

### LevelChange

```typescript
interface LevelChange {
  messageIndex: number;
  fromLevel: number;
  toLevel: number;
  tokensBefore: number;
  tokensAfter: number;
}
```

### StrategyDetail

```typescript
interface StrategyDetail {
  name: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved?: number;
  messagesDecayed?: number;
  levelChanges?: LevelChange[];  // decay 專屬：per-message level 變化
}
```

### OriginalMessageDigest

```typescript
interface OriginalMessageDigest {
  index: number;
  role: string;
  turnIndex: number;
  originalTokens: number;
  currentTokens: number;
  compressionLevel: number;
  toolName?: string;
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
  overflowSignaled?: boolean;
  strategyDetails?: StrategyDetail[];
  originalMessageDigest?: OriginalMessageDigest[];  // CE 前 message 摘要
}
```

### Message CE Metadata

每條 Message 可攜帶 CE metadata（`providers/base.ts`）：

| 欄位 | 說明 |
|------|------|
| `turnIndex` | 所屬 turn index |
| `timestamp` | 建立時間戳 |
| `compressionLevel` | 0=原始, 1=精簡, 2=核心, 3=stub |
| `originalTokens` | 壓縮前的原始 token 數 |
| `compressedBy` | 執行壓縮的策略名稱 |

## Stub 格式（Anti-Hallucination）

L3 stub 和各類標記的格式設計為「誠實指標」而非「假錨點」，避免 LLM 從標記推論內容：

| 標記 | 說明 |
|------|------|
| `[已壓縮 user turn N｜內容不可恢復，勿引用]` | Decay L3 stub（新格式） |
| `[工具索引 turn N] 呼叫：...` + ⚠️ | Tool log 索引（新格式） |
| `[📄 外部化] ... ⚠️` | 外部化摘要指標（含勿腦補警語） |
| `[對話摘要｜多輪壓縮，非原文，可能遺漏細節]` | Compaction 摘要（含禁止引用警語） |
| `[user stub]` / `[assistant stub]` | 舊格式（自然衰減中） |
| `[工具記錄] ...` | 舊格式（自然衰減中） |

`prompt-assembler.ts` 的 `context-integrity` module 注入鐵則：禁止憑標記推論原文、必須 read_file 實際路徑。

## DecayStrategy（漸進式衰減）

每次 build 都執行。依據 message 的 turn age 計算 targetLevel，漸進壓縮。

### 模式

- **auto**（預設）：`targetLevel = max(discrete, continuous with tempo)` — 三合一
- **discrete**：固定閾值，依 minAge 跳級
- **continuous**：`retainRatio = e^(-baseDecay × age)`，平滑曲線
- **time-aware**：continuous + tempo multiplier（依對話節奏調整）

### Decay Levels

| Level | 預設 minAge | maxTokens | 行為 |
|-------|-----------|-----------|------|
| L1 | 1 | 2000 | 精簡（截斷長內容） |
| L2 | 3 | 500 | 核心（只保留關鍵內容） |
| L3 | 6 | 80 | stub（極簡佔位） |
| L4 | 10 | — | 移除 |

### Continuous Retain Ratio → Level 映射

| retainRatio 範圍 | Level |
|-----------------|-------|
| > 0.80 | L0（原始） |
| > 0.40 | L1 |
| > 0.10 | L2 |
| > 0.05 | L3 |
| ≤ 0.05 | L4（移除） |

### Tempo Multiplier

`tempoMultiplier = clamp(avgIntervalSec / referenceIntervalSec, 0.5, 2.0)`

高頻對話（間隔短）→ multiplier < 1 → 衰減慢；低頻對話 → multiplier > 1 → 衰減快。

### DecayStrategyConfig

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `mode` | "auto" | discrete / continuous / time-aware / auto |
| `baseDecay` | 0.3 | 指數衰減係數 |
| `referenceIntervalSec` | 60 | tempo 參考間隔（秒） |
| `tempoRange` | [0.5, 2.0] | tempo multiplier 上下限 |
| `levels` | 見上表 | 自訂 decay level 定義 |
| `externalize` | 見下方 | 長訊息外部化子設定 |

### Externalization（外部化）

整合在 Decay 內部。Level transition 時，長訊息在 truncate 前存原文到外部檔案，context 只留摘要指標。

**觸發條件**：`targetLevel >= triggerLevel` AND `originalTokens >= minTokens` AND `compressedBy !== "externalize"`

**流程**：
1. Decay `_calcTargetLevel()` 決定目標 level
2. 符合外部化條件 → `externalizeMessage()` 存原文到 `data/externalized/{safeSessionKey}/msg_t{turnIndex}_i{msgIdx}.json`
3. `createExternalizedStub()` 建立純路徑指標訊息（不含原文截斷 preview，避免 agent 誤把截斷內容當原文）
4. 設定 `compressedBy = "externalize"`，跳過後續 truncate
5. 存檔失敗 → fallback 到一般 truncate

**摘要指標格式**（絕對路徑 + 原始 token 數，不含原文）：
```
[📄 外部化] assistant turn 5（原始 1234 tokens 已存至檔案）
→ /abs/path/data/externalized/discord_ch_123/msg_t5_i12.json
⚠️ 如需原文請用 read_file 讀取上方絕對路徑。若無法讀取則告知使用者，勿腦補。
```

**外部檔案格式**：
```json
{
  "sessionKey": "discord:ch:123",
  "turnIndex": 5,
  "messageIndex": 12,
  "role": "assistant",
  "originalTokens": 1500,
  "externalizedAt": "2026-04-12T16:00:00Z",
  "content": "（完整原文）"
}
```

**ExternalizeConfig**：

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `triggerLevel` | 2 | 觸發等級（L1→L2 時外部化） |
| `minTokens` | 300 | 最小 token 閾值 |
| `ttlDays` | 14 | 外部檔案保留天數 |
| `storePath` | "data/externalized" | 存儲路徑 |

**清理**：`cleanupExternalized(dataDir, ttlDays)` 在 `initContextEngine` 時執行，刪除超過 TTL 的檔案。

## CompactionStrategy

觸發條件：`estimatedTokens > triggerTokens`（預設 20000）

有 ceProvider → LLM 摘要壓縮：
1. 保留最近 `preserveRecentTurns × 2` 條 messages
2. 舊的 messages 過濾掉 stub/索引/外部化標記（避免雙重失真），再扁平化為文字 → LLM 摘要
3. 摘要結果作為 `[對話摘要｜多輪壓縮，非原文，可能遺漏細節]` user message 置入（附 ⚠️ 警語禁止直接引用）
4. System messages 不壓縮
5. 過濾後無語意內容 → 跳過 compaction

無 ceProvider → fallback sliding-window（保留最近 N 輪 + repairToolPairing）

### 摘要 Prompt 結構（agent 接續視角）

System prompt 要求「紀錄員」視角，第一人稱（我），優先保留**使用者意圖**與**未解決問題**。
User prompt 強制結構化六段（缺項填「無」，不得省略章節）：

| 章節 | 內容 |
|------|------|
| 使用者意圖 | 使用者真正想完成的事（用使用者的話描述目標，非我做了什麼） |
| 已決策事項 | 雙方明確同意要採用 / 拒絕的方案、使用者偏好 |
| 待辦／進行中 | 我答應要做但還沒完成的事 |
| 未解決問題 | 使用者問了但還沒得到滿意答案的事、卡住點、歧義 |
| 工具產出重點 | 工具呼叫的「結論」（寫拿到了什麼有用資訊，不列工具流水帳） |
| 重要事實 / 限制 | 會讓我接續時搞錯的關鍵事實（檔案路徑、決策原因、規格限制） |

### Message 扁平化切割上限

| 型別 | 上限（chars） |
|------|-------------|
| user text | 2000 |
| assistant text | 1500 |
| tool_use input | 500 |
| tool_result content | 800 |

### 意圖錨點（Intent Anchor）

摘要完成後，從 `semanticMessages` 反向找最後一則長度 ≥ 50 char 的 user 訊息，取原文前 800 char，附加在摘要後面：

```
📌 使用者最近一則完整指令（原文，未壓縮）：
{原文片段}
```

目的：即使 LLM 摘要偏離使用者意圖，原文錨點仍能讓後續 turn 對齊。無額外 LLM call，純文字擷取。

### CompactionConfig

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `triggerTokens` | 20000 | 觸發閾值 |
| `preserveRecentTurns` | 8 | 保留最近 N 輪不壓縮 |

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
initContextEngine(cfg?)  → ContextEngine   // 接受 decay / compaction / overflowHardStop / dataDir 設定
getContextEngine()       → ContextEngine | null
```

## 設定路徑

CE 設定統一在 `catclaw.json` 的 `contextEngineering` 區塊：

```json
{
  "contextEngineering": {
    "enabled": true,
    "toolBudget": { "resultTokenCap": 8000, ... },
    "memoryBudget": 2000,
    "strategies": {
      "decay": { "enabled": true, "mode": "auto", "baseDecay": 0.15, "externalize": { "enabled": true, "triggerLevel": 2, "minTokens": 300 } },
      "compaction": { "enabled": true, "triggerTokens": 20000 },
      "overflowHardStop": { "enabled": true, "hardLimitUtilization": 0.95 }
    }
  }
}
```

## Hook 整合

`ContextEngine.build()` 觸發：

- **PreCompaction**：decay / compaction strategy 執行前（含 reason + currentTokens）
- **PostCompaction**：decay / compaction strategy 執行後（含 before/afterTokens + durationMs）
- **ContextOverflow**：overflow-hard-stop 觸發時（currentTokens + budgetTokens）

`BuildOpts` 新增 `agentId` / `accountId` 欄位，供 hook 分派使用。
