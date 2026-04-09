# modules/safety — 安全攔截

> 檔案：`src/safety/guard.ts` + `src/safety/collab-conflict.ts`
> 更新日期：2026-04-05

## 職責

程式碼層安全攔截。在 Permission Gate 之後、Tool 執行之前攔截。

```
Permission Gate → Safety Guard → Tool 執行
```

## SafetyGuard（guard.ts）

### 攔截規則

| 規則 | 說明 |
|------|------|
| 路徑保護（write） | 禁止寫入敏感路徑（~/.catclaw/、~/.claude/、~/.ssh/ 等） |
| 路徑保護（read） | 禁止讀取敏感設定（catclaw.json、accounts/、_invites.json） |
| Auth profile 保護 | 禁止讀寫 auth-profile*.json、*-profiles.json |
| Bash 黑名單 | 危險指令���截（rm -rf /、chmod 777 等） |
| Credential 掃描 | 禁止讀取 .env、credentials、secret 等檔案 |
| Tool permission rules | per-tool 自訂白名單/黑名單規則 |

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
