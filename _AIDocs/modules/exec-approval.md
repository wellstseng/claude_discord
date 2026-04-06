# Exec Approval — 執行指令 DM 確認機制

> 對應原始碼：`src/core/exec-approval.ts`
> 更新日期：2026-04-06

## 概觀

Agent loop 偵測到 `run_command` 時，若指令不在白名單內，透過 Discord DM 向管理員發送確認請求。
支援兩種確認方式：Discord 按鈕（優先）和文字回覆（相容）。

## 流程

```
agent-loop → run_command detected
  → isCommandAllowed(cmd, patterns)?
    → YES: 自動允許
    → NO:  createApproval() → sendApprovalDm()
           → 等待使用者回應（按鈕 or 文字）
           → resolveApproval(id, approved)
           → Promise<boolean> resolve
```

## 核心函式

| 函式 | 說明 |
|------|------|
| `createApproval(cmd, channelId, timeoutMs)` | 建立 pending，回傳 `[approvalId, Promise<boolean>]` |
| `resolveApproval(id, approved)` | 解析確認結果，回傳是否找到 |
| `sendApprovalDm(opts)` | 送 DM（按鈕優先，fallback 文字） |
| `isCommandAllowed(cmd, patterns)` | 檢查白名單（substring match） |
| `parseApprovalReply(text)` | 解析文字 `✅ ABCDEF` / `❌ ABCDEF` |
| `parseApprovalButtonId(customId)` | 解析按鈕 `approval_allow_ABCDEF` / `approval_deny_ABCDEF` |
| `setApprovalDiscordClient(client)` | 設定 Discord client 引用 |
| `pendingCount()` | 目前等待中數量（debug） |

## 白名單規則

`isCommandAllowed()` 使用前綴匹配（非 substring）：
- `cmd === pattern`（完全一致）
- `cmd.startsWith(pattern + " ")`（前綴 + 空格）
- `cmd.startsWith(pattern + "\n")`（前綴 + 換行）

設定在 config 的 `allowedPatterns` 陣列。

## DM 訊息格式

按鈕版：
```
🔐 CatClaw 執行確認
頻道：#channel-name
指令：```command here```
（60s 後自動拒絕）
[✅ 允許] [❌ 拒絕]
```

## 超時行為

`timeoutMs` 到期後自動 `resolve(false)`（拒絕），並從 pending map 移除。
