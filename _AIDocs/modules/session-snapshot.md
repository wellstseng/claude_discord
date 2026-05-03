# Session Snapshot — Turn 快照與回退 + Frozen Prompt Materials

> 對應原始碼：`src/core/session-snapshot.ts`
> 更新日期：2026-05-03

本檔含**兩套獨立機制**，職責分離：

| 機制 | 對象 | 儲存 | 觸發 |
|------|------|------|------|
| `SessionSnapshotStore` | 每 turn 前 messages | 磁碟（48h TTL on CE） | 每 turn 開始前 |
| `FrozenPromptMaterials`（v2 新增） | session 開場 prompt 材料 | in-memory Map | session 開場（turnCount === 0） |

---

## Part A：Session Snapshot Store（既有機制）

### 概觀

Agent loop 開始前快照 session messages，供 `/stop` 中斷回退或 `/rollback` 手動還原。

## 生命週期

| 情境 | 行為 |
|------|------|
| 正常完成 + 無 CE 壓縮 | 刪除快照 |
| 正常完成 + CE 壓縮 | 保留 48h（供 /rollback） |
| `/stop` 中斷 | 還原快照 → 刪除 |

## SessionSnapshotStore class

| 方法 | 說明 |
|------|------|
| `save(sessionKey, turnIndex, messages, ceApplied?)` | 建立快照 |
| `get(sessionKey, turnIndex)` | 讀取特定 turn 快照 |
| `list(sessionKey)` | 列出所有可用快照（按 turnIndex 降序） |
| `delete(sessionKey, turnIndex)` | 刪除快照 |
| `cleanup()` | TTL 清理：過期的刪除，無 expiresAt 超過 1h 的孤立檔也刪除 |

## 儲存格式

```
{dataDir}/session-snapshots/{safe_session_key}_snap_{turnIndex}.json
```

### SessionSnapshotRecord

```ts
interface SessionSnapshotRecord {
  sessionKey: string;
  turnIndex: number;
  messages: Message[];
  snapshotAt: string;    // ISO 8601
  ceApplied: boolean;
  expiresAt?: string;    // 48h TTL（CE 壓縮時設定）
}
```

### 全域單例

`initSessionSnapshotStore(dataDir)` / `getSessionSnapshotStore()`

---

## Part B：Frozen Prompt Materials（2026-05-03 新增，項目 5 落地）

### 動機

Anthropic prompt cache 以 system prompt **前綴匹配**：任一字元變動 → 整段 cache 失效。`prompt-assembler.ts` 13 個 module 中有多個每 turn 變動（dateTime / catclaw-md / coding-rules / tool-summary / skill-summary / failure-recall / memory block）— 導致 system prompt 跨 turn byte-wise 不同，cache 永遠 miss。

試算：3000 token system prompt × 200 turn/day，cache miss 每日多計價 540K tokens。

### 機制

session 開場時凍結各 module 的「session 內穩定」內容到 in-memory Map，後續 turn 從 Map 讀取同一份 → system prompt 跨 turn byte-wise 相同 → cache 命中。

### `FrozenPromptMaterials` interface

```ts
interface FrozenPromptMaterials {
  // 從 prompt-assembler module 凍結
  dateTimeText: string;
  catclawMdText: string;
  codingRulesText: string;
  toolSummaryText: string;
  skillSummaryText: string;
  failureRecallText: string;
  // 從 memory engine 凍結（session 開場 recall + buildContext）
  memoryContextBlock: string;
  // metadata
  preparedAt: string;        // ISO 8601
  sessionKey: string;
  accountId: string;
  channelId: string;
  agentId?: string;
}
```

### API

| 函式 | 說明 |
|------|------|
| `prepareSessionSnapshot(opts)` | 凍結 6 個 module 輸出 + session 開場 memory recall，組成 `FrozenPromptMaterials` |
| `getFrozenMaterials(sessionKey)` | 從 in-memory Map 取出（後續 turn 用） |
| `setFrozenMaterials(sessionKey, materials)` | 存入 Map（SessionStart hook 內呼叫） |
| `clearFrozenMaterials(sessionKey)` | 從 Map 移除（session.delete / session.clearMessages 呼叫） |

### 觸發點

| 點位 | 行為 |
|------|------|
| `agent-loop.ts:815-822` SessionStart hook（turnCount === 0） | 呼叫 `prepareSessionSnapshot` + `setFrozenMaterials` |
| `message-pipeline.ts:194-` Memory recall 段 | 先看 `getFrozenMaterials` 命中即用，否則 fallback live recall |
| `agent-loop.ts:965-` 第二條 memory recall | 同上 fallback 邏輯 |
| `prompt-assembler.ts` 6 module `build()` | 開頭判 `ctx.frozenMaterials` 短路返回凍結值 |
| `session.ts` `delete()` / `clearMessages()` | `clearFrozenMaterials` 防 leak |

### `/reload` skill

手動修改 CATCLAW.md / 規則檔後，執行 `/reload` 強制重建 snapshot。下個 turn cache miss 一次，之後恢復命中。原始碼：`src/skills/builtin/reload.ts`。

### 已知限制（不在此機制範圍）

下列 mid-turn 動態仍會讓 system prompt 變動，**接受偶發 cache break**：
- `agent-loop.ts:1063-1079` token-budget-nudge（context 使用率 ≥ 60% 才出現）
- `agent-loop.ts:1081-1089` externalized-index（依 history 變）
- `agent-loop.ts:1010-1021` plan-mode notice（plan 切換時罕見）
- `agent-loop.ts:1106-1114` session-note（mid-session 寫入）

第一個 turn cache miss 為預期行為（snapshot 種子）；Turn 2+ 起命中。
