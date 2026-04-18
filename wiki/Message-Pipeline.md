# Message Pipeline

`src/core/message-pipeline.ts` — 從原始訊息到 Agent Loop 的前處理管線。

## 10 步處理流程

```text
PipelineInput (prompt, platform, channelId, accountId, provider, ...)
  │
  ├── 1. Trace Creation — 建立 / 複用 MessageTrace
  ├── 2. Memory Recall — memEngine.recall() 向量 + 關鍵字搜尋
  ├── 3. Mode Extras — 載入 workspace/prompts/*.md（依 mode preset）
  ├── 4. Intent Detection — detectIntent() → coding | research | conversation
  ├── 5. System Prompt Assembly — assembleSystemPrompt() 模組化組裝
  ├── 6. Assembly Trace — 記錄 modules active / skipped
  ├── 7. Provider Trace — 記錄 provider ID + model
  ├── 8. Inbound History — 注入 Discord 近期訊息（可選）
  ├── 9. Session Memory — 組裝 sessionMemory 設定
  └── 10. Context End Trace — token 估算
  │
  ↓
PipelineResult {
  systemPrompt, trace, memoryContext?,
  assemblerTrace, intent, inboundContext?,
  sessionMemoryOpts?, promptBreakdownHints
}
```

## Intent Detection

依使用者輸入分類意圖，決定 system prompt 載入哪些模組：

| Intent | 載入模組 | 典型場景 |
| ------ | -------- | -------- |
| `coding` | 全部 | 寫程式、改 bug、重構 |
| `research` | 跳過 coding/git 模組 | 查資料、分析問題 |
| `conversation` | 最小集 | 閒聊、問答 |

## Prompt Assembly

`assembleSystemPrompt()` 將 system prompt 從多個**模組**組裝：

13 個 builtin modules：

| # | 模組名 | 說明 |
|---|--------|------|
| 1 | `date-time` | 當前時間（Asia/Taipei） |
| 2 | `identity` | Agent 身份定義 |
| 3 | `context-integrity` | Context 完整性規則 |
| 4 | `catclaw-md` | CATCLAW.md 角色設定載入 |
| 5 | `tools-usage` | 可用工具清單與使用規則 |
| 6 | `coding-rules` | 程式碼撰寫規則 |
| 7 | `git-rules` | Git 操作規則 |
| 8 | `output-format` | 輸出格式規則 |
| 9 | `discord-reply` | Discord 回覆行為規則 |
| 10 | `tool-summary` | Tool 使用摘要 |
| 11 | `skill-summary` | Skill 清單摘要 |
| 12 | `memory-rules` | 記憶系統規則 |
| 13 | `failure-recall` | 失敗記憶回溯（快取同步讀取） |

另支援 `registerPromptModule()` 註冊自訂模組。

- **Module Filter** — 依 intent 過濾不需要的模組

## Memory Recall 注入

Pipeline 呼叫 `memEngine.recall(prompt, context)` 取得相關記憶片段，作為 system prompt 的一部分注入 LLM，讓 agent 能利用過去的知識。

## Inbound History

可選功能 — 從 `InboundHistoryStore` 取得 Discord 頻道的近期訊息（非 session 歷史），提供對話脈絡。適用於 agent 剛加入對話、需要了解前文的場景。

## Trace

每個 pipeline 執行產生一筆 `MessageTrace`，記錄：

- Memory recall 結果與分數
- Prompt assembly 模組清單
- Provider 選擇
- Token 估算
- 可透過 Dashboard API 查閱
