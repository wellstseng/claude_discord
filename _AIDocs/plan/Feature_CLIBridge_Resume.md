# Feature: CLI Bridge 重啟接續任務（方案 C）

> ICLD（Incremental Closed-Loop Development）Sprint 拆解。
> 來源議題：`~/WellsDB/CatClaw議題追蹤/2026-04-27_優化_CLIBridge重啟接續任務.md`
> 決策：方案 C（治本，bridge 維護 turn 狀態機 + checkpoint）
> 起源 commit：階段 3-C（Sprint 1）

## 背景

CLI Bridge 重啟 / shutdown 時，當前正在跑的 turn 會被砍掉。已有：
- ✅ Session ID 透過 `--resume <sessionId>` 恢復對話脈絡
- ✅ 離線期 inbound history（針對 messageCreate 沒進來的訊息）

缺：
- ❌ 進行中的 turn 不會接續 — user 訊息與 assistant 部分回覆都遺失（除非走 inbound history 重送，但 assistant 內容已不可救）
- ❌ 沒有 turn 級進度持久化機制

階段 3-C 已在 Sprint 1 落地**救急方案 A**（user input 補 inbound history），但 assistant 部分回覆仍會遺失。下面 Sprint 2-6 補齊**方案 C**。

## 適用條件評估（ICLD）

| 條件 | 滿足 |
|------|------|
| 預估工期 ≥ 5 天 | ✅ 1-2 天工程量但風險高、需多階段驗證 |
| 跨 Client + Server | 部分（bridge + dashboard） |
| ≥ 3 個獨立子系統 | ✅ bridge / hook / dashboard |
| 新建 ≥ 3 個檔案 | ✅ turn-checkpoint.ts、新測試、文檔 |

→ 用 ICLD Sprint 拆解。

---

## Sprint 1（已完成 — 階段 3-C）

### Sprint 1-a 救急方案 A
- [x] `bridge.ts` 新增 `savePendingUserInputsToInboundHistory(reason)`
- [x] `restart()` / `shutdown()` 開頭呼叫，把 pendingTurns 的 userInput 補進 inboundHistoryStore
- [x] 重啟後 `drainInboundHistoryOnStartup` 自動重送（沿用既有路徑）
- [x] tsc 過、commit 落地

### Sprint 1-b 計畫文件（本檔）
- [x] 拆 Sprint 2-6 的目標與依賴
- [x] 議題標 `status: in_progress`、保留在原目錄（不搬已處理）

---

## Sprint 2: turn-state.json schema 設計 + checkpoint API（4-6 hr）

**目標**：設計 turn 級狀態的持久化格式，並提供讀寫 API。

**步驟**：
1. 新檔 `src/cli-bridge/turn-checkpoint.ts`：
   - `interface TurnCheckpoint`：turnId、startedAt、source、userInput、textPartsAccumulated、toolCallsCount、currentIteration、bridgeLabel、channelId、sessionId
   - `writeCheckpoint(label, channelId, checkpoint)`：寫到 `~/.catclaw/data/cli-bridge/{label}-{channelId}-turn-state.json`
   - `readCheckpoint(label, channelId): TurnCheckpoint | null`
   - `clearCheckpoint(label, channelId)`：完成後清除
2. 為避免併發寫入，加 atomic write（temp file + rename）
3. unit test：寫入 → 讀回 → 比對；併發寫入 → 不損毀
4. 不修 bridge.ts、不啟用 — 純基礎建設

**通過條件**：
- [ ] turn-checkpoint.ts 提供 3 個 API
- [ ] tsc 過
- [ ] unit test 通過
- [ ] 文檔 `_AIDocs/modules/cli-bridge.md` 加 schema 章節

**依賴**：無

---

## Sprint 3: pre-shutdown hook 寫 checkpoint（4-6 hr）

**目標**：bridge 重啟 / shutdown 時持久化當前 turn 進度。

**步驟**：
1. `bridge.ts` 在 `pendingTurns` 增 `iterationCount`（每次 LLM call 累計）— 或從 stdoutLogger 統計
2. `restart()` / `shutdown()` 開頭：呼叫 `writeCheckpoint`（取代 / 並列救急方案 A — 但 A 仍保留作為 fallback）
3. 區分「優雅 shutdown」與「意外 crash」：
   - 優雅 → 寫 checkpoint
   - crash（process close）→ 沒辦法寫，依賴方案 A 的 inbound history
4. 一個 turn 完成（completeTurn）→ 呼叫 `clearCheckpoint`
5. integration test：重啟前 turn 跑到一半 → 重啟後檔案存在 → drain 後檔案被清

**通過條件**：
- [ ] checkpoint 在 restart/shutdown 都有寫
- [ ] turn 完成時清除
- [ ] tsc 過
- [ ] 手動 `pm2 restart catclaw` 在進行中觀察 turn-state.json 落盤

**依賴**：Sprint 2

---

## Sprint 4: post-startup hook 讀 checkpoint + 注入 resume prompt（6-8 hr）

**目標**：重啟後 bridge 上線 → 讀 checkpoint → 注入 resume prompt 接續 turn。

**步驟**：
1. `bridge.ts` 在 `start()` 內、上線通知之後、`drainInboundHistoryOnStartup` 之前：
   - 呼叫 `readCheckpoint`
   - 有 → 構造 resume prompt：「上次處理「{userInput}」做到第 {iter} 輪（已執行 {toolCount} 個工具），請接續」
   - `bridge.send(resumePrompt, "discord", ...)` 注入
   - 注入後立刻 `clearCheckpoint`（防無限循環）
2. 與 Sprint 1-a inbound history 救急機制協調：
   - 有 checkpoint → 走 resume prompt 路徑（assistant 也試圖救援）
   - 無 checkpoint → 走 inbound history 救急（純 user input 重送）
   - 兩者**互斥**（實際是兩個 fallback chain）
3. integration test：模擬「turn 跑到 iter=3」→ kill bridge → 重啟 → 看新 turn 的第一段 prompt 是否含「請接續」

**通過條件**：
- [ ] resume prompt 注入正確
- [ ] checkpoint 用完即清
- [ ] inbound history 救急仍然 work（fallback）
- [ ] tsc 過 + integration test 通過

**依賴**：Sprint 3

---

## Sprint 5: dashboard 顯示「未完成 turn」徽章（3-4 hr）

**目標**：dashboard cli-bridge tab 顯示哪些 bridge 有 pending checkpoint。

**步驟**：
1. dashboard 加 `/api/cli-bridge/checkpoints` 端點 → 列出所有 bridge 的 checkpoint 狀態
2. cli-bridge tab UI：在 bridge row 加徽章「⏸ 未完成 turn（{age}s 前中斷）」
3. 點徽章 → 顯示 turn 詳情（userInput preview、iteration、tool count）
4. 操作：手動清除 checkpoint（debug 用）

**通過條件**：
- [ ] API 回傳所有 bridge checkpoint
- [ ] UI 顯示徽章
- [ ] 手動清除 work
- [ ] tsc 過

**依賴**：Sprint 4

---

## Sprint 6: 整合測試 + 文檔（2-3 hr）

**目標**：完整 e2e 測試 + 更新文檔。

**步驟**：
1. e2e 場景：
   - 場景 A：turn 跑一半 → 優雅重啟 → 接續成功
   - 場景 B：turn 跑一半 → 意外 crash（kill -9）→ inbound history 救急、user 訊息不掉
   - 場景 C：turn 跑一半 → 重啟 → 模型接續但**走偏了** → 使用者體感如何
2. 更新文檔：
   - `_AIDocs/modules/cli-bridge.md`：補 turn-state schema、resume flow、徽章 UI
   - `_AIDocs/_CHANGELOG.md`：方案 C 落地紀錄
   - 議題追蹤 `2026-04-27_優化_CLIBridge重啟接續任務.md`：status=closed、attach commit hash、搬已處理
3. 補一筆 _staging atom 記載「方案 A vs C 兩段救援鏈的決策」

**通過條件**：
- [ ] 三個 e2e 場景手動跑過
- [ ] 文檔更新
- [ ] 議題搬已處理

**依賴**：Sprint 5

---

## Sprint 依賴圖

```
Sprint 1 (✅完成) ─── Sprint 2 ─── Sprint 3 ─── Sprint 4 ─── Sprint 5 ─── Sprint 6
    救急 A          schema/API     寫 checkpoint  resume prompt  dashboard      e2e + docs
```

線性依賴，無平行支線。每 Sprint 結束「執驗上P」（執行 → 驗證 → 上 GIT → 產 prompt）。

---

## 風險與緩解

| 風險 | 緩解 |
|------|------|
| `bridge.ts` 是 Guardian 警告檔（same-file 多次） | 每 Sprint 動完跑 `/ultrareview` |
| Resume prompt 模型可能誤解 / 走偏 | Sprint 4 整合測試專門驗證；不行就降級到方案 A |
| Checkpoint atomic 寫入損毀 | Sprint 2 unit test 涵蓋；溢出時整檔捨棄不 partial 讀 |
| 與既有 `--resume <sessionId>` 機制衝突 | Sprint 4 明確區分：sessionId 恢復對話脈絡，checkpoint 補 turn 進度 |

---

## 預估時程（理想 path）

| Sprint | 預估 | 累計 |
|--------|------|------|
| 1 (已完成) | 2 hr | 2 hr |
| 2 | 4-6 hr | 6-8 hr |
| 3 | 4-6 hr | 10-14 hr |
| 4 | 6-8 hr | 16-22 hr |
| 5 | 3-4 hr | 19-26 hr |
| 6 | 2-3 hr | 21-29 hr |

合計約 1.5-2 工作日（單人連續），可分多 session 執行。
