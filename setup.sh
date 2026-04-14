#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# CatClaw — One-Click Setup Script
# 用法：bash setup.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 顏色 ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✅${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠️${NC}  $*"; }
fail()  { echo -e "${RED}❌${NC} $*"; exit 1; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${CATCLAW_CONFIG_DIR:-$HOME/.catclaw}"
WORKSPACE="${CATCLAW_WORKSPACE:-$CONFIG_DIR/workspace}"

# ═══════════════════════════════════════════════════════════════════
# Step 1: 前置需求檢查
# ═══════════════════════════════════════════════════════════════════
step "Step 1/9: 前置需求檢查"

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js 未安裝。請先安裝 Node.js >= 18：https://nodejs.org/"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js 版本過低（v$NODE_VER），需要 >= 18"
fi
ok "Node.js $(node -v)"

# pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm 未安裝，正在安裝..."
  npm install -g pnpm
  ok "pnpm 已安裝"
else
  ok "pnpm $(pnpm -v)"
fi

# PM2
if ! command -v pm2 &>/dev/null && ! npx pm2 -v &>/dev/null 2>&1; then
  warn "PM2 未安裝，正在安裝..."
  npm install -g pm2
  ok "PM2 已安裝"
else
  ok "PM2 可用"
fi

# ═══════════════════════════════════════════════════════════════════
# Step 2: 安裝依賴
# ═══════════════════════════════════════════════════════════════════
step "Step 2/9: 安裝 Node.js 依賴"

cd "$PROJECT_DIR"
pnpm install
ok "依賴安裝完成"

# ═══════════════════════════════════════════════════════════════════
# Step 3: 建立 .env
# ═══════════════════════════════════════════════════════════════════
step "Step 3/9: 環境變數設定"

ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info ".env 已存在，跳過建立"
  # 讀取現有值
  source <(grep -E '^[A-Z_]+=' "$ENV_FILE" 2>/dev/null || true)
  CONFIG_DIR="${CATCLAW_CONFIG_DIR:-$CONFIG_DIR}"
  WORKSPACE="${CATCLAW_WORKSPACE:-$WORKSPACE}"
else
  cat > "$ENV_FILE" <<EOF
# catclaw 啟動環境變數（由 setup.sh 自動產生）

# catclaw.json 所在目錄
CATCLAW_CONFIG_DIR=$CONFIG_DIR

# Agent 工作目錄
CATCLAW_WORKSPACE=$WORKSPACE
EOF
  ok "已建立 .env（CONFIG_DIR=$CONFIG_DIR）"
fi

# ═══════════════════════════════════════════════════════════════════
# Step 4: 初始化目錄結構
# ═══════════════════════════════════════════════════════════════════
step "Step 4/9: 初始化目錄結構"

# 建立目錄
mkdir -p "$CONFIG_DIR" "$WORKSPACE/data/sessions" "$WORKSPACE/data/active-turns" "$WORKSPACE/agents/default" "$PROJECT_DIR/signal"

# 複製 catclaw.json（若不存在）
CATCLAW_JSON="$CONFIG_DIR/catclaw.json"
if [ ! -f "$CATCLAW_JSON" ]; then
  cp "$PROJECT_DIR/catclaw.example.json" "$CATCLAW_JSON"
  ok "已建立 catclaw.json"
else
  info "catclaw.json 已存在，跳過"
fi

# 建立 CATCLAW.md（若不存在）
CATCLAW_MD="$WORKSPACE/CATCLAW.md"
if [ ! -f "$CATCLAW_MD" ]; then
  cat > "$CATCLAW_MD" <<'MDEOF'
# CATCLAW.md — CatClaw Bot 行為規則

你是 CatClaw，一個整合 Discord 的 AI Agent 平台。

## 重啟機制

當使用者要求重啟 bot 時：
```bash
node catclaw.js restart
```
MDEOF
  ok "已建立 CATCLAW.md"
fi

# 複製 cron-jobs.example.json（若不存在）
CRON_JSON="$WORKSPACE/data/cron-jobs.json"
if [ ! -f "$CRON_JSON" ]; then
  cp "$PROJECT_DIR/cron-jobs.example.json" "$CRON_JSON" 2>/dev/null || echo '{ "version": 1, "jobs": {} }' > "$CRON_JSON"
  ok "已建立 cron-jobs.json"
fi

ok "目錄結構就緒"

# ═══════════════════════════════════════════════════════════════════
# Step 5: 互動設定 — Discord Bot Token
# ═══════════════════════════════════════════════════════════════════
step "Step 5/9: Discord Bot Token 設定"

# 讀取 JSONC，去掉註解
strip_jsonc() {
  python3 -c "
import re, sys
text = sys.stdin.read()
result = []
in_str = False
i = 0
while i < len(text):
    ch = text[i]
    if ch == '\\\\' and in_str:
        result.append(ch)
        i += 1
        if i < len(text): result.append(text[i])
        i += 1
        continue
    if ch == '\"':
        in_str = not in_str
    if not in_str and ch == '/' and i+1 < len(text) and text[i+1] == '/':
        while i < len(text) and text[i] != '\n': i += 1
        continue
    result.append(ch)
    i += 1
print(''.join(result))
" 2>/dev/null || cat  # fallback: 原樣輸出
}

# 檢查現有 token
CURRENT_TOKEN=$(cat "$CATCLAW_JSON" | strip_jsonc | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('discord',{}).get('token',''))" 2>/dev/null || echo "")

NEED_TOKEN=true
if [ -n "$CURRENT_TOKEN" ] && [ "$CURRENT_TOKEN" != "your_discord_bot_token_here" ]; then
  MASKED="${CURRENT_TOKEN:0:10}...${CURRENT_TOKEN: -4}"
  info "已有 Discord Token：$MASKED"
  echo -n "  要更換嗎？(y/N) "
  read -r CHANGE_TOKEN
  if [[ ! "$CHANGE_TOKEN" =~ ^[Yy] ]]; then
    info "保留現有 Token"
    NEED_TOKEN=false
  fi
fi

if [ "$NEED_TOKEN" = true ]; then
  echo ""
  echo -e "  ${BOLD}Discord Bot Token${NC}"
  echo "  從 https://discord.com/developers/applications 取得"
  echo "  1. 建立 Application → Bot → Reset Token → 複製"
  echo "  2. 開啟 Privileged Gateway Intents："
  echo "     - MESSAGE CONTENT INTENT"
  echo "     - SERVER MEMBERS INTENT（可選）"
  echo "  3. OAuth2 → URL Generator → bot scope → 權限："
  echo "     - Send Messages, Read Message History, Add Reactions"
  echo "     - Manage Messages（可選，用於編輯串流回覆）"
  echo ""
  echo -n "  貼上 Bot Token（留空稍後手動設定）: "
  read -r BOT_TOKEN

  if [ -n "$BOT_TOKEN" ]; then
    # 用 python3 更新 JSON（保留 JSONC 格式）
    python3 -c "
import re, sys
with open('$CATCLAW_JSON', 'r') as f:
    content = f.read()
# 替換 token 欄位值
content = re.sub(r'(\"token\"\s*:\s*)\"[^\"]*\"', r'\1\"$BOT_TOKEN\"', content, count=1)
with open('$CATCLAW_JSON', 'w') as f:
    f.write(content)
" 2>/dev/null && ok "Discord Token 已寫入" || warn "自動寫入失敗，請手動編輯 $CATCLAW_JSON"
  else
    warn "稍後請手動編輯 $CATCLAW_JSON 填入 discord.token"
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# Step 6: 預設 Discord 頻道
# ═══════════════════════════════════════════════════════════════════
step "Step 6/9: Discord 預設頻道設定"

# 檢查是否已有 guilds 設定
EXISTING_GUILDS=$(cat "$CATCLAW_JSON" | strip_jsonc | python3 -c "
import json, sys
d = json.load(sys.stdin)
guilds = d.get('discord', {}).get('guilds', {})
real = {k: v for k, v in guilds.items() if not k.startswith('//')}
print(len(real))
" 2>/dev/null || echo "0")

if [ "$EXISTING_GUILDS" -gt 0 ]; then
  info "已有 $EXISTING_GUILDS 個 Guild 設定，跳過"
else
  echo ""
  echo -e "  ${BOLD}預設 Discord 頻道${NC}"
  echo "  格式：guildId:channelId（多個以逗號分隔）"
  echo "  範例：123456789:987654321,123456789:111222333"
  echo ""
  echo "  取得方式："
  echo "    1. Discord 設定 → 進階 → 開啟「開發者模式」"
  echo "    2. 右鍵點 Server → 複製 Server ID（= guildId）"
  echo "    3. 右鍵點頻道 → 複製頻道 ID（= channelId）"
  echo ""
  echo -n "  輸入頻道（留空稍後手動設定）: "
  read -r CHANNELS_INPUT

  if [ -n "$CHANNELS_INPUT" ]; then
    python3 - "$CATCLAW_JSON" "$CHANNELS_INPUT" <<'PYEOF'
import re, json, sys

catclaw_json = sys.argv[1]
channels_input = sys.argv[2]

pairs = channels_input.split(',')
guilds = {}
for pair in pairs:
    pair = pair.strip()
    if ':' not in pair:
        continue
    gid, cid = pair.split(':', 1)
    gid, cid = gid.strip(), cid.strip()
    if not gid or not cid:
        continue
    if gid not in guilds:
        guilds[gid] = {
            "allow": True,
            "requireMention": True,
            "allowBot": False,
            "channels": {}
        }
    guilds[gid]["channels"][cid] = {
        "allow": True,
        "requireMention": False
    }

if not guilds:
    sys.exit(0)

with open(catclaw_json, 'r') as f:
    content = f.read()

guilds_json = json.dumps(guilds, indent=6, ensure_ascii=False)
pattern = r'("guilds"\s*:\s*)\{[^}]*(?:\{[^}]*\}[^}]*)*\}'
new_content = re.sub(pattern, r'\1' + guilds_json, content, count=1)
with open(catclaw_json, 'w') as f:
    f.write(new_content)
PYEOF
    if [ $? -eq 0 ]; then
      ok "Discord 頻道已寫入"
    else
      warn "自動寫入失敗，請手動編輯 $CATCLAW_JSON 的 discord.guilds"
    fi
  else
    warn "稍後請手動編輯 $CATCLAW_JSON 填入 discord.guilds"
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# Step 7: LLM Provider API Key
# ═══════════════════════════════════════════════════════════════════
step "Step 7/9: LLM Provider 設定"

AUTH_PROFILE="$WORKSPACE/agents/default/auth-profile.json"
if [ -f "$AUTH_PROFILE" ]; then
  info "auth-profile.json 已存在，跳過"
else
  echo ""
  echo -e "  ${BOLD}Anthropic API Key${NC}（Claude Sonnet/Opus/Haiku）"
  echo "  從 https://console.anthropic.com/ 取得"
  echo ""
  echo -n "  貼上 API Key（sk-ant-...）（留空跳過）: "
  read -r API_KEY

  if [ -n "$API_KEY" ]; then
    cat > "$AUTH_PROFILE" <<EOF
{
  "version": 2,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "$API_KEY"
    }
  },
  "order": {
    "anthropic": ["anthropic:default"]
  }
}
EOF
    ok "auth-profile.json 已建立"
  else
    # 建立空的 auth-profile
    cat > "$AUTH_PROFILE" <<'EOF'
{
  "version": 2,
  "profiles": {},
  "order": {}
}
EOF
    warn "未設定 API Key — 稍後請手動編輯 $AUTH_PROFILE"
    echo "  或在 Dashboard 的 Auth Profiles 頁面新增"
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# Step 8: 功能開關（Dashboard / 排程）
# ═══════════════════════════════════════════════════════════════════
step "Step 8/9: 功能開關"

# ── Dashboard ────────────────────────────────────────────────────
echo ""
echo -n "  啟用 Dashboard（Web 管理介面，port 8088）？(Y/n) "
read -r ENABLE_DASHBOARD
if [[ "$ENABLE_DASHBOARD" =~ ^[Nn] ]]; then
  DASH_ENABLED=false
  info "Dashboard 已停用"
else
  DASH_ENABLED=true
  ok "Dashboard 已啟用（http://localhost:8088）"
fi

# ── 排程（Cron）──────────────────────────────────────────────────
echo ""
echo -n "  啟用排程功能（Cron Jobs）？(y/N) "
read -r ENABLE_CRON
if [[ "$ENABLE_CRON" =~ ^[Yy] ]]; then
  CRON_ENABLED=true
  ok "排程已啟用"
else
  CRON_ENABLED=false
  info "排程已停用（稍後可在 catclaw.json 開啟）"
fi

# 寫入設定
python3 - "$CATCLAW_JSON" "$DASH_ENABLED" "$CRON_ENABLED" <<'PYEOF'
import re, sys

catclaw_json = sys.argv[1]
dash_enabled = sys.argv[2] == 'true'
cron_enabled = sys.argv[3] == 'true'

with open(catclaw_json, 'r') as f:
    content = f.read()

# 更新 dashboard.enabled
content = re.sub(
    r'("dashboard"\s*:\s*\{[^}]*"enabled"\s*:\s*)(true|false)',
    r'\1' + str(dash_enabled).lower(),
    content, count=1
)

# 更新 cron.enabled
content = re.sub(
    r'("cron"\s*:\s*\{[^}]*"enabled"\s*:\s*)(true|false)',
    r'\1' + str(cron_enabled).lower(),
    content, count=1
)

with open(catclaw_json, 'w') as f:
    f.write(content)
PYEOF

# ═══════════════════════════════════════════════════════════════════
# Step 9: 編譯 & 啟動
# ═══════════════════════════════════════════════════════════════════
step "Step 9/9: 編譯 & 啟動"

cd "$PROJECT_DIR"
export CATCLAW_CONFIG_DIR="$CONFIG_DIR"
export CATCLAW_WORKSPACE="$WORKSPACE"

info "編譯 TypeScript + 複製 prompt skills..."
pnpm build
ok "編譯完成"

echo ""
echo -n "  要立即啟動 CatClaw 嗎？(Y/n) "
read -r START_NOW
if [[ "$START_NOW" =~ ^[Nn] ]]; then
  info "跳過啟動。之後執行：./catclaw start"
else
  node catclaw.js start
fi

# ═══════════════════════════════════════════════════════════════════
# 完成
# ═══════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}══════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  CatClaw 安裝完成！${NC}"
echo -e "${BOLD}══════════════════════════════════════${NC}"
echo ""
echo "  設定檔位置："
echo "    catclaw.json      $CATCLAW_JSON"
echo "    auth-profile.json $AUTH_PROFILE"
echo "    .env              $ENV_FILE"
echo ""
echo "  常用指令："
echo "    ./catclaw start     啟動（PM2 背景執行）"
echo "    ./catclaw stop      停止"
echo "    ./catclaw restart   重啟"
echo "    ./catclaw build     僅編譯"
echo "    ./catclaw logs      查看日誌"
echo "    ./catclaw status    查看狀態"
echo ""
echo "  Dashboard："
echo "    http://localhost:8088"
echo ""
echo "  下一步："
echo "    1. 在 Discord 頻道 @mention 你的 Bot 開始對話"
echo "    2. 編輯 catclaw.json 設定 guilds 權限"
echo "    3. 開啟 Dashboard 監控運作狀態"
echo ""
