# CatClaw migrate skill 踩坑記錄

- Scope: project
- Confidence: [固]
- Trigger: migrate, countMd, statSync, require, ESM, /migrate status, atom count, 0 個 atom
- Last-used: 2026-03-31
- Confirmations: 1
- Related: pitfalls-cli, architecture

## 知識

### Bug：countMd 永遠回傳 0（已修）

- [固] `migrate.ts` 的 `handleStatus()` 中，`countMd` 函式用了 `require("node:fs").statSync(full)`
- [固] catclaw 是 ESM 專案（`"type": "module"`），ESM 無 `require`，每次都拋 `ReferenceError`
- [固] 外層 `try/catch { /* skip */ }` 吞掉錯誤 → 計數永遠 0
- [固] 修法：import 加 `statSync`，改為直接呼叫 `statSync(full)`（已修，2026-03-31）

### 注意：skill trigger 為前綴精確匹配

- [固] `matchSkill` 做前綴匹配，typo（如 `/migreate`）不會命中 `/migrate`
- [固] 未命中 skill → 進入完整 agent loop → recall + embedding + LLM 全部跑一遍
- [固] catclaw-test 配置 `timeout: 600000`（10 分鐘），用 qwen3:14b，typo 誤觸 LLM 會卡很久

## 行動

- 遇到「/migrate status 顯示 0 個 atom」→ 已修，重新 build 即可
- 遇到 catclaw 卡住 Typing → 先確認 pm2 logs 最後一行是否是 Ollama call；是的話等或 `pm2 restart catclaw`
