# BOOT.md — 每次啟動檢查清單

> 每次 CatClaw 啟動時，若本檔存在會被注入到 agent 的 system prompt。
> 放短、明確的啟動時指示。

## 預設啟動行為

- 檢查是否有 `BOOTSTRAP.md` → 若有，優先跑首次儀式
- 讀取 `CATCLAW.md`（全域）與 `agents/{bootAgent}/CATCLAW.md`（專屬）
- 檢查 `catclaw.json` 的 Discord / Dashboard / Cron 設定狀態

## 自訂區（依需求編輯）

<!-- 例：啟動時先跑健康檢查、提醒某件事、寄戰情摘要 -->
