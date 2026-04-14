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

# ── Boot Agent ID ───────────────────────────────────────────────
# 啟動時預設使用哪個 agent（可之後用 --agent <id> 覆寫）
BOOT_AGENT_ID_DEFAULT="default"
if [ -n "${CATCLAW_BOOT_AGENT:-}" ]; then
  BOOT_AGENT_ID="$CATCLAW_BOOT_AGENT"
  info "Boot agent ID（從環境變數）：$BOOT_AGENT_ID"
else
  echo ""
  echo -n "  Boot agent ID（預設 $BOOT_AGENT_ID_DEFAULT，直接 Enter 沿用）: "
  read -r BOOT_AGENT_ID
  BOOT_AGENT_ID="${BOOT_AGENT_ID:-$BOOT_AGENT_ID_DEFAULT}"
fi

# 建立目錄
mkdir -p "$CONFIG_DIR" "$WORKSPACE/data/sessions" "$WORKSPACE/data/active-turns" "$WORKSPACE/agents/$BOOT_AGENT_ID" "$PROJECT_DIR/signal"

# 複製 catclaw.json（若不存在）— 去掉 JSONC 註解寫入乾淨 JSON
CATCLAW_JSON="$CONFIG_DIR/catclaw.json"
if [ ! -f "$CATCLAW_JSON" ]; then
  node -e "
    const fs=require('fs'),src=process.argv[1],dst=process.argv[2];
    let r='',s=false,i=0,t=fs.readFileSync(src,'utf-8');
    while(i<t.length){const c=t[i];
      if(c==='\\\\'&&s){r+=c+(t[i+1]||'');i+=2;continue}
      if(c==='\"'){s=!s;r+=c;i++;continue}
      if(!s&&c==='/'&&t[i+1]==='/'){while(i<t.length&&t[i]!=='\n')i++;if(i<t.length){r+='\n';i++}continue}
      r+=c;i++}
    fs.writeFileSync(dst,r);" "$PROJECT_DIR/catclaw.example.json" "$CATCLAW_JSON"
  ok "已建立 catclaw.json（已去除註解）"
else
  info "catclaw.json 已存在，跳過"
fi

# 建立 CATCLAW.md（若不存在）— 從 template 複製
CATCLAW_MD="$WORKSPACE/CATCLAW.md"
if [ ! -f "$CATCLAW_MD" ]; then
  cp "$PROJECT_DIR/templates/CATCLAW.md" "$CATCLAW_MD"
  ok "已建立 CATCLAW.md（from template）"
fi

# 建立 AGENTS.md（若不存在）
AGENTS_MD="$WORKSPACE/AGENTS.md"
if [ ! -f "$AGENTS_MD" ] && [ -f "$PROJECT_DIR/templates/AGENTS.md" ]; then
  cp "$PROJECT_DIR/templates/AGENTS.md" "$AGENTS_MD"
  ok "已建立 AGENTS.md（from template）"
fi

# 建立 BOOT.md（若不存在）
BOOT_MD="$WORKSPACE/BOOT.md"
if [ ! -f "$BOOT_MD" ] && [ -f "$PROJECT_DIR/templates/BOOT.md" ]; then
  cp "$PROJECT_DIR/templates/BOOT.md" "$BOOT_MD"
  ok "已建立 BOOT.md（from template）"
fi

# 建立 boot agent 的 CATCLAW.md 與 BOOTSTRAP.md（首次儀式）
BOOT_AGENT_DIR="$WORKSPACE/agents/$BOOT_AGENT_ID"
BOOT_AGENT_CATCLAW="$BOOT_AGENT_DIR/CATCLAW.md"
if [ ! -f "$BOOT_AGENT_CATCLAW" ] && [ -f "$PROJECT_DIR/templates/agents/default/CATCLAW.md" ]; then
  cp "$PROJECT_DIR/templates/agents/default/CATCLAW.md" "$BOOT_AGENT_CATCLAW"
  ok "已建立 agents/$BOOT_AGENT_ID/CATCLAW.md（from template）"
fi

BOOT_AGENT_BOOTSTRAP="$BOOT_AGENT_DIR/BOOTSTRAP.md"
if [ ! -f "$BOOT_AGENT_BOOTSTRAP" ] && [ -f "$PROJECT_DIR/templates/BOOTSTRAP.md" ]; then
  cp "$PROJECT_DIR/templates/BOOTSTRAP.md" "$BOOT_AGENT_BOOTSTRAP"
  ok "已建立 agents/$BOOT_AGENT_ID/BOOTSTRAP.md（首次儀式，完成後可自行刪除）"
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


# 檢查現有 token
CURRENT_TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'));console.log(c.discord?.token||'')" "$CATCLAW_JSON" 2>/dev/null || echo "")

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
    node -e "
      const fs=require('fs'),p=process.argv[1],t=process.argv[2];
      const c=JSON.parse(fs.readFileSync(p,'utf-8'));
      c.discord.token=t;
      fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8');
    " "$CATCLAW_JSON" "$BOT_TOKEN" && ok "Discord Token 已寫入" || warn "自動寫入失敗，請手動編輯 $CATCLAW_JSON"
  else
    warn "稍後請手動編輯 $CATCLAW_JSON 填入 discord.token"
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# Step 6: 預設 Discord 頻道
# ═══════════════════════════════════════════════════════════════════
step "Step 6/9: Discord 預設頻道設定"

# 檢查是否已有 guilds 設定
EXISTING_GUILDS=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'));console.log(Object.keys(c.discord?.guilds||{}).length)" "$CATCLAW_JSON" 2>/dev/null || echo "0")

if [ "$EXISTING_GUILDS" -gt 0 ]; then
  info "已有 $EXISTING_GUILDS 個 Guild 設定，跳過"
else
  echo ""
  echo -e "  ${BOLD}預設 Discord 頻道${NC}"
  echo "  格式：serverId/channelId 或 serverId:channelId（多個以逗號分隔）"
  echo "  範例：123456789/987654321,123456789/111222333"
  echo ""
  echo "  取得方式："
  echo "    1. Discord 設定 → 進階 → 開啟「開發者模式」"
  echo "    2. 右鍵點 Server → 複製 Server ID（= serverId）"
  echo "    3. 右鍵點頻道 → 複製頻道 ID（= channelId）"
  echo ""
  echo -n "  輸入頻道（留空稍後手動設定）: "
  read -r CHANNELS_INPUT

  if [ -n "$CHANNELS_INPUT" ]; then
    node -e "
      const fs=require('fs'), path=process.argv[1], input=process.argv[2];
      const cfg=JSON.parse(fs.readFileSync(path,'utf-8'));
      const guilds={};
      for(const p of input.split(',')){
        const m=p.trim().match(/^(\d+)[:/](\d+)$/);
        if(!m)continue;
        const[,gid,cid]=m;
        if(!guilds[gid])guilds[gid]={allow:true,requireMention:true,allowBot:false,channels:{}};
        guilds[gid].channels[cid]={allow:true,requireMention:false};
      }
      if(Object.keys(guilds).length>0){
        cfg.discord.guilds=guilds;
        fs.writeFileSync(path,JSON.stringify(cfg,null,2),'utf-8');
      }
    " "$CATCLAW_JSON" "$CHANNELS_INPUT"
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

AUTH_PROFILE="$WORKSPACE/agents/$BOOT_AGENT_ID/auth-profile.json"
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

# 寫入設定（parse → modify → write）
node -e "
  const fs=require('fs'),p=process.argv[1];
  const c=JSON.parse(fs.readFileSync(p,'utf-8'));
  c.dashboard.enabled=(process.argv[2]==='true');
  c.cron.enabled=(process.argv[3]==='true');
  fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8');
" "$CATCLAW_JSON" "$DASH_ENABLED" "$CRON_ENABLED"

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
