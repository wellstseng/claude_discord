---
name: CatClaw CLI Bridge 構想
description: CatClaw 取代 --channels plugin:discord，自己橋接 Claude Code CLI 常駐 session 的架構討論
type: project
---

CatClaw 有意取代 `--channels plugin:discord@claude-plugins-official`，改由 CatClaw 自己控制與 Claude Code CLI 的通訊。

**Why:** 現在 acp-cli.ts 是單次 spawn（`claude -p`），沒有 session 延續。希望有常駐 session，CatClaw 掌控 Discord 路由、記憶注入、tool 權限。

**How to apply:** 未來規劃時，最佳方案為 stdin/stdout stream-json（`--input-format stream-json --output-format stream-json`）+ CatClaw 當 MCP server 提供擴充 tools。目前僅為構想，尚未進入開發。
