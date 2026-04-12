# modules/safety — 安全攔截

> 檔案：`src/safety/guard.ts` + `src/safety/collab-conflict.ts`
> 更新日期：2026-04-12

> 註：`PROTECTED_WRITE_PATHS_DEFAULT` / `PROTECTED_READ_PATHS_DEFAULT` 為 export 常數，供 dashboard 匯入顯示。

## 職責

程式碼層安全攔截。在 Permission Gate 之後、Tool 執行之前攔截。

```
Permission Gate → Safety Guard → Tool 執行
```

## SafetyGuard（guard.ts）

### 攔截規則（分級）

| 規則 | 分級 | 說明 |
|------|------|------|
| Bash 黑名單 | 硬擋 | fork bomb、eval、shell -c、pipe to shell |
| Credential 掃描 | 硬擋 | .env、credentials、secret、token、password 等 |
| Auth profile 保護 | 硬擋 | auth-profile*.json、*-profiles.json |
| Self Protect | 硬擋 | catclaw.json、accounts/ 核心設定 |
| 路徑保護（write） | 軟擋 | protectedWritePaths（~/.catclaw/tools/、~/.ssh/ 等） |
| Bash 路徑保護 | 軟擋 | bash 指令操作受保護路徑 |
| Agent 越界寫入 | 軟擋 | 非 admin agent 寫 agents/{self}/ 以外 |
| 路徑保護（read） | 硬擋 | catclaw.json、accounts/、_invites.json |
| Tool permission rules | 硬擋 | per-tool 自訂規則 |

**軟擋**（`needsApproval`）：exec-approval 啟用 → 送 DM 授權；未啟用 → 降級硬擋。

### 預設保護路徑

寫入保護：
- `~/.catclaw/catclaw.json`
- `~/.catclaw/accounts/`
- `~/.catclaw/tools/`
- `~/.catclaw/skills/`
- `~/.claude/`
- `~/.ssh/`
- `~/.gnupg/`

讀取保護：
- `~/.catclaw/catclaw.json`
- `~/.catclaw/accounts/`
- `~/.catclaw/_invites.json`

### API

```typescript
class SafetyGuard {
  check(toolName: string, params: Record<string, unknown>, ctx?: PermissionContext): GuardResult
}

interface GuardResult {
  blocked: boolean;
  needsApproval?: boolean;  // 軟擋：可透過 exec-approval 授權
  reason?: string;
}

/** 呼叫 check() 時傳入的身份上下文 */
interface PermissionContext {
  accountId?: string;
  role?: string;
  agentId?: string;          // Agent ID（非 admin 限寫 agents/{agentId}/）
  isAdmin?: boolean;         // 管理者 agent（不受路徑限制）
}
```

### check() 內部分流

| toolName | 檢查項目 |
|----------|---------|
| `run_command` | checkBash（黑名單/白名單）→ checkBashProtectedPaths |
| `read_file` | checkFilesystem(path, "read") |
| `write_file` / `edit_file` | checkFilesystem(path, "write") → checkAgentWritePath（非 admin agent 限定 agents/{self}/） |
| `glob` / `grep` | checkFilesystem(path, "read")（有 path 時） |
| 其他 | 不攔截 |

所有 tool 在上述檢查前，先跑 `checkToolPermissions()`（per-role / per-account 規則）。

### agent-loop 整合

```
runBeforeToolCall
  ├─ guard.blocked + needsApproval + execApproval 啟用 → 送 DM 授權
  ├─ guard.blocked + needsApproval + execApproval 未啟用 → 硬擋
  ├─ guard.blocked（硬擋）→ 直接拒絕
  └─ 通過 → 繼續到 exec-approval（run_command/write_file/edit_file）
```

`runBeforeToolCall` 傳入 `agentId` + `isAdmin`（來自 `AgentLoopOpts`），確保 agent 路徑限制生效。

### Boot Agent ID

主體（非 --agent 模式）啟動時 `setBootAgent("wendy", true)`，agentId 注入所有 agentLoop 呼叫。
空 agentId 的 `checkAgentWritePath` 顯式回傳 `blocked: false`（不受限）。

### 設定

```jsonc
"safety": {
  "filesystem": {
    "protectedPaths": ["~/.catclaw/"],
    "credentialPatterns": ["\\.env$"]
  },
  "bash": {
    "blacklist": ["rm -rf /"]
  },
  "toolPermissions": {
    "defaultAllow": true,
    "rules": [
      { "tool": "run_command", "effect": "deny", "subjectType": "role", "subject": "guest", "paramMatch": { "command": "/etc/" }, "reason": "guests 禁止操作 /etc/" }
    ]
  }
}
```

## CollabConflictDetector（collab-conflict.ts）

### 職責

多人同時編輯同一檔案時的衝突偵測。

### 機制

1. 訂閱 `file:modified` 事件
2. 在 windowMs（預設 5 分鐘）內記錄每個檔案的修改者
3. 同一檔案被不同 accountId 修改 → 發出警告

### 設定

```jsonc
"safety": {
  "collabConflict": {
    "enabled": true,
    "windowMs": 300000
  }
}
```

### 初始化

由 `platform.ts` 步驟 9.66 初始化。
`connectToEventBus(eventBus)` 訂閱 `file:modified` 事件。

## 全域單例

```typescript
initSafetyGuard(config, catclawDir): SafetyGuard
getSafetyGuard(): SafetyGuard
```
