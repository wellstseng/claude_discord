# 09 — 陷阱速查（25 項）

> 開發與維護時容易踩到的坑，全部從實際除錯經驗總結。

## 1. stdin 必須 "ignore"（Legacy — 僅 ACP CLI 路徑）

**現象**：spawn claude 後 stdout 完全無輸出，process 不結束。

**原因**：stdio stdin 設為 `"pipe"` 但未關閉，claude 等待 stdin 完成。

**解法**：`stdio: ["ignore", "pipe", "pipe"]`，prompt 透過 positional arg 傳入。

## 2. stream-json 必須搭配 --verbose（Legacy — 僅 ACP CLI 路徑）

**現象**：`claude -p --output-format stream-json` 直接報錯。

**解法**：加上 `--verbose` flag。

## 3. DM 必須加 Partials.Channel

**現象**：bot 在 DM 中收不到 `messageCreate` 事件。

**原因**：discord.js 對 DM channel 預設不快取，需要 `Partials.Channel` 才會觸發事件。

**解法**：`partials: [Partials.Channel]`

## 4. 環境變數載入機制（PM2 + ecosystem.config.cjs）

**現象**：啟動時缺少 `CATCLAW_CONFIG_DIR` 或 `CATCLAW_WORKSPACE` 錯誤。

**原因**：ecosystem.config.cjs 在啟動前手動解析 `.env` 檔案（不依賴 dotenv 模組），若缺少必需環境變數則啟動失敗。

**實現**：PM2 ecosystem.config.cjs 自行逐行解析 `.env`（`KEY=value` 格式，支援去引號），無需外部 dotenv 模組。

**解法**：確保 `.env` 包含 `CATCLAW_CONFIG_DIR` 和 `CATCLAW_WORKSPACE`。Discord token 改為在 `catclaw.json` 的 `discord.token` 欄位設定。

## 5. 頻道白名單設定（guildId vs channelId）

**現象**：訊息被白名單過濾，但以為已設定正確。

**原因**：`catclaw.json` 中混淆了伺服器 ID（Guild ID）和頻道 ID（Channel ID），或未正確設定 `discord.guilds[guildId].channels[channelId].allow: true`。

**結構**：兩層繼承——`guilds[guildId]` 為伺服器級預設，`channels[channelId]` 為頻道級覆寫，頻道設定優先。

**解法**：右鍵頻道 → 複製頻道 ID（非伺服器 ID），填入 `catclaw.json` 對應位置。需開啟 Discord 開發者模式。

## 6. TextBasedChannel 的 TS 型別陷阱

**現象**：`Property 'send' does not exist on type 'TextBasedChannel'`

**原因**：`TextBasedChannel` 聯集包含 `PartialGroupDMChannel`，該型別沒有 `send()` 方法。

**解法**：使用 `SendableChannels` 型別替代。

## 7. assistant event 是累積文字不是 delta（Legacy — 僅 ACP CLI 路徑）

**現象**：回覆內容重複（把累積文字當作 delta 直接使用）。

**原因**：`--include-partial-messages` 的 assistant event `text` 包含從頭到目前的完整文字。

**解法**：diff `lastTextLength`，`fullText.slice(lastTextLength)` 提取新增部分。

## 8. Discord 訊息 2000 字上限

**現象**：長回覆直接被 Discord API reject。

**解法**：buffer → `flush()` 在 2000 字時切割，跨 chunk 處理 code fence 平衡。

## 9. bot 訊息必須最先過濾

**現象**：bot 的回覆觸發自身的 debounce，累積到容量。

**解法**：`message.author.bot` 檢查必須在 debounce 之前。

## 10. Promise chain 錯誤不可向上傳播

**現象**：某個 turn 出錯後，同 channel 後續 turn 全部失敗。

**原因**：Promise chain 中某個 Promise reject 後，整條 chain 中斷。

**解法**：`.catch()` 攔截每個 turn 的錯誤，轉為 `error` event 回報，不讓 rejection 傳播。

## 11. `ready` 事件中頻道 cache 未填充

**現象**：`ready` 事件中用 `client.channels.cache.get(channelId)` 取得 `undefined`，重啟通知無法送出。

**原因**：`ready` 觸發時 discord.js 的 channel cache 可能尚未完全填充，只有 bot 曾互動過的頻道才會在 cache 中。

**解法**：改用 `client.channels.fetch(channelId)`，直接向 Discord API 查詢，不依賴 cache。

```typescript
// ✗ 不可靠
const ch = client.channels.cache.get(channelId);

// ✓ 正確
const ch = await client.channels.fetch(channelId);
```

## 12. `displayName` vs `username`

**現象**：prompt 顯示帳號名（英文 handle）而非使用者在伺服器設定的暱稱。

**原因**：`message.author.username` 是帳號名；`message.author.displayName` 才是伺服器暱稱。

**解法**：prompt 前綴使用 `firstMessage.author.displayName`（在 discord.ts debounce callback 中）。

## 13. fileMode + MEDIA token 並存時 buffer 未重建

**現象**：同時有 fileMode 和 MEDIA token 時，回覆文字重複或遺漏。

**原因**：切換 mode 時未清空並重建 buffer。

**解法**：切換 mode 時明確清空並重建 buffer。（2026-03-19 修正）

## 14. signal file 重啟後需傳 CATCLAW_CHANNEL_ID

**現象**：寫入 signal file 觸發重啟後，bot 無法在正確頻道回報重啟訊息。

**解法**：spawn 時透過 `CATCLAW_CHANNEL_ID` env var 傳入當前頻道 ID。（2026-03-20 修正）

## 15. cron-jobs.json selfWriting 防自觸發

**現象**：cron job 寫入 cron-jobs.json 更新 nextRunAtMs 後，fs.watch 偵測變更觸發 reload。

**解法**：`selfWriting` flag + 延遲重置，bot 自己寫入時跳過 watch callback。（2026-03-20 修正）

## 16. ACTIVE_TURNS_DIR 曾用 process.cwd() 而非 CATCLAW_WORKSPACE（已修正）

**現象**：crash recovery 掃描 active-turns/ 時找不到檔案（或掃到錯誤位置）。

**原因**：`session.ts` 中 `ACTIVE_TURNS_DIR` 的路徑基準曾是 `process.cwd()`，而 `SESSION_FILE`（sessions.json）的基準是 `resolveWorkspaceDir()`（CATCLAW_WORKSPACE），兩者位置不一致。

**已修正**：`ACTIVE_TURNS_DIR` 已改為 `join(resolveWorkspaceDir(), "data", "active-turns")`，與 `SESSION_FILE` 使用相同的 workspace 路徑基準。

## 17. config.json 殘留廢棄的 claude.cwd / claude.command 欄位

**現象**：編輯 config.json 時看到 `claude.cwd` / `claude.command` 欄位，以為仍然有效。

**原因**：重構（5173e98）後這兩個欄位已從 `RawConfig` 移除，程式碼完全忽略。但現有的 `config.json` 未同步清除，欄位依然存在。

**影響**：無功能影響。但若在 config.json 中修改 `claude.cwd`，**不會生效**。cwd 由 `CATCLAW_WORKSPACE` 環境變數控制。

**解法**：直接從 config.json 刪除 `claude.cwd` / `claude.command` 欄位即可（或繼續忽略，無實質影響）。

---

## 常見錯誤訊息對照表

| 錯誤訊息 / 現象 | 對應陷阱 | 快速解法 |
|----------------|---------|---------|
| stdout 無輸出，process hang | §1 | `stdio: ["ignore", "pipe", "pipe"]` |
| `stream-json` 格式報錯 | §2 | 加 `--verbose` flag |
| DM 收不到 messageCreate | §3 | 加 `partials: [Partials.Channel]` |
| .env 缺少 CATCLAW_CONFIG_DIR/WORKSPACE | §4 | 確保 .env 包含必需環境變數 |
| channels 白名單設好但訊息被過濾 | §5 | 確認是頻道 ID 而非伺服器 ID，設定在 catclaw.json |
| `Property 'send' does not exist` | §6 | 改用 `SendableChannels` |
| 回覆內容重複 | §7 | `slice(lastTextLength)` 取 delta |
| Discord API 400 reject | §8 | flush 切割 + 預留 8 字元 |
| bot 自身迴圈 | §9 | `author.bot` 最先檢查 |
| 某 turn 錯後同 channel 後續全壞 | §10 | 每 turn 加 `.catch()` |
| ready 後 channel.cache 為空 | §11 | 改用 `channels.fetch()` |
| prompt 顯示帳號名非暱稱 | §12 | 用 `displayName` |
| fileMode + MEDIA 回覆異常 | §13 | 切換 mode 時重建 buffer |
| 重啟後回報頻道不對 | §14 | 傳 `CATCLAW_CHANNEL_ID` env |
| cron 寫檔觸發自己 reload | §15 | `selfWriting` flag |
| crash recovery 掃不到 active-turns/ | §16（已修正） | 已統一使用 CATCLAW_WORKSPACE |
| 修改 claude.cwd 但不生效 | §17 | 改設 `CATCLAW_WORKSPACE` 環境變數 |
| cron exec job 在 Windows 失敗 ENOENT | §18 | Windows 用 `bash`（Git Bash），Unix 用 `sh` |
| catclaw.json trailing comma 導致 hot-reload 失敗 | §19 | JSONC strip 後仍需合法 JSON |
| cron exec 輸出亂碼（cp950） | §20 | 注入 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1` |
| cron exec 失敗時頻道無回報 | §21 | catch 區塊加 Discord 錯誤訊息發送 |
| HookEvent 新增後腳本不載入 | §22 | types/metadata-parser/tool description 三處同步 |
| Ollama embed/extract 看似 ok 但 0 萃取（12 天 silent） | §23 | model name 跟 `ollama list` 完整對齊 + verify? + health-monitor |
| 插話後 user 看不到回應 | §24 | soft-inject + framing「當作新請求對待，不要 end_turn」 |
| codex-oauth token 跟 Codex CLI 互踩失效 | §25 | 共用 `~/.codex/auth.json` + 支援 nested + JWT exp |

> §18-21 編號已依序排列（2026-04-06 修正）；§22 為 hook 系統 32 events 擴充後新增（2026-04-15）；§23-25 為 4-22~4-27 實戰陷阱補登

## 18. cron exec 在 Windows 失敗（spawn sh ENOENT → cmd 路徑不通）

**現象**：`execFile("sh")` 報 ENOENT；改 `exec()` 後走 cmd.exe，MSYS2 路徑 `/c/Projects/...` 不認。

**原因**：Windows PM2 環境 PATH 沒有 `sh`；`exec()` 預設走 cmd.exe，不支援 MSYS2 路徑和 bash 語法。

**解法**：偵測 `platform() === "win32"` 時用 `execFile("bash", ["-c", cmd])`（Git Bash），Unix 用 `execFile("sh", ["-c", cmd])`。確保 Git Bash 在 PATH 中。

## 19. catclaw.json trailing comma 導致 hot-reload 持續失敗

**現象**：PM2 error log 持續報 `Expected double-quoted property name in JSON at position N`，config 改了但不生效。

**原因**：catclaw.json 支援 JSONC（`//` 註解），但 strip 註解後仍需合法 JSON。guilds 物件最後一個 entry 後面的 trailing comma 在 `JSON.parse()` 時報錯。

**解法**：移除 trailing comma。注意 JSONC ≠ JSON5，只有 `//` 註解會被 strip，其他語法糖（trailing comma）不支援。

## 20. cron exec 輸出亂碼（Windows cp950）

**現象**：cron-jobs.json 的 lastError 出現 `�t�Χ䤣����w` 亂碼。

**原因**：Windows cmd/Python 預設輸出 cp950（繁體中文 BIG5），Node.js 以 UTF-8 解讀。

**解法**：exec 時注入環境變數 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`，強制 Python 子程序 UTF-8 輸出。搭配 bash 執行也確保 shell 層面 UTF-8。

## 21. cron exec 失敗時頻道無回報

**現象**：job 執行失敗只寫 log 和 store，使用者在 Discord 不知道出錯。

**原因**：`runJob` 的 catch 區塊只記錄 lastError，不送 Discord。

**解法**：catch 區塊加入 Discord 錯誤訊息發送（`⚠️ 排程 **{name}** 執行失敗：{message}`），只在有 channelId 且非 silent 時觸發，發送失敗不影響重試流程。

## 22. 新增 HookEvent 後 hook 腳本不被載入

**現象**：hook 腳本檔名格式正確（如 `FileChanged.xxx.ts`），`hook_list` 回傳 0。

**原因**：`metadata-parser.ts` 有 `VALID_EVENTS` 白名單，新 event 未加入 → scanner 跳過。

**解法**：新增 HookEvent 時**三處必須同步更新**：
1. `types.ts` — HookEvent union + Input interface
2. `metadata-parser.ts` — `VALID_EVENTS` Set
3. tool description — `hook_register` event 參數範例 + 相關 tool description

## 23. Embedding / Extraction 模型 name 對不上 → silent fail 12 天

**現象**：catclaw.json 設 `qwen3-embedding:8b` 但本機只裝 `qwen3-embedding:latest`；啟動時只印「初始化 provider」看似 ok，後續 graceful skip 一直靜默失敗，**12 天無人發現，memory-extractor 22 次 flush 無一次成功萃取**。

**原因**：早期實作把 Ollama API 失敗都當 graceful skip（log.warn + 回空陣列）；model 名 mismatch 在 catclaw 層完全看不到。

**解法（4-26 三層 fail-loud + 通報）**：
1. **L1 startup verify** — `OllamaClient.verifyModel/verifyAllModels()` 用 `POST /api/show` 驗 model 存在；`Embedding/ExtractionProvider` 介面新增 `verify?()`；`platform.ts` 在 `_ready=true` 之前呼叫 `runStartupHealthCheck()` 印紅綠燈摘要
2. **L2 health-monitor** — 新增 `core/health-monitor.ts`，門檻 degraded=2 / critical=5 連續失敗，emit `health:degraded`/`critical`/`recovered`，critical 1 小時節流
3. **L3 通報** — `GET /api/health` endpoint + Dashboard 「🩺 Component Health」面板（紅綠燈 + 表格 + startup details）+ `index.ts` 訂閱 health:* event 推 Discord errorNotifyChannel

**附加**：embedding 模型漂移時 dashboard 警示 banner 提示重建索引；`upsert` 自動處理 dim mismatch（drop + rebuild 該 namespace）。

## 24. 插話 hard-abort 造成 user prompt 與已組裝回覆雙雙丟失

**現象**：使用者在 turn 進行中插話，新訊息進來 → 舊 turn 直接 abort，**user 看不到任何回應**（既有的中間文字也丟了，新 prompt 也沒處理）。

**原因**：原邏輯偵測到新訊息就 abort 當前 turn，未保留 in-flight 的 user prompt 與 partial assistant content。

**解法（4-23 + 4-27 兩階段）**：
- **階段一（4-23）soft-inject**：當 turn 結束前注入 `[使用者新訊息（turn 進行中插入）]`，模型自行評估是否轉向；abort 路徑保留但**不丟 user prompt 與已生成內容**
- **階段二（4-27）framing 強化**：原本 `[使用者插話] {msg}` 模型常誤讀為「補充 context」而非「new instruction」，注入後仍直接 `end_turn`（trace 2aa73911 案例：使用者插話「HR 系統」後 Loop #8 stop=end_turn 提早收場）。改為 `[使用者新訊息（turn 進行中插入）] {msg}` + 明確指示「**當作 user 新請求對待，重新評估方向**，除非任務真正完成否則不要 end_turn」

**判斷準則**：插話 = 在當前 turn 還沒 end 之前進來的新訊息，**永遠當作新指令**而非追加說明。

## 25. codex-oauth 跟 Codex CLI 共用 `~/.codex/auth.json` 互踩 refresh

**現象**：catclaw 跟 Codex CLI 各自 refresh OAuth token，後 refresh 的會讓前者的 access token 失效；catclaw 也讀不到 Codex CLI 寫的 nested 格式。

**原因**：catclaw 早期版本自有 codex-oauth credential 檔，跟 Codex CLI 各寫各的 → 兩邊互相 invalidate。

**解法（4-23）**：
- catclaw 跟 Codex CLI 共用 `~/.codex/auth.json`（避免雙方 refresh 互踩）
- 支援 Codex CLI **nested auth.json 格式**（`tokens` 物件包 `id_token` / `access_token` / `refresh_token`）+ **JWT exp 解析**（不用 `expires_at` 欄位，直接從 JWT payload `exp` claim 推）
- cli-bridge codex approval decision enum 改用新 API + 繼承全域 `~/.codex` 設定
- `codex.sandboxPolicy.networkAccess` 型別應為 `boolean`（早期文件寫 string）
