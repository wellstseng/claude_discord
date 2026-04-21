# catclaw 設定參考

> 根據 `catclaw.example.json`、`src/core/config.ts` 整理，2026-04-18
>
> V2 三層分離架構：模型定義（agentDefaults/modelsConfig）、認證（auth-profile.json）、路由（providerRouting）各自獨立

---

## 目錄

- [catclaw.json 設定區塊總覽](#catclawjson-設定區塊總覽)
- [discord — Discord 連線與權限](#discord)
- [admin — 管理員](#admin)
- [全域設定（頂層欄位）](#全域設定頂層欄位)
- [agentDefaults — V2 Agent 預設模型](#agentdefaults)
- [modelsConfig — 自訂 Provider 模型目錄](#modelsconfig)
- [authConfig — 認證設定](#authconfig)
- [providerRouting — Provider 路由](#providerrouting)
- [providers — V1 舊格式（過渡期保留）](#providers)
- [session — Session 持久化](#session)
- [memory — 記憶系統](#memory)
- [memoryPipeline — 記憶管線後端](#memorypipeline)
- [ollama — 本地語意處理後端](#ollama)
- [contextEngineering — Context Engineering（CE）](#contextengineering)
- [inboundHistory — Inbound History](#inboundhistory)
- [agents — 多 Agent 設定](#agents)
- [defaultAgent — 預設 Agent](#defaultagent)
- [subagents — Subagent 設定](#subagents)
- [accounts — 帳號管理](#accounts)
- [rateLimit — 速率限制](#ratelimit)
- [dashboard — Token Usage Dashboard](#dashboard)
- [workflow — Workflow 設定](#workflow)
- [botCircuitBreaker — Bot 斷路器](#botcircuitbreaker)
- [safety — 安全設定](#safety)
- [promptAssembler — Prompt 組裝器](#promptassembler)
- [mcpServers — 外部 MCP Server](#mcpservers)
- [hooks — Hook 系統](#hooks)
- [fileWatcher — File Watcher](#filewatcher)
- [cron — 排程](#cron)
- [modes — 模式設定](#modes)
- [所有欄位預設值一覽](#所有欄位預設值一覽)
- [Per-channel 存取規則](#per-channel-存取規則)
- [Prompt Assembler 可用模組](#prompt-assembler-可用模組)
- [cron-jobs.json 完整範例](#cron-jobsjson-完整範例)
- [環境變數說明](#環境變數說明)

---

## catclaw.json 設定區塊總覽

格式：JSONC（支援 `//` 整行 + 行尾註解，string-aware 不誤刪 URL 中的 `//`）。
位置：`$CATCLAW_CONFIG_DIR/catclaw.json`（預設 `~/.catclaw/catclaw.json`，已 gitignore）。

字串值支援環境變數展開：`"${ENV_VAR_NAME}"` 格式會在載入時自動替換，找不到則報錯。

---

## discord

Discord 連線與權限設定。

```jsonc
"discord": {
  "token": "",                    // Discord Bot Token（必填）
  "dm": {
    "enabled": true               // 是否回應 DM 私訊，預設 true
                                   // bot 間 DM 永遠禁止（硬擋）
  },
  "guilds": {
    "<Guild ID>": {
      "allow": true,               // 是否允許回應（false = 整個 guild 靜默）
      "requireMention": true,      // 是否需要 @bot 觸發
      "allowBot": false,           // 是否處理其他 bot 訊息
      "allowFrom": [],             // 白名單 user/bot ID（空 = 不限制）
      "blockGroupMentions": true,  // 封鎖 @here/@everyone 群播觸發
      "channels": {
        "<頻道 ID>": {
          "allow": true,
          "requireMention": false,
          "autoThread": true,      // 每條訊息自動建 Thread（預設 false）
          "boundProject": "",      // 綁定專案 ID
          "provider": ""           // 頻道層級 provider 覆寫
        }
      }
    }
  }
}
```

繼承鏈：`Thread → channels[threadId] → channels[parentId] → Guild 預設`

---

## admin

管理員設定。控制 slash commands（`/restart`、`/reset-session`、`/status`）權限。

```jsonc
"admin": {
  "allowedUserIds": []   // 允許執行管理指令的 Discord user ID
}
```

---

## 全域設定（頂層欄位）

直接放在 catclaw.json 頂層的設定。

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `turnTimeoutMs` | number | `300000` | 單次回應超時（毫秒），5 分鐘 |
| `turnTimeoutToolCallMs` | number | `turnTimeoutMs × 1.6` | tool_call 時延長超時（預設 480000） |
| `sessionTtlHours` | number | `168` | Session 閒置超時（小時），7 天 |
| `showToolCalls` | string | `"all"` | 工具呼叫顯示：`"all"` / `"summary"` / `"none"` |
| `showThinking` | boolean | `false` | 是否顯示推理過程（thinking block） |
| `streamingReply` | boolean | `true` | 串流即時編輯模式 |
| `debounceMs` | number | `500` | 同一人多則訊息合併延遲（毫秒） |
| `fileUploadThreshold` | number | `4000` | 回覆超過此字數改上傳 .md（0 = 停用） |
| `logLevel` | string | `"info"` | 日誌層級：`debug` / `info` / `warn` / `error` / `silent` |

---

## agentDefaults

V2 三層分離的 Agent 預設模型設定。格式：`"provider/model"`，如 `"anthropic/claude-sonnet-4-6"`。

```jsonc
"agentDefaults": {
  "model": {
    "primary": "sonnet",                            // 主要模型（alias 或 provider/model）
    "fallbacks": ["anthropic/claude-opus-4-6"]      // primary 不可用時依序嘗試
  },
  "models": {
    "anthropic/claude-sonnet-4-6":          { "alias": "sonnet" },
    "anthropic/claude-opus-4-6":            { "alias": "opus" },
    "anthropic/claude-haiku-4-5-20251001":  { "alias": "haiku" }
  }
}
```

> **與 models-config.json 的關係**：若存在 `$CATCLAW_CONFIG_DIR/models-config.json`，系統自動合成 `agentDefaults`、`modelsConfig`、`modelRouting`，catclaw.json 中的設定被覆蓋。V2 推薦直接在 catclaw.json 設定 `agentDefaults`，不再使用 models-config.json。

---

## modelsConfig

自訂 Provider 模型目錄（可選）。內建 provider（anthropic、openai、openai-codex）自動載入。

```jsonc
"modelsConfig": {
  "mode": "merge",                    // "merge"（內建+自訂合併，預設） | "replace"（只用自訂）
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "api": "ollama",                // API 類型：anthropic-messages / openai-completions / openai-codex-responses / ollama
      "models": [
        {
          "id": "qwen3:8b",
          "name": "Qwen3 8B",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 32768,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

---

## authConfig

認證設定（可選）。控制 credential 輪替順序和 cooldown。實際 credential 存放在 `{workspace}/agents/{agentId}/auth-profile.json`。

```jsonc
"authConfig": {
  "order": { "anthropic": ["anthropic:default", "anthropic:backup"] },
  "cooldowns": {
    "billingBackoffHours": 5,
    "billingMaxHours": 24,
    "failureWindowHours": 1
  }
}
```

### auth-profile.json 格式參考

```jsonc
{
  "version": 1,
  "profiles": {
    "anthropic:default": { "type": "api_key", "provider": "anthropic", "key": "sk-ant-..." },
    "openai:primary":    { "type": "api_key", "provider": "openai", "key": "sk-..." },
    "openai-codex:default": {
      "type": "oauth", "provider": "openai-codex",
      "access": "...", "refresh": "...", "expires": 1774019983859
    }
  },
  "order": { "anthropic": ["anthropic:default"] }
}
```

---

## providerRouting

Provider 路由規則。優先序：`channels > projects > roles > defaultProvider`。
值可以是 alias 或 `"provider/model"` 格式。

```jsonc
"providerRouting": {
  "roles": {
    "default": "sonnet"
  },
  "channels": {
    "<頻道 ID>": "anthropic/claude-opus-4-6"
  },
  "projects": {},
  "failoverChain": ["anthropic", "ollama"],
  "circuitBreaker": {
    "errorThreshold": 3,
    "windowMs": 60000,
    "cooldownMs": 60000
  }
}
```

> **modelRouting**（`ModelRoutingConfig`）：若存在 `modelRouting`，優先於 `providerRouting`。結構同但多了 `default` 和 `fallbacks`。優先序：`channels > projects > roles > default`。

---

## providers

V1 舊格式（過渡期保留）。若有 `agentDefaults` 則 V2 優先。

```jsonc
"providers": {
  "claude": {
    "type": "claude",           // claude / claude-oauth / openai / openai-compat / codex-oauth / ollama / cli-claude / cli-gemini / cli-codex
    "mode": "token",            // token / api / password
    "model": "claude-sonnet-4-6",
    "token": "${ANTHROPIC_TOKEN}"
  }
}
```

---

## session

Session 持久化設定。

```jsonc
"session": {
  "ttlHours": 168,                             // Session 閒置 TTL（小時），預設 7 天
  "maxHistoryTurns": 50,                       // 最大保留 turn 數，預設 50
  "compactAfterTurns": 30,                     // 超過此 turn 數觸發 CE 壓縮，預設 30
  "persistPath": "~/.catclaw/data/sessions-v2" // 持久化目錄
}
```

| 欄位 | 預設值（code） |
|------|---------------|
| `ttlHours` | `168` |
| `maxHistoryTurns` | `50` |
| `compactAfterTurns` | `30` |
| `persistPath` | `${CATCLAW_WORKSPACE}/data/sessions/` |

> **注意**：`catclaw.example.json` 中 `persistPath` 寫的是 `~/.catclaw/data/sessions-v2`，但 `config.ts` 預設值是 `${workspaceDir}/data/sessions/`。依實際部署調整。

---

## memory

記憶系統設定。

```jsonc
"memory": {
  "enabled": true,
  "root": "",                                 // 空字串 = 用 CATCLAW_WORKSPACE（由 platform.ts 動態設定）
  "vectorDbPath": "~/.catclaw/_vectordb",
  "contextBudget": 3000,                      // 注入 token 上限
  "contextBudgetRatio": { "global": 1, "project": 1, "account": 1 },
  "writeGate": { "enabled": true, "dedupThreshold": 0.8 },
  "recall": {
    "triggerMatch": true,
    "vectorSearch": true,
    "relatedEdgeSpreading": true,
    "vectorMinScore": 0.35,                   // 向量搜尋最低分數
    "vectorTopK": 10,
    "llmSelect": false,
    "llmSelectMax": 5
  },
  "extract": {
    "enabled": true,
    "perTurn": true,
    "onSessionEnd": true,
    "maxItemsPerTurn": 3,
    "maxItemsSessionEnd": 5,
    "minNewChars": 200
  },
  "consolidate": {
    "autoPromoteThreshold": 3,
    "suggestPromoteThreshold": 4,
    "decay": { "enabled": true, "halfLifeDays": 14, "archiveThreshold": 0.2 }
  },
  "episodic": { "enabled": true, "ttlDays": 24 },
  "rutDetection": { "enabled": true, "windowSize": 3, "minOccurrences": 2 },
  "oscillation": { "enabled": true },
  "sessionMemory": { "enabled": true, "intervalTurns": 10, "maxHistoryTurns": 15 }
}
```

### memory 預設值對照（config.ts `defaultMemoryConfig`）

| 欄位 | 預設值 |
|------|--------|
| `enabled` | `true` |
| `root` | `""` |
| `vectorDbPath` | `""` |
| `contextBudget` | `3000` |
| `contextBudgetRatio` | `{ global: 0.3, project: 0.4, account: 0.3 }` |
| `writeGate.dedupThreshold` | `0.80` |
| `recall.vectorMinScore` | `0.65` |
| `recall.vectorTopK` | `10` |
| `extract.maxItemsPerTurn` | `3` |
| `extract.maxItemsSessionEnd` | `5` |
| `extract.minNewChars` | `200` |
| `consolidate.autoPromoteThreshold` | `3` |
| `consolidate.decay.halfLifeDays` | `14` |
| `episodic.ttlDays` | `24` |
| `sessionMemory.intervalTurns` | `10` |

> **example vs code 差異**：example 中 `vectorMinScore` 寫 `0.35`、`contextBudgetRatio` 各為 `1`。config.ts 預設分別為 `0.65` 和 `{ 0.3, 0.4, 0.3 }`。以實際 catclaw.json 設定為準，未設定時 fallback 到 code 預設值。

---

## memoryPipeline

記憶管線設定（embedding / extraction / reranker 後端抽象層）。

```jsonc
"memoryPipeline": {
  "embedding": {
    "provider": "ollama",                // ollama / google / openai / voyage
    "model": "qwen3-embedding:8b",
    "host": "http://localhost:11434",    // ollama 專用
    "apiKey": "",                        // 雲端專用
    "dimensions": 0                      // 部分模型可指定降維
  },
  "extraction": {
    "provider": "ollama",                // ollama / anthropic / openai
    "model": "qwen3:14b",
    "host": "http://localhost:11434"
  },
  "reranker": {
    "provider": "none",                  // ollama / cohere / none
    "model": ""
  }
}
```

> 若未設定 `memoryPipeline` 但有設定 `ollama`，系統自動從 `ollama.primary` 推導。

---

## ollama

本地語意處理後端（記憶系統用）。與 `providers` 中的 ollama LLM 對話用途不同。

```jsonc
"ollama": {
  "enabled": false,
  "primary": {
    "host": "http://localhost:11434",
    "model": "qwen3:14b",
    "embeddingModel": "qwen3-embedding:8b"
  },
  "failover": false,               // primary 失敗時自動切換 fallback
  "thinkMode": false,               // 啟用 thinking 模式（qwen3 等）
  "numPredict": 512,                // 最大輸出 token
  "timeout": 60000                   // 逾時毫秒
}
```

| 欄位 | config.ts 預設值 |
|------|-----------------|
| `primary.host` | `"http://localhost:11434"` |
| `primary.model` | `"qwen3:8b"` |
| `failover` | `true` |
| `thinkMode` | `false` |
| `numPredict` | `8192` |
| `timeout` | `120000` |

---

## contextEngineering

Context Engineering（CE）設定。三段策略：decay → compaction → overflow-hard-stop，執行順序固定。

```jsonc
"contextEngineering": {
  "enabled": true,
  "turnCapWarning": 100,                    // Turn 數超過此值每 20 輪 warn（0 = 關閉）
  "toolBudget": {
    "resultTokenCap": 0,                    // 單一工具結果 token 上限（0 = 無限制）
    "perTurnTotalCap": 0,                   // 每 turn 所有工具結果合計上限（0 = 無限制）
    "toolTimeoutMs": 0,                     // 全域工具逾時（0 = 無限制）
    "maxWriteFileBytes": 512000             // write_file/edit_file 單次寫入上限 bytes（預設 500KB）
  },
  "strategies": {
    "decay": {
      "enabled": true,
      "mode": "auto",                       // discrete / continuous / time-aware / auto
      "baseDecay": 0.3,                     // 指數衰減係數
      "referenceIntervalSec": 60,
      "tempoRange": [0.5, 2.0],
      "externalize": {
        "enabled": true,
        "triggerLevel": 2,                  // L1→L2 時外部化
        "minTokens": 300,                   // 最小 token 閾值
        "ttlDays": 14,                      // 外部檔案保留天數
        "storePath": "data/externalized"    // 儲存路徑
      }
    },
    "dedup": {
      "enabled": true,                      // 重複內容偵測
      "minRepeat": 2                        // 最小重複次數
    },
    "turnSummary": {
      "enabled": true,                      // 每輪摘要
      "model": "",                          // 摘要用模型
      "maxConcurrent": 1                    // 最大並行數
    },
    "compaction": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001", // 壓縮用輕量模型
      "triggerTurns": 0,                    // turn 數觸發
      "triggerTokens": 20000,               // token 超過此值觸發 LLM 摘要
      "preserveRecentTurns": 8              // 保留最近 N 輪不壓縮
    },
    "overflowHardStop": {
      "enabled": true,
      "hardLimitUtilization": 0.95,         // token > window × 0.95 時緊急截斷
      "contextWindowTokens": 0              // 手動指定 context window（0 = 自動偵測）
    }
  }
}
```

---

## inboundHistory

`requireMention` 未觸發時記錄旁觀訊息。

```jsonc
"inboundHistory": {
  "enabled": true,
  "fullWindowHours": 24,                    // 完整保留窗口
  "decayWindowHours": 168,                  // 衰減窗口
  "bucketBTokenCap": 600,                   // Bucket B token 上限
  "decayIITokenCap": 300,                   // Decay II token 上限
  "inject": { "enabled": false }            // 預設關閉
}
```

---

## agents

多 Agent 設定。每個 agent 繼承全域設定，可覆寫 provider / systemPrompt。

```jsonc
"agents": {
  "default": {
    "provider": "claude-oauth",
    "systemPrompt": "你是 catclaw，一個整合 Discord 的 AI 助手。"
  }
}
```

Per-Agent 設定（`AgentConfig`，存放 `agents/{id}/config.json`）：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `label` | string | 顯示名稱 |
| `systemPrompt` | string | 專屬 system prompt |
| `model` | string | 模型覆寫 |
| `allowedTools` | string[] \| null | 允許的工具清單（null = 全部） |
| `maxTurns` | number | 最大 turn 數 |
| `timeoutMs` | number | 逾時毫秒 |
| `workspaceDir` | string | 工作目錄 |
| `skills` | string[] | 啟用的 skills |
| `memory.namespace` | string | 記憶命名空間 |
| `admin` | boolean | 管理者 flag（可改 catclaw.json） |
| `globalMemoryWrite` | boolean | 允許寫入全域記憶（預設 false） |

---

## defaultAgent

```jsonc
"defaultAgent": "default"   // providerRouting 未指定時使用此 agent
```

---

## subagents

Subagent 設定。

```jsonc
"subagents": {
  "maxConcurrent": 3,           // 同一 parent session 最多同時執行的子 agent
  "defaultTimeoutMs": 120000,   // 預設逾時毫秒（2 分鐘）
  "defaultKeepSession": false   // 完成後是否保留子 session
}
```

---

## accounts

帳號管理設定。

```jsonc
"accounts": {
  "registrationMode": "open",    // open / invite / closed（預設 invite）
  "defaultRole": "member",
  "pairingEnabled": true,
  "pairingExpireMinutes": 5      // config.ts 預設 30
}
```

---

## rateLimit

速率限制（per-role），每分鐘請求上限。

```jsonc
"rateLimit": {
  "guest":          { "requestsPerMinute": 5 },
  "member":         { "requestsPerMinute": 30 },
  "developer":      { "requestsPerMinute": 60 },
  "admin":          { "requestsPerMinute": 120 },
  "platform-owner": { "requestsPerMinute": 300 }
}
```

---

## dashboard

Token Usage Dashboard 設定。

```jsonc
"dashboard": {
  "enabled": true,
  "port": 8088,         // 預設 8088
  "token": ""           // 選填，Dashboard 認證 token
}
```

---

## workflow

Workflow 設定（Guardian / Fix Escalation / AIDocs）。

```jsonc
"workflow": {
  "guardian": { "enabled": false, "syncReminder": true, "fileTracking": true },
  "fixEscalation": { "enabled": false, "retryThreshold": 2 },
  "wisdomEngine": { "enabled": false },
  "aidocs": { "enabled": false, "contentGate": true }
}
```

> config.ts 預設（若 raw 有設定 workflow）：`fixEscalation.retryThreshold` = `2`。

---

## botCircuitBreaker

Bot-to-Bot 對話防呆（circuit breaker），Discord API 異常時自動斷路。

```jsonc
"botCircuitBreaker": {
  "enabled": true,            // 預設 true
  "maxRounds": 10,            // 連續 bot 互動最大來回輪數
  "maxDurationMs": 180000     // 最大持續時間 ms（3 分鐘）
}
```

---

## safety

安全設定。**`enabled` 和 `selfProtect` 不允許設為 `false`**，否則拒絕啟動。

```jsonc
"safety": {
  "enabled": true,
  "selfProtect": true,
  "bash": {
    "blacklist": ["rm\\s+(-rf?)\\s+[\\/~]"]     // shell 指令黑名單（正則）
  },
  "filesystem": {
    "protectedPaths": [],                        // 保護路徑
    "credentialPatterns": []                      // credential 檔案 pattern
  },
  "execApproval": {
    "enabled": false,
    "dmUserId": "",                              // 接收確認的 Discord User ID
    "timeoutMs": 60000,                          // 等待回覆超時
    "allowedPatterns": []                        // 白名單 pattern（substring match，自動允許）
  },
  "toolPermissions": {
    "rules": [],                                 // 細粒度工具權限規則
    "defaultAllow": false                        // 無規則匹配時預設行為
  },
  "collabConflict": {
    "enabled": true,                             // 協作衝突偵測
    "windowMs": 300000                           // 偵測窗口 5 分鐘
  },
  "reversibility": {
    "threshold": 2                               // 可逆性警告門檻 0-3
  }
}
```

### toolPermissions.rules 單條規則

| 欄位 | 型別 | 說明 |
|------|------|------|
| `subject` | string | 套用對象值（role 名稱或 accountId） |
| `subjectType` | `"role"` \| `"account"` | 對象類型 |
| `tool` | string | 工具名稱（支援 `*` 萬用符） |
| `effect` | `"allow"` \| `"deny"` | 允許或拒絕 |
| `paramMatch` | Record<string, string> | 參數條件（正則） |
| `reason` | string | deny 時的說明訊息 |

---

## promptAssembler

控制 system prompt 模組化組裝。

```jsonc
"promptAssembler": {
  "disabledModules": []    // 要停用的模組名稱
}
```

---

## mcpServers

外部 MCP Server 設定。每個 server 以 key 作為 serverName，tools 命名為 `mcp_{serverName}_{toolName}`。

```jsonc
"mcpServers": {
  "catclaw-discord": {
    "command": "node",
    "args": ["./dist/mcp/discord-server.js"],
    "env": { "DISCORD_TOKEN": "${DISCORD_TOKEN}" },
    "tier": "public"       // public / standard / elevated / admin / owner（預設 elevated）
  },
  "computer-use": {
    "command": "node",
    "args": ["./mcp/computer-use/dist/index.js"],
    "tier": "elevated"     // 螢幕截圖/鍵鼠操控，需 elevated 權限
  }
}
```

---

## hooks

Hook 系統：在 agent-loop 關鍵時機點執行外部 shell command。參考 Claude Code 的 PreToolUse / PostToolUse hooks 設計。

```jsonc
"hooks": [
  // HookDefinition 陣列，格式參見 src/hooks/types.ts
]
```

---

## fileWatcher

File Watcher 設定（監聽外部檔案變更）。

```jsonc
"fileWatcher": {
  "enabled": true,
  "watches": [
    {
      "label": "obsidian",                        // 識別名
      "path": "~/Documents/Obsidian",             // 監聽路徑（支援 ~ 展開）
      "ignoreDirs": [".obsidian", ".trash", ".git"],
      "ignorePatterns": ["*.sync-conflict*"],     // 忽略的 glob pattern
      "debounceMs": 1500,                         // Debounce 毫秒
      "recursive": true,                          // 遞迴監聽
      "cooldownMs": 10000                         // Per-path 冷卻期毫秒
    }
  ],
  "maxEventsPerWindow": 100,                      // 每視窗最多事件數
  "eventWindowMs": 60000                           // 速率限制視窗毫秒
}
```

---

## cron

排程設定。jobs 可寫在 `data/cron-jobs.json`，catclaw.json 中的 `jobs` 陣列優先。

```jsonc
"cron": {
  "enabled": false,              // 是否啟用排程，預設 false
  "maxConcurrentRuns": 1,        // 同時執行的 job 數量上限
  "defaultAccountId": "_cron",   // subagent 任務預設帳號
  "defaultProvider": "claude-oauth",
  "defaultAgentId": "wendy",     // job 未指定 agentId 時歸屬此 agent
  "jobs": [
    {
      "name": "daily-summary",
      "cron": "0 9 * * *",
      "action": {
        "type": "subagent",
        "task": "列出今天需要注意的事項並整理成摘要",
        "provider": "claude-oauth",
        "timeoutMs": 120000,
        "notify": "<Discord 頻道 ID>"
      }
    }
  ]
}
```

### CronAction 四種格式

| type | 必填欄位 | 選填欄位 | 說明 |
|------|---------|---------|------|
| `"message"` | `channelId`, `text` | — | 直接發送純文字訊息 |
| `"claude-acp"` | `channelId`, `prompt` | `timeoutSec` | 透過 ACP（CLI spawn）執行 turn |
| `"exec"` | `command` | `channelId`, `silent`, `timeoutSec`, `shell`, `background` | 執行 shell 指令 |
| `"subagent"` | `task` | `provider`, `timeoutMs`, `notify` | 透過 agentLoop 執行任務 |

---

## modes

模式設定（一般/精密/自訂）。

```jsonc
"modes": {
  "defaultMode": "normal",
  "presets": {
    "normal": {
      "thinking": null,                  // Extended Thinking 等級（null = 關閉）
      "systemPromptExtras": [],          // 額外 system prompt .md 檔名
      "resultTokenCap": 8000,            // 工具結果 token 上限覆寫
      "contextReserve": 0.2              // Output 預留空間比例（0-1）
    },
    "precision": {
      "thinking": "medium",              // minimal / low / medium / high / xhigh
      "systemPromptExtras": ["coding-discipline"],
      "resultTokenCap": 16000,
      "contextReserve": 0.3
    }
  }
}
```

---

## 所有欄位預設值一覽

以下為 config.ts 中 `loadConfig()` 和各 default 函式的實際預設值：

| 欄位 | 預設值 | 說明 |
|------|--------|------|
| `discord.dm.enabled` | `true` | DM 預設啟用 |
| `turnTimeoutMs` | `300000` | 5 分鐘 |
| `turnTimeoutToolCallMs` | `turnTimeoutMs × 1.6` | 預設 480000 |
| `sessionTtlHours` | `168` | 7 天 |
| `showToolCalls` | `"all"` | 完整顯示 |
| `showThinking` | `false` | |
| `streamingReply` | `true` | |
| `debounceMs` | `500` | |
| `fileUploadThreshold` | `4000` | |
| `logLevel` | `"info"` | |
| `session.ttlHours` | `168` | |
| `session.maxHistoryTurns` | `50` | |
| `session.compactAfterTurns` | `30` | |
| `session.persistPath` | `${CATCLAW_WORKSPACE}/data/sessions/` | |
| `memory.contextBudget` | `3000` | |
| `memory.contextBudgetRatio` | `{ 0.3, 0.4, 0.3 }` | global/project/account |
| `memory.recall.vectorMinScore` | `0.65` | |
| `memory.recall.vectorTopK` | `10` | |
| `memory.extract.maxItemsPerTurn` | `3` | |
| `memory.extract.minNewChars` | `200` | |
| `memory.episodic.ttlDays` | `24` | |
| `ollama.failover` | `true` | |
| `ollama.numPredict` | `8192` | |
| `ollama.timeout` | `120000` | |
| `accounts.registrationMode` | `"invite"` | |
| `accounts.pairingExpireMinutes` | `30` | |
| `dashboard.port` | `8088` | |
| `subagents.maxConcurrent` | `3` | |
| `subagents.defaultTimeoutMs` | `120000` | |
| `subagents.defaultKeepSession` | `false` | |
| `cron.enabled` | `false` | |
| `cron.maxConcurrentRuns` | `1` | |
| `workflow.fixEscalation.retryThreshold` | `2` | |
| guild `allow` | `false` | |
| guild `requireMention` | `true` | |
| guild `allowBot` | `false` | |
| guild `blockGroupMentions` | `true` | |
| channel `autoThread` | `false` | |
| `safety.collabConflict.enabled` | `true` | |
| `safety.collabConflict.windowMs` | `300000` | 5 分鐘 |
| `safety.reversibility.threshold` | `2` | 0-3 |
| `promptAssembler.disabledModules` | `[]` | |
| `toolBudget.maxWriteFileBytes` | `512000` | 500KB |

---

## Per-channel 存取規則

### 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

各欄位用 `??` 逐層 fallback，只有 `undefined` 才往下找（顯式設 `false` 不 fallback）。

### 情境一：DM 私訊

| 欄位 | 值 | 說明 |
|------|-----|------|
| `allowed` | `dm.enabled` | 由 config 控制 |
| `requireMention` | 永遠 `false` | DM 不需 mention |
| `allowBot` | 永遠 `false` | 硬擋 bot 互敲 |
| `allowFrom` | 不套用 | DM 已是點對點 |

### 情境二：Guild 未設定（guilds 為空物件 `{}`）

全部頻道允許（`allowed = true`），`requireMention = true`，`allowBot = false`，`blockGroupMentions = true`。

### 情境三：Guild 設定了但找不到 guildId

`allowed = false`（一律拒絕）。

### 情境四：Guild 找到，套用繼承鏈

```
allowed          = channels[channelId]?.allow          ?? channels[parentId]?.allow          ?? guild.allow          ?? false
requireMention   = channels[channelId]?.requireMention ?? channels[parentId]?.requireMention ?? guild.requireMention ?? true
allowBot         = channels[channelId]?.allowBot       ?? channels[parentId]?.allowBot       ?? guild.allowBot       ?? false
allowFrom        = channels[channelId]?.allowFrom      ?? channels[parentId]?.allowFrom      ?? guild.allowFrom      ?? []
blockGroupMentions = ...同上繼承鏈... ?? guild.blockGroupMentions ?? true
autoThread       = ...同上繼承鏈... ?? false
```

---

## Prompt Assembler 可用模組

| 模組名 | 優先序 | 載入方式 | 說明 |
|--------|--------|---------|------|
| `date-time` | 5 | 固定 | 當前時間（Asia/Taipei） |
| `identity` | 10 | 固定 | CatClaw 身份 + 多人場景說話者資訊 |
| `context-integrity` | 15 | 固定 | Anti-Hallucination 鐵則 + retry escalation 防線 |
| `catclaw-md` | 20 | 固定 | 載入 CATCLAW.md 階層（workspace → agent） |
| `tools-usage` | 25 | 固定 | 工具使用規則（read_file/edit_file 等） |
| `coding-rules` | 30 | 固定 | 行為約束 / 精密模式載入 coding-discipline.md |
| `git-rules` | 40 | 固定 | Git 安全協定 |
| `output-format` | 50 | 固定 | 輸出風格（精準、繁中、無廢話） |
| `discord-reply` | 55 | 條件 | Discord MCP 啟用時，強制回覆回 Discord |
| `tool-summary` | 56 | 動態 | 由 `setToolSummary()` 注入的 tool 使用摘要 |
| `skill-summary` | 57 | 動態 | 由 `setSkillSummary()` 注入的 skill 使用摘要 |
| `memory-rules` | 60 | 固定 | 記憶系統使用規則 |
| `failure-recall` | 70 | 條件 | 陷阱/失敗記憶注入（有 recall 結果時載入） |

---

## cron-jobs.json 完整範例

位置：`data/cron-jobs.json`（執行期資料，已 gitignore）。
格式：標準 JSON（不支援 JSONC 註解）。
Hot-reload：存檔後 500ms 內自動生效。

```json
{
  "version": 1,
  "jobs": {
    "morning-greeting": {
      "name": "早安問候",
      "enabled": true,
      "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Taipei" },
      "action": { "type": "message", "channelId": "...", "text": "早安！" }
    },
    "hourly-claude": {
      "name": "每小時 Claude 摘要",
      "enabled": false,
      "schedule": { "kind": "every", "everyMs": 3600000 },
      "action": { "type": "claude-acp", "channelId": "...", "prompt": "摘要最近進度" },
      "maxRetries": 3
    },
    "one-shot": {
      "name": "一次性提醒",
      "enabled": true,
      "schedule": { "kind": "at", "at": "2026-04-01T09:00:00+08:00" },
      "action": { "type": "message", "channelId": "...", "text": "提醒" },
      "deleteAfterRun": true
    }
  }
}
```

### CronSchedule 三種格式

| kind | 必填欄位 | 選填 | 說明 |
|------|---------|------|------|
| `"cron"` | `expr` | `tz` | 定期執行，標準 5-field cron |
| `"every"` | `everyMs` | — | 固定間隔 |
| `"at"` | `at`（ISO 8601） | — | 一次性 |

### CronJobEntry 欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `name` | string | — | 顯示名稱 |
| `enabled` | boolean | `true` | 未設定視為啟用 |
| `schedule` | CronSchedule | — | 排程設定 |
| `action` | CronAction | — | 執行動作 |
| `deleteAfterRun` | boolean | `false` | 執行後刪除 |
| `maxRetries` | number | `3` | 失敗重試上限 |

### exec action 欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `command` | string | — | shell 指令 |
| `channelId` | string | — | 可選，stdout 送 Discord |
| `silent` | boolean | `false` | 有 channelId 也不送訊息 |
| `timeoutSec` | number | `120` | 逾時秒數 |
| `shell` | string | 自動偵測 | bash/sh/cmd/powershell |
| `background` | boolean | — | false 時 Windows 不隱藏視窗 |

### 重試退避策略

| 重試次數 | 等待時間 |
|----------|---------|
| 第 1 次 | 30 秒 |
| 第 2 次 | 1 分鐘 |
| 第 3 次 | 5 分鐘 |
| 超出上限 | `kind="at"` 刪除；其他重算下次 |

---

## 環境變數說明

### 必填環境變數

| 變數名 | 預設值 | 說明 |
|--------|--------|------|
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json 所在目錄 |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Claude CLI agent 工作目錄 + data/ 存放位置 |

### 可選環境變數

| 變數名 | 預設值 | 說明 |
|--------|--------|------|
| `CATCLAW_CLAUDE_BIN` | `"claude"` | Claude CLI binary 路徑 |
| `ACP_TRACE` | — | 設為 `1` 開啟 ACP 串流除錯 log |
| `CATCLAW_CHANNEL_ID` | — | 由 acp.ts 自動注入，供重啟回報用 |
| `CATCLAW_PERMISSION_TIMEOUT_MS` | `600000`（10 分鐘）| CLI Bridge 權限請求按鈕超時（`control_request` 與 `discord-server.ts` MCP permission 共用） |

### ecosystem.config.cjs 中的預設值

```javascript
env: {
  CATCLAW_CONFIG_DIR: process.env.CATCLAW_CONFIG_DIR || `${require('os').homedir()}/.catclaw`,
  CATCLAW_WORKSPACE: process.env.CATCLAW_WORKSPACE || `${require('os').homedir()}/.catclaw/workspace`,
}
```

> 用 `require('os').homedir()` 取代 `process.env.HOME`，避免 PM2 環境中 HOME 未定義。
