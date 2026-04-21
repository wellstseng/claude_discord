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
Step "Step 1/10: 前置需求檢查"

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
Step "Step 2/10: 安裝 Node.js 依賴"

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
Step "Step 3/10: 環境變數設定"

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
Step "Step 4/10: 初始化目錄結構"

# ── Boot Agent ID ───────────────────────────────────────────────
$BootAgentIdDefault = "default"
if ($env:CATCLAW_BOOT_AGENT) {
    $BootAgentId = $env:CATCLAW_BOOT_AGENT
    Info "Boot agent ID（從環境變數）：$BootAgentId"
} else {
    Write-Host ""
    $BootAgentId = Read-Host "  Boot agent ID（預設 $BootAgentIdDefault，直接 Enter 沿用）"
    if (-not $BootAgentId) { $BootAgentId = $BootAgentIdDefault }
}

# 建立目錄
$dirs = @(
    $ConfigDir,
    (Join-Path $Workspace "data\sessions"),
    (Join-Path $Workspace "data\active-turns"),
    (Join-Path $Workspace "agents\$BootAgentId"),
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

# 建立 AGENTS.md
$AgentsMd = Join-Path $Workspace "AGENTS.md"
$AgentsSrc = Join-Path $ProjectDir "templates\AGENTS.md"
if (-not (Test-Path $AgentsMd) -and (Test-Path $AgentsSrc)) {
    Copy-Item $AgentsSrc $AgentsMd
    Ok "已建立 AGENTS.md（from template）"
}

# 建立 BOOT.md
$BootMd = Join-Path $Workspace "BOOT.md"
$BootSrc = Join-Path $ProjectDir "templates\BOOT.md"
if (-not (Test-Path $BootMd) -and (Test-Path $BootSrc)) {
    Copy-Item $BootSrc $BootMd
    Ok "已建立 BOOT.md（from template）"
}

# 建立 boot agent 的 CATCLAW.md 與 BOOTSTRAP.md
$BootAgentDir = Join-Path $Workspace "agents\$BootAgentId"
$BootAgentCatclaw = Join-Path $BootAgentDir "CATCLAW.md"
$BootAgentCatclawSrc = Join-Path $ProjectDir "templates\agents\default\CATCLAW.md"
if (-not (Test-Path $BootAgentCatclaw) -and (Test-Path $BootAgentCatclawSrc)) {
    Copy-Item $BootAgentCatclawSrc $BootAgentCatclaw
    Ok "已建立 agents/$BootAgentId/CATCLAW.md（from template）"
}

$BootAgentBootstrap = Join-Path $BootAgentDir "BOOTSTRAP.md"
$BootstrapSrc = Join-Path $ProjectDir "templates\BOOTSTRAP.md"
if (-not (Test-Path $BootAgentBootstrap) -and (Test-Path $BootstrapSrc)) {
    Copy-Item $BootstrapSrc $BootAgentBootstrap
    Ok "已建立 agents/$BootAgentId/BOOTSTRAP.md（首次儀式，完成後可自行刪除）"
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

# 複製 models-config.json（若不存在）
$ModelsConfigJson = Join-Path $ConfigDir "models-config.json"
if (-not (Test-Path $ModelsConfigJson)) {
    $modelsConfigSrc = Join-Path $ProjectDir "models-config.example.json"
    if (Test-Path $modelsConfigSrc) {
        Copy-Item $modelsConfigSrc $ModelsConfigJson
    }
    Ok "已建立 models-config.json"
}

# 複製 models.json 至 boot agent 目錄（若不存在）
$AgentModelsJson = Join-Path $BootAgentDir "models.json"
if (-not (Test-Path $AgentModelsJson)) {
    $modelsSrc = Join-Path $ProjectDir "models.example.json"
    if (Test-Path $modelsSrc) {
        Copy-Item $modelsSrc $AgentModelsJson
    }
    Ok "已建立 agents/$BootAgentId/models.json"
}

Ok "目錄結構就緒"

# ═══════════════════════════════════════════════════════════════════
# Step 5: Admin 帳號設定
# ═══════════════════════════════════════════════════════════════════
Step "Step 5/10: Admin 帳號設定"

# 檢查是否已有 allowedUserIds
$ExistingAdmins = @()
try {
    $cfg0 = Read-Jsonc $CatclawJson
    $ExistingAdmins = @($cfg0.admin.allowedUserIds)
} catch {}

if ($ExistingAdmins.Count -gt 0 -and $ExistingAdmins[0]) {
    Info "已有 Admin：$($ExistingAdmins -join ', ')"
    $changeAdmin = Read-Host "  要新增或更換嗎？(y/N)"
    if ($changeAdmin -notmatch '^[Yy]') {
        Info "保留現有 Admin 設定"
        $AdminIds = $ExistingAdmins
    } else {
        Write-Host ""
        Write-Host "  Discord User ID（你自己的 ID）" -ForegroundColor White
        Write-Host "  取得方式：Discord 開啟開發者模式 -> 右鍵點自己 -> 複製 User ID"
        Write-Host "  多個以逗號分隔"
        Write-Host ""
        $AdminInput = Read-Host "  輸入 Discord User ID"
        if ($AdminInput) {
            $AdminIds = @($AdminInput -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' })
        } else {
            $AdminIds = $ExistingAdmins
        }
    }
} else {
    Write-Host ""
    Write-Host "  Discord User ID（你自己的 ID，將設為 platform-owner）" -ForegroundColor White
    Write-Host "  取得方式：Discord 設定 -> 進階 -> 開啟「開發者模式」-> 右鍵點自己 -> 複製 User ID"
    Write-Host "  多個以逗號分隔"
    Write-Host ""
    $AdminInput = Read-Host "  輸入 Discord User ID（留空稍後手動設定）"
    if ($AdminInput) {
        $AdminIds = @($AdminInput -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' })
    } else {
        $AdminIds = @()
    }
}

if ($AdminIds.Count -gt 0) {
    # 寫入 catclaw.json admin.allowedUserIds（ID 必須是字串，避免 JS 大數精度遺失）
    $idsArg = $AdminIds -join ","
    node -e "const fs=require('fs'),p=process.argv[1],raw=process.argv[2];const ids=raw.split(',').map(s=>s.trim()).filter(s=>/^\d+$/.test(s));const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.admin.allowedUserIds=ids;fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8')" $CatclawJson $idsArg
    Ok "Admin User IDs 已寫入 catclaw.json"

    # 建立帳號目錄與 _registry.json
    $AccountsDir = Join-Path $ConfigDir "accounts"
    if (-not (Test-Path $AccountsDir)) { New-Item -ItemType Directory -Path $AccountsDir -Force | Out-Null }

    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $registryAccounts = @{}
    $identityMap = @{}
    foreach ($uid in $AdminIds) {
        $accId = "discord-owner-$uid"
        $registryAccounts[$accId] = @{ role = "platform-owner"; displayName = "Admin($uid)" }
        $identityMap["discord:$uid"] = $accId

        # 建立 profile.json
        $profileDir = Join-Path $AccountsDir $accId
        if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
        $profile = @{
            accountId    = $accId
            displayName  = "Admin($uid)"
            role         = "platform-owner"
            identities   = @(@{ platform = "discord"; platformId = $uid; linkedAt = $now })
            projects     = @()
            preferences  = @{}
            createdAt    = $now
            lastActiveAt = $now
        }
        Write-Utf8 (Join-Path $profileDir "profile.json") ($profile | ConvertTo-Json -Depth 5)
    }

    $registry = @{ accounts = $registryAccounts; identityMap = $identityMap }
    # 若已有 _registry.json，merge 而非覆蓋
    $RegistryPath = Join-Path $AccountsDir "_registry.json"
    if (Test-Path $RegistryPath) {
        try {
            $existing = Get-Content $RegistryPath -Raw | ConvertFrom-Json
            foreach ($key in $existing.accounts.PSObject.Properties.Name) {
                if (-not $registryAccounts.ContainsKey($key)) {
                    $registryAccounts[$key] = @{ role = $existing.accounts.$key.role; displayName = $existing.accounts.$key.displayName }
                }
            }
            foreach ($key in $existing.identityMap.PSObject.Properties.Name) {
                if (-not $identityMap.ContainsKey($key)) {
                    $identityMap[$key] = $existing.identityMap.$key
                }
            }
        } catch {}
    }
    $registry = @{ accounts = $registryAccounts; identityMap = $identityMap }
    Write-Utf8 $RegistryPath ($registry | ConvertTo-Json -Depth 5)
    Ok "帳號已建立：$($AdminIds -join ', ')"
} else {
    Warn "未設定 Admin — 首次 Discord 訊息可能被拒絕存取"
    Warn "稍後請手動編輯 catclaw.json 的 admin.allowedUserIds"
}

# ═══════════════════════════════════════════════════════════════════
# Step 6: Discord Bot Token
# ═══════════════════════════════════════════════════════════════════
Step "Step 6/10: Discord Bot Token 設定"

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
Step "Step 7/10: Discord 預設頻道設定"

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
Step "Step 8/10: LLM Provider 設定"

$AuthProfile = Join-Path $Workspace "agents\$BootAgentId\auth-profile.json"
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
Step "Step 9/10: 功能開關"

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

# ── Ollama（記憶管線 embedding / extraction 後端）──────────────
Write-Host ""
Write-Host "  Ollama（本地 LLM，記憶系統用）" -ForegroundColor White
$ollamaAvailable = $false
$ollamaPath = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaPath) {
    Ok "Ollama 已安裝"
    $ollamaAvailable = $true
} else {
    $installOllama = Read-Host "  Ollama 未偵測到。要安裝嗎？(y/N)"
    if ($installOllama -match '^[Yy]') {
        Info "請從 https://ollama.com/download 下載安裝"
        Info "安裝完成後重新執行 setup.ps1 即可自動偵測"
    }
}

$extractionProvider = "ollama"
$extractionModel = "qwen3:14b"
if ($ollamaAvailable) {
    $pullModels = Read-Host "  自動拉取記憶模型（qwen3-embedding:8b + qwen3:14b）？(Y/n)"
    if ($pullModels -notmatch '^[Nn]') {
        Info "拉取 qwen3-embedding:8b（embedding 用）..."
        & ollama pull qwen3-embedding:8b 2>&1 | Out-Null
        Info "拉取 qwen3:14b（extraction 用）..."
        & ollama pull qwen3:14b 2>&1 | Out-Null
    }
} else {
    Info "無 Ollama — 記憶萃取改用 Anthropic API（haiku，低成本）"
    Info "（apiKey 自動從 auth-profile.json 讀取，不需額外設定）"
    $extractionProvider = "anthropic"
    $extractionModel = "claude-haiku-4-5-20251001"
}

# ── MCP Servers ─────────────────────────────────────────────────
Write-Host ""
Write-Host "  MCP Servers（擴充工具伺服器）" -ForegroundColor White
Write-Host ""

# Discord MCP
$enableDcMcp = Read-Host "  啟用 Discord MCP（讓 Agent 讀寫 Discord 訊息/附件/反應）？(Y/n)"
if ($enableDcMcp -match '^[Nn]') {
    $dcMcp = "false"
    Info "Discord MCP 已跳過（稍後可從 Dashboard 一鍵新增）"
} else {
    $dcMcp = "true"
    Ok "Discord MCP 已啟用"
}

# Computer Use MCP
Write-Host ""
$enableCuMcp = Read-Host "  啟用 Computer Use MCP（螢幕截圖/鍵鼠操控/視窗管理）？(y/N)"
if ($enableCuMcp -match '^[Yy]') {
    $cuMcp = "true"
    Ok "Computer Use MCP 已啟用"
    # 細節設定
    $cuScreenshotW = Read-Host "    截圖最大寬度（預設 1024）"
    if (-not $cuScreenshotW) { $cuScreenshotW = "1024" }
    $cuAllowedWin = Read-Host "    允許操控的視窗（* = 全部，預設 *）"
    if (-not $cuAllowedWin) { $cuAllowedWin = "*" }
    $defaultHistDir = if ($env:TEMP) { "$env:TEMP\computer-use-history" } else { "C:\Temp\computer-use-history" }
    $cuHistoryDir = Read-Host "    操作歷程目錄（預設 $defaultHistDir）"
    if (-not $cuHistoryDir) { $cuHistoryDir = $defaultHistDir }
} else {
    $cuMcp = "false"
    $cuScreenshotW = "1024"
    $cuAllowedWin = "*"
    $cuHistoryDir = if ($env:TEMP) { "$env:TEMP\computer-use-history" } else { "C:\Temp\computer-use-history" }
    Info "Computer Use MCP 已跳過（稍後可從 Dashboard 一鍵新增）"
}

# Playwright MCP
Write-Host ""
$enablePwMcp = Read-Host "  啟用 Playwright MCP（headless 瀏覽器自動化，不佔用螢幕）？(y/N)"
if ($enablePwMcp -match '^[Yy]') {
    $pwMcp = "true"
    Ok "Playwright MCP 已啟用"
    # 細節設定
    $pwBrowser = Read-Host "    瀏覽器（chromium / firefox / webkit，預設 chromium）"
    if (-not $pwBrowser) { $pwBrowser = "chromium" }
    $pwViewport = Read-Host "    Viewport 解析度（預設 1280x720）"
    if (-not $pwViewport) { $pwViewport = "1280x720" }
    $pwHeadless = Read-Host "    Headless 模式（true/false，預設 true）"
    if (-not $pwHeadless) { $pwHeadless = "true" }
} else {
    $pwMcp = "false"
    $pwBrowser = "chromium"
    $pwViewport = "1280x720"
    $pwHeadless = "true"
    Info "Playwright MCP 已跳過（稍後可從 Dashboard 一鍵新增）"
}

# 寫入設定（用 node 避免 ConvertTo-Json 巢狀問題）
node -e "const fs=require('fs'),p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.dashboard.enabled=(process.argv[2]==='true');c.cron.enabled=(process.argv[3]==='true');if(!c.mcpServers)c.mcpServers={};if(process.argv[4]==='true'){c.mcpServers['catclaw-discord']={command:'node',args:['./dist/mcp/discord-server.js'],tier:'public'}}if(process.argv[5]==='true'){c.mcpServers['computer-use']={command:'node',args:['./mcp/computer-use/dist/index.js'],env:{COMPUTER_USE_ALLOWED_WINDOWS:process.argv[8],COMPUTER_USE_MAX_SCREENSHOT_WIDTH:process.argv[7],COMPUTER_USE_HISTORY_DIR:process.argv[9]},tier:'elevated'}}if(process.argv[6]==='true'){c.mcpServers['playwright']={command:'node',args:['./mcp/playwright/dist/index.js'],env:{PLAYWRIGHT_HEADLESS:process.argv[12],PLAYWRIGHT_BROWSER:process.argv[10],PLAYWRIGHT_VIEWPORT:process.argv[11]},tier:'elevated'}}if(process.argv[13]&&process.argv[13]!=='ollama'){if(!c.memoryPipeline)c.memoryPipeline={};c.memoryPipeline.extraction={provider:process.argv[13],model:process.argv[14]}}fs.writeFileSync(p,JSON.stringify(c,null,2),'utf-8')" $CatclawJson $dashEnabled $cronEnabled $dcMcp $cuMcp $pwMcp $cuScreenshotW $cuAllowedWin $cuHistoryDir $pwBrowser $pwViewport $pwHeadless $extractionProvider $extractionModel

# ═══════════════════════════════════════════════════════════════════
# Step 9: 編譯 & 啟動
# ═══════════════════════════════════════════════════════════════════
Step "Step 10/10: 編譯 & 啟動"

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
