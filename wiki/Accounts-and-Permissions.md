# Accounts and Permissions

`src/accounts/` — 帳號、角色、身份綁定與權限閘門系統。

## 帳號模型

```typescript
interface Account {
  accountId: string           // 唯一 ID（e.g. "discord-owner-123"）
  displayName: string
  role: Role                  // 5 級角色
  identities: Identity[]      // 跨平台身份綁定
  projects: string[]
  preferences: AccountPreferences
  disabled?: boolean
  createdAt: string           // ISO 8601
  lastActiveAt: string
}

interface Identity {
  platform: string            // "discord" | "api" | ...
  platformId: string          // 平台端的使用者 ID
  linkedAt: string
}
```

## 5 級角色

| 角色 | 說明 | 可用 Tool Tier |
| ---- | ---- | -------------- |
| `platform-owner` | 平台擁有者 | public, standard, elevated, admin, owner |
| `admin` | 管理員 | public, standard, elevated, admin |
| `developer` | 開發者 | public, standard, elevated |
| `member` | 一般成員 | public, standard |
| `guest` | 訪客（自動建立） | public |

## 帳號儲存

`~/.catclaw/accounts/_registry.json`：

```json
{
  "accounts": {
    "accountId": {
      "role": "admin",
      "displayName": "Wells"
    }
  },
  "identityMap": {
    "discord:480042204346449920": "accountId"
  }
}
```

## Identity Linking

將不同平台的使用者 ID 綁定到同一 CatClaw 帳號：

- Discord userId → CatClaw accountId
- 防止重複綁定到不同帳號
- 首次出現的 Discord user 自動建立 guest 帳號

### 身份解析流程

```text
Discord userId 進入
  → IdentityMap 查詢 "discord:{userId}"
  → 找到 → 回傳對應 accountId
  → 找不到：
    → 是否在 admin.allowedUserIds → 建立 platform-owner
    → 否則 → 建立 guest 帳號
```

## Permission Gate

三層權限檢查，決定帳號可使用哪些 tool：

### 1. Deny Override

帳號級 + 角色級 deny list。被 deny 的 tool 無論如何不可使用。

### 2. Allow Override

帳號級 allow list，可突破角色預設（最高到 `ROLE_MAX_ALLOW_TIER`，不含 owner tier）。

### 3. Tier Check

依角色查表，決定該角色可用的 tier 集合（見上方角色表）。

### 結果

`listAvailable(accountId)` 回傳該帳號實際可用的 `ToolDefinition[]`，Agent Loop 只會把這些 tool 送給 LLM（物理移除不可用的 tool，而非靠 prompt 禁止）。

## 註冊模式

`accounts.registrationMode` 設定：

| 模式 | 說明 |
| ---- | ---- |
| `open` | 任何人可自助註冊 |
| `invite` | 需要邀請碼 |
| `closed` | 僅管理員可建立帳號 |

## Rate Limiter

角色級速率限制：

| 角色 | 限制 |
| ---- | ---- |
| guest | 5 次/分鐘 |
| member | 30 次/分鐘 |
| admin | 120 次/分鐘 |
