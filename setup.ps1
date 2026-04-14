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

# UTF-8 without BOM 寫入（Windows PowerShell 5.x 的 -Encoding UTF8 會加 BOM）
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

# ═══════════════════════════════════════════════════════════════════
# Step 1: 前置需求檢查
# ═══════════════════════════════════════════════════════════════════
Step "Step 1/9: 前置需求檢查"

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
Step "Step 2/9: 安裝 Node.js 依賴"

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
Step "Step 3/9: 環境變數設定"

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
    $envContent = @"
# catclaw 啟動環境變數（由 setup.ps1 自動產生）

# catclaw.json 所在目錄
CATCLAW_CONFIG_DIR=$ConfigDir

# Agent 工作目錄
CATCLAW_WORKSPACE=$Workspace
"@
    Write-Utf8 $EnvFile $envContent
    Ok "已建立 .env（CONFIG_DIR=$ConfigDir）"
}

# ═══════════════════════════════════════════════════════════════════
# Step 4: 初始化目錄結構
# ═══════════════════════════════════════════════════════════════════
Step "Step 4/9: 初始化目錄結構"

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

# 複製 catclaw.json（若不存在）— 去掉 JSONC 註解寫入乾淨 JSON
$CatclawJson = Join-Path $ConfigDir "catclaw.json"
if (-not (Test-Path $CatclawJson)) {
    $examplePath = Join-Path $ProjectDir "catclaw.example.json"
    $raw = Get-Content $examplePath -Raw -Encoding UTF8
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    # 逐行去掉 // 註解（字串外）
    $lines = $raw -split "`n"
    $cleaned = @()
    foreach ($line in $lines) {
        $inStr = $false; $result = ""; $prev = ''
        for ($j = 0; $j -lt $line.Length; $j++) {
            $ch = $line[$j]
            if ($ch -eq '"' -and $prev -ne '\') { $inStr = -not $inStr }
            if (-not $inStr -and $ch -eq '/' -and $j+1 -lt $line.Length -and $line[$j+1] -eq '/') { break }
            $result += $ch
            $prev = $ch
        }
        $cleaned += $result
    }
    Write-Utf8 $CatclawJson ($cleaned -join "`n")
    Ok "已建立 catclaw.json（已去除註解）"
} else {
    Info "catclaw.json 已存在，跳過"
}

# 建立 CATCLAW.md（若不存在）— 從 template 複製
$CatclawMd = Join-Path $Workspace "CATCLAW.md"
if (-not (Test-Path $CatclawMd)) {
    Copy-Item (Join-Path $ProjectDir "templates\CATCLAW.md") $CatclawMd
    Ok "已建立 CATCLAW.md（from template）"
}

# 複製 cron-jobs.example.json（若不存在）
$CronJson = Join-Path $Workspace "data\cron-jobs.json"
if (-not (Test-Path $CronJson)) {
    $cronSrc = Join-Path $ProjectDir "cron-jobs.example.json"
    if (Test-Path $cronSrc) {
        Copy-Item $cronSrc $CronJson
    } else {
        Write-Utf8 $CronJson '{ "version": 1, "jobs": {} }'
    }
    Ok "已建立 cron-jobs.json"
}

Ok "目錄結構就緒"

# ═══════════════════════════════════════════════════════════════════
# Step 5: 互動設定 — Discord Bot Token
# ═══════════════════════════════════════════════════════════════════
Step "Step 5/9: Discord Bot Token 設定"

# 讀取 JSONC：去掉 // 和 /* */ 註解後 parse
function Read-Jsonc($path) {
    $raw = Get-Content $path -Raw -Encoding UTF8
    # 移除 BOM（若存在）
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    # 去掉 // 行註解（不在字串內的）
    $lines = $raw -split "`n"
    $cleaned = @()
    foreach ($line in $lines) {
        $inStr = $false; $result = ""
        $prev = ''
        for ($i = 0; $i -lt $line.Length; $i++) {
            $ch = $line[$i]
            if ($ch -eq '"' -and $prev -ne '\') { $inStr = -not $inStr }
            if (-not $inStr -and $ch -eq '/' -and $i+1 -lt $line.Length -and $line[$i+1] -eq '/') { break }
            $result += $ch
            $prev = $ch
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
        # 用 node 修改 JSON（避免 PowerShell ConvertTo-Json 造成巢狀重複）
        node -e "const fs=require('fs'),p=process.argv[1],t=process.argv[2];const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.discord.token=t;fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8')" $CatclawJson $BotToken
        Ok "Discord Token 已寫入"
    } else {
        Warn "稍後請手動編輯 $CatclawJson 填入 discord.token"
    }
}

# ═══════════════════════════════════════════════════════════════════
# Step 6: 預設 Discord 頻道
# ═══════════════════════════════════════════════════════════════════
Step "Step 6/9: Discord 預設頻道設定"

# 檢查是否已有 guilds
$ExistingGuilds = 0
try {
    $cfg2 = Read-Jsonc $CatclawJson
    $guildKeys = $cfg2.discord.guilds | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
    $ExistingGuilds = ($guildKeys | Measure-Object).Count
} catch {}

if ($ExistingGuilds -gt 0) {
    Info "已有 $ExistingGuilds 個 Guild 設定，跳過"
} else {
    Write-Host ""
    Write-Host "  預設 Discord 頻道" -ForegroundColor White
    Write-Host "  格式：serverId/channelId 或 serverId:channelId（多個以逗號分隔）"
    Write-Host "  範例：123456789/987654321,123456789/111222333"
    Write-Host ""
    Write-Host "  取得方式："
    Write-Host "    1. Discord 設定 -> 進階 -> 開啟「開發者模式」"
    Write-Host "    2. 右鍵點 Server -> 複製 Server ID（= serverId）"
    Write-Host "    3. 右鍵點頻道 -> 複製頻道 ID（= channelId）"
    Write-Host ""
    $ChannelsInput = Read-Host "  輸入頻道（留空稍後手動設定）"

    if ($ChannelsInput) {
        # 解析 serverId/channelId 或 serverId:channelId
        $guildsObj = @{}
        foreach ($pair in $ChannelsInput -split ',') {
            $pair = $pair.Trim()
            if ($pair -match '^(\d+)[:/](\d+)$') {
                $gid = $Matches[1]; $cid = $Matches[2]
                if (-not $guildsObj.ContainsKey($gid)) {
                    $guildsObj[$gid] = @{
                        allow = $true
                        requireMention = $true
                        allowBot = $false
                        channels = @{}
                    }
                }
                $guildsObj[$gid].channels[$cid] = @{
                    allow = $true
                    requireMention = $false
                }
            }
        }
        if ($guildsObj.Count -gt 0) {
            # 用 node 修改 JSON（避免 PowerShell ConvertTo-Json 巢狀重複問題）
            # 組裝 guild pairs 字串傳給 node
            $pairList = @()
            foreach ($gid in $guildsObj.Keys) {
                foreach ($cid in $guildsObj[$gid].channels.Keys) {
                    $pairList += "$gid/$cid"
                }
            }
            $pairsArg = $pairList -join ","
            node -e "
                const fs=require('fs'),p=process.argv[1],input=process.argv[2];
                const c=JSON.parse(fs.readFileSync(p,'utf-8'));
                const guilds={};
                for(const pair of input.split(',')){
                    const m=pair.trim().match(/^(\d+)[:/](\d+)$/);
                    if(!m)continue;
                    const[,gid,cid]=m;
                    if(!guilds[gid])guilds[gid]={allow:true,requireMention:true,allowBot:false,channels:{}};
                    guilds[gid].channels[cid]={allow:true,requireMention:false};
                }
                if(Object.keys(guilds).length>0){c.discord.guilds=guilds;fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8')}
            " $CatclawJson $pairsArg
            Ok "Discord 頻道已寫入"
        }
    } else {
        Warn "稍後請手動編輯 $CatclawJson 填入 discord.guilds"
    }
}

# ═══════════════════════════════════════════════════════════════════
# Step 7: LLM Provider API Key
# ═══════════════════════════════════════════════════════════════════
Step "Step 7/9: LLM Provider 設定"

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
        $authContent = @"
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
"@
        Write-Utf8 $AuthProfile $authContent
        Ok "auth-profile.json 已建立"
    } else {
        $authContent = @'
{
  "version": 2,
  "profiles": {},
  "order": {}
}
'@
        Write-Utf8 $AuthProfile $authContent
        Warn "未設定 API Key — 稍後請手動編輯 $AuthProfile"
        Write-Host "  或在 Dashboard 的 Auth Profiles 頁面新增"
    }
}

# ═══════════════════════════════════════════════════════════════════
# Step 8: 功能開關（Dashboard / 排程）
# ═══════════════════════════════════════════════════════════════════
Step "Step 8/9: 功能開關"

# ── Dashboard ────────────────────────────────────────────────────
Write-Host ""
$enableDash = Read-Host "  啟用 Dashboard（Web 管理介面，port 8088）？(Y/n)"
if ($enableDash -match '^[Nn]') {
    $dashEnabled = "false"
    Info "Dashboard 已停用"
} else {
    $dashEnabled = "true"
    Ok "Dashboard 已啟用（http://localhost:8088）"
}

# ── 排程（Cron）──────────────────────────────────────────────────
Write-Host ""
$enableCron = Read-Host "  啟用排程功能（Cron Jobs）？(y/N)"
if ($enableCron -match '^[Yy]') {
    $cronEnabled = "true"
    Ok "排程已啟用"
} else {
    $cronEnabled = "false"
    Info "排程已停用（稍後可在 catclaw.json 開啟）"
}

# 寫入設定（用 node 避免 ConvertTo-Json 巢狀問題）
node -e "const fs=require('fs'),p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.dashboard.enabled=(process.argv[2]==='true');c.cron.enabled=(process.argv[3]==='true');fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8')" $CatclawJson $dashEnabled $cronEnabled

# ═══════════════════════════════════════════════════════════════════
# Step 9: 編譯 & 啟動
# ═══════════════════════════════════════════════════════════════════
Step "Step 9/9: 編譯 & 啟動"

Push-Location $ProjectDir
$env:CATCLAW_CONFIG_DIR = $ConfigDir
$env:CATCLAW_WORKSPACE  = $Workspace

Info "編譯 TypeScript + 複製 prompt skills..."
pnpm build
if ($LASTEXITCODE -ne 0) { Fail "編譯失敗" }
Ok "編譯完成"

# 驗證 catclaw.json 可被正確解析
Info "驗證 catclaw.json 格式..."
try {
    $null = Read-Jsonc $CatclawJson
    Ok "catclaw.json 格式正確"
} catch {
    Warn "catclaw.json 解析失敗：$($_.Exception.Message)"
    Warn "請手動檢查 $CatclawJson 的 JSON 格式"
}

Write-Host ""
$startNow = Read-Host "  要立即啟動 CatClaw 嗎？(Y/n)"
if ($startNow -match '^[Nn]') {
    Info "跳過啟動。之後執行：catclaw start"
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
Write-Host "    catclaw start     啟動（PM2 背景執行）"
Write-Host "    catclaw stop      停止"
Write-Host "    catclaw restart   重啟"
Write-Host "    catclaw build     僅編譯"
Write-Host "    catclaw logs      查看日誌"
Write-Host "    catclaw status    查看狀態"
Write-Host ""
Write-Host "  Dashboard："
Write-Host "    http://localhost:8088"
Write-Host ""
Write-Host "  下一步："
Write-Host "    1. 在 Discord 頻道 @mention 你的 Bot 開始對話"
Write-Host "    2. 編輯 catclaw.json 設定 guilds 權限"
Write-Host "    3. 開啟 Dashboard 監控運作狀態"
Write-Host ""
