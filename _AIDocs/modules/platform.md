# modules/platform — 子系統初始化工廠

> 檔案：`src/core/platform.ts`
> 更新日期：2026-04-16

## 職責

一次性初始化所有平台子系統，提供 module-level singleton getter。
策略：`config.providers` 有設定 → 啟用新 agentLoop 路徑；否則保留舊 CLI 路徑。

## Agent 資料路徑

`initPlatform` 啟動時透過 `getBootAgentDataDir(catclawDir)` 取得啟動 agent 的資料目錄。
所有 per-agent 資料（memory、vectordb、workflow memoryDir）以此為根：

- 預設：`~/.catclaw/workspace/agents/{defaultAgent}/`（catclaw.json 的 `defaultAgent` 設定）
- `--agent` 模式：`~/.catclaw/workspace/agents/{agentId}/`

平台級設定（catclaw.json、accounts/、workspace/）留在 `~/.catclaw/` root。

## 初始化順序（13 步）

```
initPlatform(config, catclawDir, distDir, workspaceDir)
  │
  ├── 1.  AccountRegistry          — 帳號系統 + admin 自動建立
  ├── 2.  ToolRegistry             — 掃描 dist/tools/builtin/ 載入
  ├── 3.  PermissionGate           — 角色→工具 tier 過濾
  ├── 4.  SafetyGuard              — 安全攔截規則
  ├── 5.  ProviderRegistry         — V2（三層分離）或 V1（舊格式）
  ├── 6.  SessionManager           — per-channel 串行 + 磁碟持久化
  ├── 6.5 TaskStore 持久化          — initTaskPersistence(wsDir/data/tasks)
  ├── 7.  RegistrationManager      — 帳號註冊 + IdentityLinker
  ├── 8.  ProjectManager           — 專案隔離
  ├── 8.5 OllamaClient             — embedding 用（可選）
  ├── 9.  MemoryEngine             — 四層記憶（recall + extract + consolidate）
  ├── 9.5 RateLimiter              — 角色分級限速
  ├── 9.6 ContextEngine            — CE 策略（decay + compaction + overflow-hard-stop）
  ├── 9.65 SubagentRegistry        — 子 agent 管理
  ├── 9.66 CollabConflictDetector  — 多人衝突偵測
  ├── 9.7 Stores                   — ToolLogStore + InboundHistoryStore + SessionSnapshotStore + TraceStore
  ├── 9.8 Dashboard                — Web UI（可選）
  ├── 10.  Workflow Engine           — rut/oscillation/sync/wisdom + FileWatcher（step 11）
  ├── 10b. Failure Recall Cache     — 非同步預載 failure recall 快取
  ├── 11.  MCP Servers              — 外部 MCP 連線
  ├── 12.  Hook Registry            — 工具前後 hook
  └── 13.  Tool Summary Injection   — 延遲 2s 注入工具摘要至 prompt-assembler
```

## 子系統 Getter

| Getter | 回傳 | 可 null |
|--------|------|---------|
| `isPlatformReady()` | boolean | — |
| `getAccountRegistry()` | AccountRegistry | throws |
| `getPlatformToolRegistry()` | ToolRegistry | throws |
| `getPlatformPermissionGate()` | PermissionGate | throws |
| `getPlatformSafetyGuard()` | SafetyGuard | throws |
| `getPlatformProjectManager()` | ProjectManager | throws |
| `getPlatformSessionManager()` | SessionManager | throws |
| `getPlatformMemoryEngine()` | MemoryEngine | ✓ null |
| `getPlatformRateLimiter()` | RateLimiter | ✓ null |
| `getPlatformMemoryRoot()` | string | ✓ null |

## 身份解析

```typescript
resolveDiscordIdentity(discordUserId, adminUserIds)
  → { accountId, isGuest }
```

策略：
1. AccountRegistry 有記錄 → 已知帳號
2. admin.allowedUserIds → platform-owner
3. 其餘 → `guest:{userId}`

```typescript
ensureGuestAccount(accountId)
```

Lazy 建立 guest 帳號到 registry（首次存取時）。

## Provider 選擇路徑

### V2（三層分離）
觸發條件：`config.agentDefaults?.model?.primary` 存在

```
ensureModelsJson(wsDir) → loadModelsJson()
  → initAuthProfileStore()
  → buildProviderRegistryV2(agentDefaults, modelsJson, authStore, routing)
```

### V1（舊格式相容）
觸發條件：V2 條件不滿足

```
buildProviderRegistry(providerId, providers, routing)
```

## 日誌清理

啟動時執行一次 + 每 24h 自動清理：
- ToolLogStore
- SessionSnapshotStore
- TraceStore + TraceContextStore

## Hook 整合

啟動時 `platform.initCore()` 呼叫 `initHookRegistry()` 並建立 `HookScanner`：

- 掃描 `{wsDir}/hooks/` → global hooks
- 掃描 `agents/{id}/hooks/` → per-agent hooks
- 啟動 `fs.watch` 熱重載（新增/刪除/修改 → 自動 re-scan + reload）

詳見 `modules/hooks.md`。
