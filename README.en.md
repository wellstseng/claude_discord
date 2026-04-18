# CatClaw

**English** | [繁體中文](README.md)

Discord-based AI Agent platform with full development capabilities — multi-turn agent loop, 25 builtin tools, 34 builtin skills, 36-event hook system, multi-provider failover, four-layer memory engine, and web dashboard.

## Features

| Category | Capabilities |
|----------|-------------|
| **Agent Loop** | Multi-turn reasoning loop, tool execution, output token recovery, auto-compact |
| **Tools** | 25 builtin tools — file read/write/edit, glob, grep, bash exec, web fetch/search, memory, subagent, task management, skill execution, hook management, filewatch |
| **Skills** | 34 builtin skills (31 command-type + 3 prompt-type) — config, session, account, status, restart, plan, remind, hook, and more |
| **Hook System** | 36 events (10 categories: Lifecycle / Turn / Memory / Subagent / Context / CLI Bridge / File+Command / File Watcher / Error / Platform) + folder-convention mount + fs.watch hot-reload + TS/JS/sh/ps1 runtimes + defineHook SDK |
| **Multi-Provider** | claude-api / ollama / openai-compat / codex-oauth / acp-cli / cli-* + circuit-breaker failover |
| **Memory** | Four-layer engine (Global / Project / Account / Agent) — vector recall + keyword search + auto-extraction + consolidation |
| **Context Engine** | Decay (progressive decay + externalization) / Compaction (LLM structured summary) / Overflow Hard Stop — three strategies + anti-hallucination honest stubs + turn cap warning |
| **Accounts** | Registration, identity linking, 5-tier roles (guest/member/developer/admin/platform-owner), per-channel permission gate |
| **Subagent** | Sub-task dispatch + Discord thread bridge + tracking |
| **Scheduling** | cron / every / at — message, subagent, exec, claude-acp actions + `/cron` skill + agent isolation |
| **Discord** | Streaming reply, debounce, thread inheritance, attachment handling, crash recovery, bot circuit breaker |
| **Dashboard** | Web UI at port 8088 — REST API, message trace visualization, token usage, session management |

## Architecture

```
Discord Message
    |
    v
discord.ts ─── Message Filter + Debounce
    |
    v
message-pipeline.ts ─── Identity Resolve → Permission Gate → Memory Recall → Intent Detection → Prompt Assembly
    |
    v
agent-loop.ts ─── Multi-turn Reasoning Loop (LLM <-> Tool Execution)
    |                         |
    v                         v
providers/ ───────── tools/ + skills/
LLM Abstraction      25 Tools + 34 Skills + 36 Hook Events
+ Failover
    |
    v
reply-handler.ts ─── Streaming Chunked Reply → Discord
```

**Core Subsystems** initialized by `platform.ts`:

| Subsystem | Description |
|-----------|-------------|
| SessionManager | Per-channel serial queue + disk persistence + TTL |
| MemoryEngine | Four-layer memory: recall + extract + consolidate |
| ContextEngine | Context compression strategies |
| AccountRegistry | Accounts + roles + permissions |
| ProviderRegistry | LLM provider abstraction + failover + circuit breaker |
| ToolRegistry | Auto-load builtin tools from dist/ |
| SafetyGuard | Command interception + collab conflict detection |
| Dashboard | Web UI + REST API + trace visualization |
| WorkflowEngine | Rut/oscillation/fix-escalation/sync detection |
| SubagentRegistry | Sub-agent lifecycle management |

## Quick Start

### One-Click Install

**macOS / Linux：**
```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
bash setup.sh
```

**Windows (PowerShell)：**
```powershell
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The setup script handles everything:
1. Checks prerequisites (Node.js >= 18, pnpm, PM2)
2. Installs dependencies
3. Creates `.env` with default paths
4. Initializes directory structure (`~/.catclaw/`)
5. Admin account setup (enter Discord User ID, creates platform-owner account)
6. Prompts for Discord Bot Token (writes to `catclaw.json`)
7. Prompts for default Discord channels
8. Prompts for Anthropic API Key (creates `auth-profile.json`)
9. Feature toggles (Dashboard / Cron)
10. Compiles TypeScript and starts with PM2

### Manual Install

```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
pnpm install
cp .env.example .env        # Windows: copy .env.example .env
pnpm build
./catclaw init
```

Edit `~/.catclaw/catclaw.json` to set your Discord Bot Token, then:

```bash
./catclaw start
```

## Prerequisites

- **Node.js** >= 18
- **pnpm** (auto-installed by setup.sh if missing)
- **PM2** (auto-installed by setup.sh if missing)
- **Discord Bot Token** — from [Discord Developer Portal](https://discord.com/developers/applications)
- **LLM Provider** (at least one):
  - Anthropic API Key (`sk-ant-...`) — recommended
  - Ollama (local)
  - OpenAI-compatible endpoint

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create Application -> Bot -> Reset Token -> Copy
3. Enable **Privileged Gateway Intents**:
   - MESSAGE CONTENT INTENT (required)
   - SERVER MEMBERS INTENT (optional)
4. OAuth2 -> URL Generator -> `bot` scope -> Permissions:
   - Send Messages, Read Message History, Add Reactions
   - Manage Messages (optional, for editing streaming replies)
5. Use the generated URL to invite the bot to your server

## Configuration

### Directory Layout

```
~/.catclaw/                         Config root (CATCLAW_CONFIG_DIR)
  catclaw.json                      Main config (JSONC format)
  workspace/                        Agent workspace (CATCLAW_WORKSPACE)
    CATCLAW.md                      Bot behavior rules (system prompt)
    agents/
      default/
        auth-profile.json           LLM API credentials
        models.json                 Provider/Model definitions
        CATCLAW.md                  Agent-specific behavior rules (optional)
      {agentId}/
        BOOTSTRAP.md                First-boot ritual (optional)
        BOOT.md                     Per-boot execution (optional)
        config.json                 Agent config (provider/model/admin)
        memory/                     Agent-specific atom memory
        sessions/                   Agent-isolated sessions
        _vectordb/                  Agent-specific LanceDB
        skills/                     Agent-built skills
    data/
      sessions/                     Session persistence
      cron-jobs.json                Scheduled jobs
```

### catclaw.json

Main configuration file in JSONC format (supports `//` comments). Key sections:

```jsonc
{
  "discord": {
    "token": "your_discord_bot_token_here",
    "dm": { "enabled": true },
    "guilds": {
      "<Guild ID>": {
        "allow": true,
        "requireMention": true
      }
    }
  },
  "admin": {
    "allowedUserIds": ["<your Discord user ID>"]
  },
  "agentDefaults": {
    "model": {
      "primary": "sonnet",
      "fallbacks": ["anthropic/claude-opus-4-6"]
    }
  }
}
```

See `catclaw.example.json` for all available options.

### auth-profile.json

LLM provider credentials, located at `~/.catclaw/workspace/agents/default/auth-profile.json`:

```json
{
  "version": 2,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    }
  },
  "order": {
    "anthropic": ["anthropic:default"]
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json location |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Agent working directory |

## CLI Commands

```bash
./catclaw start                    # Compile + PM2 start
./catclaw stop                     # Stop
./catclaw restart                  # Recompile + restart
./catclaw build                    # Build only (no start)
./catclaw logs                     # Live logs
./catclaw status                   # Process status
./catclaw reset-session            # Clear all sessions
./catclaw reset-session <channel>  # Clear specific channel
```

> On Windows, use `catclaw` instead of `./catclaw` (auto-resolves to `catclaw.cmd`)

## Discord Usage

- **@mention** the bot in any allowed channel to start a conversation
- **DM** the bot directly (if `dm.enabled: true`)
- Use `/` prefix for skill commands (e.g., `/help`, `/status`, `/configure`)

### Common Skills

| Skill | Tier | Description |
|-------|------|-------------|
| `/help` | public | Show available commands |
| `/status` | standard | System status |
| `/session list` | standard | List active sessions |
| `/session clear` | standard | Clear current session |
| `/configure show` | admin | Show provider/model config |
| `/configure model <id>` | admin | Change model |
| `/cron` | standard | Schedule management (add/list/delete/enable/disable) |
| `/hook` | standard | Hook system management (list/events/remove) |
| `/restart` | admin | Restart the bot |
| `/add-bridge` | admin | Add CLI Bridge |

## Dashboard

Web dashboard available at `http://localhost:8088` (when enabled).

Features:
- Session list and message history
- Message trace visualization (7-stage pipeline)
- Token usage tracking
- Memory management
- Online config editor (incl. FileWatcher directory settings)
- CLI Bridge status
- Web Chat (cross-platform session sharing)

## Project Structure

```
src/
  core/           Agent Loop, Platform, Session, Dashboard, Context Engine,
                  Prompt Assembler, Reply Handler, Event Bus, Message Pipeline
  memory/         Four-layer memory engine (engine, recall, extract, consolidate)
  providers/      LLM Provider abstraction (claude-api, ollama, openai-compat, cli-*)
  tools/          Tool Registry + 25 builtin tools
  skills/         Skill Registry + 34 builtin skills (31 command-type + 3 prompt)
  hooks/          Hook system — 36 events + folder-convention + fs.watch + defineHook SDK + FileWatcher
  safety/         Safety interception (guard, collab-conflict)
  workflow/       Workflow engine (rut, oscillation, fix-escalation, sync)
  accounts/       Accounts + roles + permissions + identity linking
  mcp/            MCP client + Discord MCP server
  vector/         Embedding providers + LanceDB vector search
  cli-bridge/     CLI Bridge persistent process module
  discord/        Discord auxiliary modules
catclaw           CLI wrapper (Unix)
catclaw.cmd       CLI wrapper (Windows)
catclaw.js        CLI core logic
ecosystem.config.cjs  PM2 configuration
setup.sh          One-click install (macOS/Linux)
setup.ps1         One-click install (Windows PowerShell)
templates/
  CATCLAW.md      Global behavior rules template (copied to workspace on init)
```

## Documentation

- **[_AIDocs/WIKI.md](_AIDocs/WIKI.md)** — Complete system manual
- **[_AIDocs/02-CONFIG-REFERENCE.md](_AIDocs/02-CONFIG-REFERENCE.md)** — Full configuration reference
- **[_AIDocs/01-ARCHITECTURE.md](_AIDocs/01-ARCHITECTURE.md)** — Architecture deep dive
- **[_AIDocs/_INDEX.md](_AIDocs/_INDEX.md)** — Knowledge base index

## License

MIT
