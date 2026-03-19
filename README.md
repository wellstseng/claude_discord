# claude-discord-bridge

輕量 Discord Bot，直接透過 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 進行對話。

## 功能

- 串流回覆（即時顯示 Claude 輸出）
- Per-channel 設定（allow / requireMention）
- Persistent session（同頻道延續對話上下文）
- 多頻道並行（不同 channel 平行處理，同 channel 串行）
- DM 支援（直接私訊 bot）
- Typing indicator（回應中顯示打字狀態）
- Turn timeout（超時自動取消）
- Debounce（短時間內多則訊息自動合併）
- 2000 字自動分段 + code fence 跨段平衡

## 架構

```mermaid
graph TB
    subgraph Discord
        User([使用者])
        DGW[Discord Gateway]
    end

    subgraph claude-discord-bridge
        IDX[index.ts<br/>進入點]
        CFG[config.ts<br/>config.json 載入]
        LOG[logger.ts<br/>Log Level]
        DIS[discord.ts<br/>訊息過濾 + Debounce]
        SES[session.ts<br/>Session 快取 + 佇列]
        ACP[acp.ts<br/>CLI Spawn + 串流 Diff]
        REP[reply.ts<br/>分段回覆 + Typing]
    end

    subgraph Claude
        CLI[Claude Code CLI<br/>claude -p stream-json]
    end

    User -->|訊息| DGW
    DGW -->|messageCreate| DIS
    IDX --> CFG
    IDX --> LOG
    IDX --> DIS
    DIS -->|getChannelAccess| CFG
    DIS -->|createReplyHandler| REP
    DIS -->|enqueue| SES
    SES -->|runClaudeTurn| ACP
    ACP -->|spawn| CLI
    CLI -->|NDJSON 串流| ACP
    ACP -->|AcpEvent| SES
    SES -->|onEvent| REP
    REP -->|reply / send| DGW
    DGW -->|回覆| User
```

## 訊息處理流程

```mermaid
sequenceDiagram
    participant U as 使用者
    participant D as Discord
    participant Bot as discord.ts
    participant S as session.ts
    participant A as acp.ts
    participant C as Claude CLI
    participant R as reply.ts

    U->>D: 發送訊息（@Bot 你好）
    D->>Bot: messageCreate event

    Note over Bot: 過濾：bot? 頻道? mention?

    Bot->>Bot: debounce 500ms（合併多則）
    Bot->>R: createReplyHandler(message)
    R->>D: sendTyping()（顯示打字中）

    Bot->>S: enqueue(channelId, text, onEvent)
    Note over S: Promise chain 串行佇列<br/>AbortController + timeout

    S->>A: runClaudeTurn(sessionId, text)
    A->>C: spawn claude -p --output-format stream-json<br/>--resume <sessionId> "你好"

    loop NDJSON 串流
        C-->>A: {"type":"assistant","message":{"content":[{"text":"累積文字..."}]}}
        A-->>A: diff lastTextLength → 提取新增文字
        A-->>S: yield {type:"text_delta", text:"新增部分"}
        S-->>R: onEvent({type:"text_delta"})
        R-->>R: buffer 累積，>= 2000 字時切割
    end

    C-->>A: {"type":"result", ...}
    A-->>S: yield {type:"done"}
    S-->>R: onEvent({type:"done"})
    R->>D: message.reply(完整回覆) / channel.send(後續分段)
    D->>U: 顯示回覆
```

## Claude CLI 介接

本專案不使用 Claude API SDK，而是直接 spawn Claude Code CLI 子程序進行對話：

```mermaid
graph LR
    subgraph "acp.ts（Node.js 程序）"
        SP[spawn]
        BUF[NDJSON Buffer]
        DIFF[Diff Engine<br/>lastTextLength]
        Q[Event Queue]
        GEN[AsyncGenerator]
    end

    subgraph "Claude Code CLI（子程序）"
        CLI["claude -p<br/>--output-format stream-json<br/>--verbose<br/>--include-partial-messages<br/>--dangerously-skip-permissions<br/>--resume &lt;sessionId&gt;<br/>&quot;prompt&quot;"]
    end

    SP -->|"stdio: [ignore, pipe, pipe]"| CLI
    CLI -->|stdout NDJSON| BUF
    BUF -->|JSON.parse 每行| DIFF
    DIFF -->|"text_delta / tool_call / done"| Q
    Q -->|"yield AcpEvent"| GEN
```

### 串流 Diff 機制

Claude CLI 的 `--include-partial-messages` 回傳的是**累積文字**（不是 delta）：

```
事件 1: text = "你"           → delta = "你"     (length 0→1)
事件 2: text = "你好"          → delta = "好"     (length 1→2)
事件 3: text = "你好，我是"     → delta = "，我是"  (length 2→5)
```

`acp.ts` 追蹤 `lastTextLength`，每次用 `fullText.slice(lastTextLength)` 提取新增部分。

### Session 延續

```mermaid
sequenceDiagram
    participant S as session.ts
    participant A as acp.ts
    participant C as Claude CLI

    Note over S: 首次對話（無 sessionId）
    S->>A: runClaudeTurn(null, "你好")
    A->>C: claude -p ... "你好"
    C-->>A: {"type":"system","subtype":"init","session_id":"abc-123"}
    A-->>S: {type:"session_init", sessionId:"abc-123"}
    Note over S: 快取 sessionCache[channelId] = "abc-123"

    Note over S: 後續對話（有 sessionId）
    S->>A: runClaudeTurn("abc-123", "繼續")
    A->>C: claude -p --resume abc-123 ... "繼續"
    Note over C: 延續上次對話上下文
```

## 前置需求

- Node.js >= 18
- [pnpm](https://pnpm.io/)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（需在 PATH 中可用）
- Discord Bot Token（從 [Discord Developer Portal](https://discord.com/developers/applications) 取得）

## 安裝

```bash
git clone https://github.com/wellstseng/claude_discord.git
cd claude_discord
pnpm install
pnpm build
```

## 設定

複製範本並編輯：

```bash
cp config.example.json config.json
```

### config.json 結構

```json
{
  "token": "你的 Discord Bot Token",

  "showToolCalls": false,

  "dm": {
    "enabled": true
  },

  "guilds": {
    "<伺服器 ID>": {
      "channels": {
        "<頻道 ID>": {
          "allow": true,
          "requireMention": false
        },
        "<另一頻道 ID>": {
          "allow": true,
          "requireMention": true
        }
      }
    }
  },

  "claudeCwd": "",
  "claudeCommand": "claude",
  "debounceMs": 500,
  "turnTimeoutMs": 300000,
  "logLevel": "info"
}
```

### 設定說明

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `token` | Discord Bot Token（必填） | — |
| `showToolCalls` | 是否在 Discord 顯示工具呼叫訊息 | `true` |
| `dm.enabled` | 是否啟用 DM 回應 | `true` |
| `guilds` | Per-guild/channel 設定（空物件 = 所有頻道允許） | `{}` |
| `claudeCwd` | Claude CLI 的工作目錄 | `$HOME` |
| `claudeCommand` | Claude CLI 路徑 | `"claude"` |
| `debounceMs` | 同一人連續訊息的合併等待時間（ms） | `500` |
| `turnTimeoutMs` | Claude 回應超時（ms） | `300000` |
| `logLevel` | Log 層級：`debug` / `info` / `warn` / `error` / `silent` | `"info"` |

### Per-Channel 設定

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `allow` | 是否允許回應此頻道 | — |
| `requireMention` | 是否需要 @mention bot 才觸發 | `true` |

- `guilds` 為空物件 → 所有頻道皆允許，預設需要 mention
- `guilds` 有設定 → 只有明確 `allow: true` 的頻道會回應

## 啟動

```bash
pnpm start
```

開發模式（自動重新編譯）：

```bash
pnpm dev
# 另一終端
pnpm start
```

## 專案結構

```
claude_discord/
├── src/
│   ├── index.ts        進入點
│   ├── config.ts       config.json 載入 + per-channel helper
│   ├── logger.ts       Log level 控制
│   ├── discord.ts      Discord client + debounce + 訊息過濾
│   ├── session.ts      Session 快取 + per-channel 串行佇列
│   ├── acp.ts          Claude CLI spawn + 串流解析
│   └── reply.ts        Discord 回覆分段 + typing
├── config.example.json 設定範本
├── package.json
└── tsconfig.json
```

## License

MIT
