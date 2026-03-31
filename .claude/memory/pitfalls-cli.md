---
name: pitfalls-cli
description: catclaw 開發陷阱速查（26 項）+ Claude CLI 指令參考（stdio/stream-json/event 格式）
type: project
code-version: 2026-03-31
---

## 測試環境 vs 正式環境

| 環境 | config dir | branch |
|------|-----------|--------|
| 測試 | `~/.catclaw-test` | `platform-rebuild` |
| 正式 | `~/.catclaw` | `origin/main` 或其他 |

切 branch 時 catclaw.json 的 `memory.root`, `vectorDbPath`, `session.persistPath` 路徑都要跟著換。

## Claude CLI 指令格式

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --dangerously-skip-permissions \
  [--resume <session_id>] \
  "<prompt>"
```

stdio: `["ignore", "pipe", "pipe"]`

## stream-json Event 格式（NDJSON）

### system（init）
```json
{ "type": "system", "subtype": "init", "session_id": "abc-123-..." }
```

### assistant（累積文字，需 diff）
```json
{ "type": "assistant", "message": { "content": [
  { "type": "thinking", "thinking": "累積推理..." },
  { "type": "text", "text": "累積文字..." },
  { "type": "tool_use", "name": "Read", "id": "tu_xxx" }
] } }
```

### result（Turn 結束）
```json
{ "type": "result", "result": "最終文字", "is_error": false, "session_id": "..." }
```

其他：hook_started / hook_response / rate_limit_event → 靜默忽略

---

## 陷阱速查

### 1. stdin 必須 "ignore"
spawn claude 後無輸出 → stdin 設 pipe 未關閉 → 改 `["ignore", "pipe", "pipe"]`

### 2. stream-json 必須搭配 --verbose
否則 CLI 直接報錯

### 3. DM 必須加 Partials.Channel
DM 收不到 messageCreate → `partials: [Partials.Channel]`

### 4. dotenv 載入順序
`import "dotenv/config"` 必須在 `import { config }` 之前

### 5. Channel ID ≠ Guild ID
ALLOWED_CHANNEL_IDS 填的是頻道 ID

### 6. TextBasedChannel TS 陷阱
聯集包含 PartialGroupDMChannel 無 send() → 用 `SendableChannels`

### 7. assistant text 是累積非 delta
diff `lastTextLength` → `fullText.slice(lastTextLength)`

### 8. Discord 2000 字上限
buffer flush 在 2000 字切割 + code fence 平衡

### 9. bot 訊息最先過濾
`message.author.bot` 檢查必須在 debounce 之前

### 10. createDiscordClient 不可捕獲 config closure
handler 讀全域 config 支援 hot-reload

### 11. thinking 送出時不停 typing
flushThinking() 不呼叫 stopTyping()，typing 持續到正式 text

### 12. showToolCalls boolean 向下相容
`parseShowToolCalls()`: true→all, false→none

### 13. Promise chain 錯誤不可傳播
每 turn .catch() 攔截轉 error event

### 14. signal 檔需要 CATCLAW_CHANNEL_ID
signal/RESTART JSON 必須包含 channelId，否則重啟通知無法送達

### 15. cron-jobs.json selfWriting flag
cron 寫入狀態時設 selfWriting=true，防止 fs.watch 觸發自我重載迴圈

### 16. ACTIVE_TURNS_DIR 路徑一致性（已修正 2026-03-22）
必須用 `resolveWorkspaceDir()` 統一路徑，否則 cleanup 找不到殘留檔

### 17. config.json 遺留 claude.cwd / claude.command（2026-03-22 移除）
已改用環境變數 CATCLAW_CONFIG_DIR / CATCLAW_WORKSPACE / CATCLAW_CLAUDE_BIN

### 18. ch.send() 未回傳 Promise 給 .catch()（2026-03-25 修正）
`.then(ch => { ch.send(...); })` 中 send() 的 rejection 不會被外層 `.catch()` 捕獲
→ 造成 unhandledRejection → PM2 crash loop（Missing Access 403）
修正：`.then(async ch => { await ch.send(...); })`

### 19. Prompt-type SKILL.md 注入 vs Claude Code 內建 skill 混淆（2026-03-25）
CatClaw 內跑的 Claude CLI 本身也有 MCP plugin skill（discord:access/configure 等）
注入 builtin-prompt/discord/SKILL.md 後，Claude 可能把 OpenClaw skill 格式和自身 MCP tools 混答
→ Phase 0 只做注入，S4/S8 HTTP API 完成後才接實際執行；AGENTS.md 應說明哪些是真實可用能力

### 20. tsc 不複製非 .ts 檔案（2026-03-25）
builtin-prompt/**/*.SKILL.md 不會出現在 dist/，loadPromptSkills() 找不到
修正：package.json build script 加 `cp -r src/skills/builtin-prompt dist/skills/builtin-prompt`

### 21. Ollama think 參數必須顯式送出（2026-03-28）
`if (this.think) body["think"] = true` → qwen3 對複雜問題自動進入 thinking mode，content 空字串
修正：`body["think"] = this.think`（顯式送 false 阻止自動 thinking）

### 22. ecosystem.config.cjs 讀 process.env 時 .env 尚未載入（2026-03-28）
PM2 啟動時 `process.env.CATCLAW_CONFIG_DIR` 為 undefined → fallback `~/.catclaw`
另：.env 中的 `~` 不自動展開，需手動 `replace(/^~/, homedir())`
修正：在 ecosystem.config.cjs 開頭手動解析 .env + expandHome()

### 23. initOllamaClient() 未在 platform.ts 呼叫 → embedding 全部 skip（2026-03-31 修正）
`getOllamaClient()` 在 singleton 未初始化時 throw，embedTexts() catch 後 graceful fallback → 回傳空向量
LanceDB upsert 檢查到空向量就 `skip — embedding not available`，但 seedFromDir 仍計 seeded++ 不報錯
症狀：`/migrate seed` 顯示 N 個成功，但 vectorDB 實際為空（`du -sh _vectordb/` → 0B）
修正：`platform.ts` 步驟 8.5 加 `initOllamaClient(config.ollama)`（需 catclaw.json 有 ollama 設定）

### 24. platform.ts defaultMemoryCfg 的 recall.vectorSearch 預設 false（2026-03-31 修正）
catclaw.json 只設 globalPath/vectorDbPath 時，recall 區段不會被覆寫，vectorSearch 維持 false
症狀：seed 成功、embedding 有資料，但 recall 仍走 keyword-only
修正：catclaw.json 的 memory 段需明確加 `"recall": { "vectorSearch": true, ... }`

### 25. OllamaClient embed timeout 在單 GPU（4GB）環境 model swap 超時（2026-03-31 修正）
GTX 1050 Ti 4GB 同時只能載一個模型；qwen3:14b 在記憶體時，embed 需 unload → load qwen3-embedding:8b
60s 預設 timeout 不足，觸發 AbortController → `This operation was aborted` → embedding 失敗
症狀：`/migrate seed` 全部 skip，vectorDB 仍空；`/api/embed` 有回應但被 abort
修正：catclaw.json `ollama.timeout`: 300000（5 分鐘）；OllamaClient `embed()` 使用 `cfg.timeout` 作為預設

### 26. memory.root = atoms 根目錄，無 global/ 子目錄（2026-03-31 確認）
catclaw.json `memory.root` 指向記憶根目錄，atoms 直接放在 root 下（不是 root/global/）
引擎內 `globalDir()` = `memRoot()` = root 本身
子目錄結構：root/failures/, root/unity/, root/projects/, root/accounts/, root/episodic/, root/_vectordb/
錯誤：不要在 root 下多建 global/ 再把 atoms 放進去
