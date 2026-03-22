#!/usr/bin/env node
/**
 * catclaw 跨平台管理腳本
 * 用法：node catclaw.js [init|start|stop|restart|logs|status|reset-session [channelId]]
 *
 * 重啟機制：
 * - start 使用 ecosystem.config.cjs，PM2 監聽 signal/ 目錄
 * - tsc 編譯不會觸發重啟（只編譯到 dist/，不動 signal file）
 * - 寫入 signal/RESTART 才會觸發 PM2 自動重啟
 *
 * init：初始化 ~/.catclaw/ 目錄結構（首次使用必跑，start 會自動呼叫）
 * reset-session：清除 sessions.json（全部或指定 channelId）
 * - node catclaw.js reset-session           → 清除所有 session
 * - node catclaw.js reset-session 12345     → 只清除指定 channel 的 session
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = (cmd) => {
  try {
    execSync(cmd, { cwd: __dirname, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
};

/** 檢查 pm2 中 catclaw 是否正在執行 */
function isRunning() {
  try {
    const out = execSync("npx pm2 jlist", { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] }).toString();
    const list = JSON.parse(out);
    return list.some((p) => p.name === "catclaw" && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

/**
 * 寫入 signal file 觸發 PM2 watch 重啟
 * channelId 從環境變數 CATCLAW_CHANNEL_ID 取得（由 acp.ts spawn 時設定）
 * 手動執行時不帶 channelId（無通知）
 *
 * @param channelId 可選，指定要通知的頻道
 */
function triggerRestart(channelId) {
  const signalDir = resolve(__dirname, "signal");
  mkdirSync(signalDir, { recursive: true });
  const signalPath = resolve(signalDir, "RESTART");
  writeFileSync(signalPath, JSON.stringify({
    channelId: channelId ?? process.env.CATCLAW_CHANNEL_ID,
    time: new Date().toISOString(),
  }), "utf-8");
}

// ── 初始化目錄結構 ───────────────────────────────────────────────────────────

/**
 * 確保 ~/.catclaw/ 目錄結構存在，首次使用時自動建立。
 * 回傳 { configDir, workspace, catclawJsonPath, needsToken }
 */
function ensureInitialized() {
  const configDir = process.env.CATCLAW_CONFIG_DIR
    ? resolve(process.env.CATCLAW_CONFIG_DIR)
    : join(homedir(), ".catclaw");

  const workspace = process.env.CATCLAW_WORKSPACE
    ? resolve(process.env.CATCLAW_WORKSPACE)
    : join(homedir(), ".catclaw", "workspace");

  const catclawJsonPath = join(configDir, "catclaw.json");
  const agentsPath = join(workspace, "AGENTS.md");
  const dataDir = join(workspace, "data");
  const activeTurnsDir = join(dataDir, "active-turns");

  let created = false;

  // 建立目錄結構
  for (const dir of [configDir, workspace, dataDir, activeTurnsDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`📁 建立目錄：${dir}`);
      created = true;
    }
  }

  // 複製 catclaw.json（從 catclaw.example.json 範本）
  let needsToken = false;
  if (!existsSync(catclawJsonPath)) {
    const examplePath = join(__dirname, "catclaw.example.json");
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, catclawJsonPath);
      console.log(`📄 建立設定檔：${catclawJsonPath}`);
      console.log(`   ⚠️  請編輯此檔，填入 discord.token 後再啟動`);
      needsToken = true;
    } else {
      console.warn(`⚠️  找不到範本 ${examplePath}，請手動建立 ${catclawJsonPath}`);
      needsToken = true;
    }
    created = true;
  } else {
    // 檢查 token 是否還是 placeholder
    try {
      const raw = readFileSync(catclawJsonPath, "utf-8").replace(/\/\/.*$/gm, "");
      const cfg = JSON.parse(raw);
      if (!cfg.discord?.token || cfg.discord.token === "your_discord_bot_token_here") {
        console.warn(`⚠️  ${catclawJsonPath} 中 discord.token 尚未設定`);
        needsToken = true;
      }
    } catch {
      console.warn(`⚠️  無法讀取 ${catclawJsonPath}，請確認格式正確`);
      needsToken = true;
    }
  }

  // 建立最小 AGENTS.md（若不存在）
  if (!existsSync(agentsPath)) {
    const defaultAgents = `# AGENTS.md — CatClaw Bot 行為規則

你是 CatClaw，一個專案知識代理人。

## 重啟機制

當使用者要求重啟 bot 時，依序執行：

1. 編譯程式碼（若有修改）：
   \`\`\`bash
   npx tsc
   \`\`\`

2. 寫入重啟信號（帶入頻道 ID，讓重啟後可回報）：
   \`\`\`bash
   node catclaw.js restart
   \`\`\`
   或直接寫 signal file：
   \`\`\`bash
   echo '{"channelId":"'$CATCLAW_CHANNEL_ID'","time":"'$(date -Iseconds)'"}' > signal/RESTART
   \`\`\`

重啟完成後，bot 會自動在觸發頻道發送 \`[CatClaw] 已重啟（時間）\`。

## 工作目錄

你的工作目錄是 \`${workspace}\`。
專案原始碼在 \`${__dirname}\`。
`;
    writeFileSync(agentsPath, defaultAgents, "utf-8");
    console.log(`📝 建立 AGENTS.md：${agentsPath}`);
    created = true;
  }

  if (created) {
    console.log("");
  }

  return { configDir, workspace, catclawJsonPath, needsToken };
}

// ── 指令處理 ─────────────────────────────────────────────────────────────────

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "init": {
    console.log("🔧 初始化 catclaw 環境...\n");
    const { catclawJsonPath, needsToken } = ensureInitialized();
    if (needsToken) {
      console.log(`\n❌ 請先編輯 ${catclawJsonPath}，填入 discord.token 後執行：`);
      console.log("   node catclaw.js start");
    } else {
      console.log("✅ 環境已就緒，執行 node catclaw.js start 啟動");
    }
    break;
  }

  case "start": {
    // start 前自動初始化（幂等，已存在的不覆蓋）
    const { needsToken } = ensureInitialized();
    if (needsToken) {
      const configDir = process.env.CATCLAW_CONFIG_DIR
        ? resolve(process.env.CATCLAW_CONFIG_DIR)
        : join(homedir(), ".catclaw");
      console.error(`\n❌ 請先設定 ${join(configDir, "catclaw.json")} 中的 discord.token`);
      process.exit(1);
    }

    if (isRunning()) {
      console.log("⚠️ catclaw 已在執行中，使用 restart 重啟或 stop 停止");
      process.exit(0);
    }
    run("npx tsc");
    mkdirSync(resolve(__dirname, "signal"), { recursive: true });
    run("npx pm2 start ecosystem.config.cjs");
    console.log("✅ catclaw 已啟動（背景執行，監聽 signal/RESTART）");
    break;
  }

  case "stop":
    run("npx pm2 stop catclaw");
    console.log("⏹ catclaw 已停止");
    break;

  case "restart":
    run("npx tsc");
    triggerRestart();
    console.log("🔄 catclaw 重啟信號已送出");
    break;

  case "logs":
    run("npx pm2 logs catclaw");
    break;

  case "status":
    run("npx pm2 status");
    break;

  case "reset-session": {
    const workspace = process.env.CATCLAW_WORKSPACE || join(homedir(), ".catclaw", "workspace");
    const sessionsPath = resolve(workspace, "data", "sessions.json");
    const targetChannel = process.argv[3];

    if (!existsSync(sessionsPath)) {
      console.log(`ℹ️ sessions.json 不存在：${sessionsPath}`);
      process.exit(0);
    }

    if (targetChannel) {
      const raw = readFileSync(sessionsPath, "utf-8");
      const data = JSON.parse(raw);
      if (data[targetChannel]) {
        delete data[targetChannel];
        writeFileSync(sessionsPath, JSON.stringify(data, null, 2), "utf-8");
        console.log(`✅ 已清除 channel ${targetChannel} 的 session`);
      } else {
        console.log(`ℹ️ 找不到 channel ${targetChannel} 的 session`);
      }
    } else {
      writeFileSync(sessionsPath, JSON.stringify({}, null, 2), "utf-8");
      console.log(`✅ 已清除所有 session（${sessionsPath}）`);
    }
    break;
  }

  default:
    console.log("用法：node catclaw.js [init|start|stop|restart|logs|status|reset-session [channelId]]");
    process.exit(1);
}
