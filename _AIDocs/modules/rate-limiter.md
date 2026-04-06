# Rate Limiter — 請求速率限制器

> 對應原始碼：`src/core/rate-limiter.ts`
> 更新日期：2026-04-06

## 概觀

滑動視窗速率限制器（per-account），60s 固定視窗。每角色可設不同 RPM 上限。

## RateLimiter class

| 方法 | 說明 |
|------|------|
| `check(accountId, role)` | 檢查配額（不消費），回傳 `RateLimitResult` |
| `record(accountId)` | 記錄一次請求（消費配額） |
| `evict()` | 清除過期記錄（可由外部定期呼叫） |

### RateLimitResult

```ts
interface RateLimitResult {
  allowed: boolean;
  remaining: number;      // -1 = 無限制
  retryAfterMs: number;   // 距離視窗重置
}
```

## 設定

```json
{
  "rateLimit": {
    "admin":  { "requestsPerMinute": 120 },
    "member": { "requestsPerMinute": 30 },
    "guest":  { "requestsPerMinute": 5 }
  }
}
```

> 以上為 platform.ts 中的預設值。`requestsPerMinute <= 0` 或未設定 → 不限制。

## 全域單例

`initRateLimiter(limits)` / `getRateLimiter()` / `resetRateLimiter()`
