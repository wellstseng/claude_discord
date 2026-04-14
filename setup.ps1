# ═══════════════════════════════════════════════════════════════════
# CatClaw — One-Click Setup Script (Windows PowerShell)
# 用法：powershell -ExecutionPolicy Bypass -File setup.ps1
# ═══════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

# ── 顏色輔助 ─────────────────────────────────────────────────────
function Info  ($msg) { Write-Host "  i  $msg" -ForegroundColor Cyan }
function Ok    ($msg) { Write-Host "  OK $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "  !! $msg" -ForegroundColor Yellow }
function Fail  ($msg) { Write-Host "  X  $msg" -ForegroundColor Red; exit 1 }
function Step  ($msg) { Write-Host "`n-- $msg --" -ForegroundColor White }

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ConfigDir  = if ($env:CATCLAW_CONFIG_DIR) { $env:CATCLAW_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".catclaw" }
$Workspace  = if ($env:CATCLAW_WORKSPACE)  { $env:CATCLAW_WORKSPACE }  else { Join-Path $ConfigDir "workspace" }

# ═══════════════════════════════════════════════════════════════════
# Step 1: 前置需求檢查
# ═══════════════════════════════════════════════════════════════════
Step "Step 1/7: 前置需求檢查"

# Node.js
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) { Fail "Node.js 未安裝。請先安裝 Node.js >= 18：https://nodejs.org/" }
$nodeVer = (node -v) -replace '^v','' -split '\.' | Select-Object -First 1
if ([int]$nodeVer -lt 18) { Fail "Node.js 版本過低（v$nodeVer），需要 >= 18" }
Ok "Node.js $(node -v)"

# pnpm
$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
    Warn "pnpm 未安裝，正在安裝..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) { Fail "pnpm 安裝失敗" }
    Ok "pnpm 已安裝"
} else {
    Ok "pnpm $(pnpm -v)"
}

# PM2
$pm2Path = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2Path) {
    Warn "PM2 未安裝，正在安裝..."
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) { Fail "PM2 安裝失敗" }
    Ok "PM2 已安裝"
} else {
    Ok "PM2 可用"
}

# ═══════════════════════════════════════════════════════════════════
# Step 2: 安裝依賴
# ═══════════════════════════════════════════════════════════════════
Step "Step 2/7: 安裝 Node.js 依賴"

Push-Location $ProjectDir
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install 失敗" }
    Ok "依賴安裝完成"
} finally {
    Pop-Location
}

# ═══════════════════════════════════════════════════════════════════
# Step 3: 建立 .env
# ═══════════════════════════════════════════════════════════════════
Step "Step 3/7: 環境變數設定"

$EnvFile = Join-Path $ProjectDir ".env"
if (Test-Path $EnvFile) {
    Info ".env 已存在，跳過建立"
    # 讀取現有值
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^([A-Z_]+)=(.*)$') {
            $key = $Matches[1]; $val = $Matches[2]
            if ($key -eq "CATCLAW_CONFIG_DIR") { $ConfigDir = $val }
            if ($key -eq "CATCLAW_WORKSPACE")  { $Workspace = $val }
        }
    }
} else {
    @"
# catclaw 啟動環境變數（由 setup.ps1 自動產生）

# catclaw.json 所在目錄
CATCLAW_CONFIG_DIR=$ConfigDir

# Agent 工作目錄
CATCLAW_WORKSPACE=$Workspace
"@ | Set-Content -Path $EnvFile -Encoding UTF8
    Ok "已建立 .env（CONFIG_DIR=$ConfigDir）"
}

# ═══════════════════════════════════════════════════════════════════
# Step 4: 初始化目錄結構
# ═══════════════════════════════════════════════════════════════════
Step "Step 4/7: 初始化目錄結構"

# 建立目錄
$dirs = @(
    $ConfigDir,
    (Join-Path $Workspace "data\sessions"),
    (Join-Path $Workspace "data\active-turns"),
    (Join-Path $Workspace "agents\default"),
    (Join-Path $ProjectDir "signal")
)
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# 複製 catclaw.json（若不存在）
$CatclawJson = Join-Path $ConfigDir "catclaw.json"
if (-not (Test-Path $CatclawJson)) {
    Copy-Item (Join-Path $ProjectDir "catclaw.example.json") $CatclawJson
    Ok "已建立 catclaw.json"
} else {
    Info "catclaw.json 已存在，跳過"
}

# 建立 CATCLAW.md（若不存在）
$CatclawMd = Join-Path $Workspace "CATCLAW.md"
if (-not (Test-Path $CatclawMd)) {
    $ticks = '```'
    @"
# CATCLAW.md — CatClaw Bot 行為規則

你是 CatClaw，一個整合 Discord 的 AI Agent 平台。

## 重啟機制

當使用者要求重啟 bot 時：
${ticks}bash
node catclaw.js restart
${ticks}
"@ | Set-Content -Path $CatclawMd -Encoding UTF8
    Ok "已建立 CATCLAW.md"
}

# 複製 cron-jobs.example.json（若不存在）
$CronJson = Join-Path $Workspace "data\cron-jobs.json"
if (-not (Test-Path $CronJson)) {
    $cronSrc = Join-Path $ProjectDir "cron-jobs.example.json"
    if (Test-Path $cronSrc) {
        Copy-Item $cronSrc $CronJson
    } else {
        '{ "version": 1, "jobs": {} }' | Set-Content -Path $CronJson -Encoding UTF8
    }
    Ok "已建立 cron-jobs.json"
}

Ok "目錄結構就緒"

# ═══════════════════════════════════════════════════════════════════
# Step 5: 互動設定 — Discord Bot Token
# ═══════════════════════════════════════════════════════════════════
Step "Step 5/7: Discord Bot Token 設定"

# 讀取 JSONC：去掉 // 註解後 parse
function Read-Jsonc($path) {
    $raw = Get-Content $path -Raw -Encoding UTF8
    # 去掉 // 行註解（不在字串內的）
    $lines = $raw -split "`n"
    $cleaned = @()
    foreach ($line in $lines) {
        # 簡易處理：若 // 出現在引號外，截斷
        $inStr = $false; $result = ""
        for ($i = 0; $i -lt $line.Length; $i++) {
            $ch = $line[$i]
            if ($ch -eq '"' -and ($i -eq 0 -or $line[$i-1] -ne '\')) { $inStr = -not $inStr }
            if (-not $inStr -and $ch -eq '/' -and $i+1 -lt $line.Length -and $line[$i+1] -eq '/') { break }
            $result += $ch
        }
        $cleaned += $result
    }
    return ($cleaned -join "`n") | ConvertFrom-Json
}

$NeedToken = $true
try {
    $cfg = Read-Jsonc $CatclawJson
    $currentToken = $cfg.discord.token
    if ($currentToken -and $currentToken -ne "your_discord_bot_token_here" -and $currentToken -ne "") {
        $masked = $currentToken.Substring(0, [Math]::Min(10, $currentToken.Length)) + "..." + $currentToken.Substring([Math]::Max(0, $currentToken.Length - 4))
        Info "已有 Discord Token：$masked"
        $change = Read-Host "  要更換嗎？(y/N)"
        if ($change -notmatch '^[Yy]') {
            Info "保留現有 Token"
            $NeedToken = $false
        }
    }
} catch {
    # parse 失敗，視為需要設定
}

if ($NeedToken) {
    Write-Host ""
    Write-Host "  Discord Bot Token" -ForegroundColor White
    Write-Host "  從 https://discord.com/developers/applications 取得"
    Write-Host "  1. 建立 Application -> Bot -> Reset Token -> 複製"
    Write-Host "  2. 開啟 Privileged Gateway Intents："
    Write-Host "     - MESSAGE CONTENT INTENT"
    Write-Host "     - SERVER MEMBERS INTENT（可選）"
    Write-Host "  3. OAuth2 -> URL Generator -> bot scope -> 權限："
    Write-Host "     - Send Messages, Read Message History, Add Reactions"
    Write-Host "     - Manage Messages（可選，用於編輯串流回覆）"
    Write-Host ""
    $BotToken = Read-Host "  貼上 Bot Token（留空稍後手動設定）"

    if ($BotToken) {
        # 讀取原始內容，用 regex 替換 token
        $content = Get-Content $CatclawJson -Raw -Encoding UTF8
        $content = $content -replace '("token"\s*:\s*)"[^"]*"', "`$1`"$BotToken`""
        Set-Content -Path $CatclawJson -Value $content -Encoding UTF8 -NoNewline
        Ok "Discord Token 已寫入"
    } else {
        Warn "稍後請手動編輯 $CatclawJson 填入 discord.token"
    }
}

# ═══════════════════════════════════════════════════════════════════
# Step 6: 互動設定 — LLM Provider API Key
# ═══════════════════════════════════════════════════════════════════
Step "Step 6/7: LLM Provider 設定"

$AuthProfile = Join-Path $Workspace "agents\default\auth-profile.json"
if (Test-Path $AuthProfile) {
    Info "auth-profile.json 已存在，跳過"
} else {
    Write-Host ""
    Write-Host "  Anthropic API Key（Claude Sonnet/Opus/Haiku）" -ForegroundColor White
    Write-Host "  從 https://console.anthropic.com/ 取得"
    Write-Host ""
    $ApiKey = Read-Host "  貼上 API Key（sk-ant-...）（留空跳過）"

    if ($ApiKey) {
        @"
{
  "version": 2,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "$ApiKey"
    }
  },
  "order": {
    "anthropic": ["anthropic:default"]
  }
}
"@ | Set-Content -Path $AuthProfile -Encoding UTF8
        Ok "auth-profile.json 已建立"
    } else {
        @'
{
  "version": 2,
  "profiles": {},
  "order": {}
}
'@ | Set-Content -Path $AuthProfile -Encoding UTF8
        Warn "未設定 API Key — 稍後請手動編輯 $AuthProfile"
        Write-Host "  或在 Dashboard 的 Auth Profiles 頁面新增"
    }
}

# ═══════════════════════════════════════════════════════════════════
# Step 7: 編譯 & 啟動
# ═══════════════════════════════════════════════════════════════════
Step "Step 7/7: 編譯 & 啟動"

Push-Location $ProjectDir
$env:CATCLAW_CONFIG_DIR = $ConfigDir
$env:CATCLAW_WORKSPACE  = $Workspace

Info "編譯 TypeScript + 複製 prompt skills..."
pnpm build
if ($LASTEXITCODE -ne 0) { Fail "編譯失敗" }
Ok "編譯完成"

Write-Host ""
$startNow = Read-Host "  要立即啟動 CatClaw 嗎？(Y/n)"
if ($startNow -match '^[Nn]') {
    Info "跳過啟動。之後執行：node catclaw.js start"
} else {
    node catclaw.js start
}
Pop-Location

# ═══════════════════════════════════════════════════════════════════
# 完成
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "======================================" -ForegroundColor White
Write-Host "  CatClaw 安裝完成！" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor White
Write-Host ""
Write-Host "  設定檔位置："
Write-Host "    catclaw.json      $CatclawJson"
Write-Host "    auth-profile.json $AuthProfile"
Write-Host "    .env              $EnvFile"
Write-Host ""
Write-Host "  常用指令："
Write-Host "    node catclaw.js start     啟動（PM2 背景執行）"
Write-Host "    node catclaw.js stop      停止"
Write-Host "    node catclaw.js restart   重啟"
Write-Host "    node catclaw.js logs      查看日誌"
Write-Host "    node catclaw.js status    查看狀態"
Write-Host ""
Write-Host "  Dashboard："
Write-Host "    http://localhost:8088"
Write-Host ""
Write-Host "  下一步："
Write-Host "    1. 在 Discord 頻道 @mention 你的 Bot 開始對話"
Write-Host "    2. 編輯 catclaw.json 設定 guilds 權限"
Write-Host "    3. 開啟 Dashboard 監控運作狀態"
Write-Host ""
