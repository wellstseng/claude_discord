#!/usr/bin/env node
/**
 * catclaw 跨平台管理腳本
 * 用法：node catclaw.js [init|build|start [-f]|stop|restart|logs|status|reset-session [channelId]]
 *
 * 重啟機制：
 * - start 使用 ecosystem.config.cjs，PM2 監聽 signal/ 目錄
 * - tsc 編譯不會觸發重啟（只編譯到 dist/，不動 signal file）
 * - 寫入 signal/RESTART 才會觸發 PM2 自動重啟
 *
 * init：初始化 ~/.catclaw/ 目錄結構（首次使用必跑，start 會自動呼叫）
 * start -f：強制 delete + re-register PM2，確保 cwd 正確（重構後使用）
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

// 手動載入 .env（與 ecosystem.config.cjs 同邏輯）
const _envPath = resolve(__dirname, '.env');
if (existsSync(_envPath)) {
  for (const line of readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

/** String-aware JSONC comment stripper（跳過字串內的 //，刪除行注解和區塊注解） */
function stripJsoncComments(text) {
  let result = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && inString) { result += ch + (text[i + 1] ?? ""); i += 2; continue; }
    if (ch === '"') { inString = !inString; result += ch; i++; continue; }
    if (!inString && ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) { result += "\n"; i++; }
      continue;
    }
    if (!inString && ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") result += "\n";
        i++;
      }
      if (i < text.length) i += 2;
      continue;
    }
    result += ch; i++;
  }
  return result;
}
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
  if (!process.env.CATCLAW_CONFIG_DIR) {
    console.error("❌ 環境變數 CATCLAW_CONFIG_DIR 未設定（檢查 .env 檔案）");
    process.exit(1);
  }
  if (!process.env.CATCLAW_WORKSPACE) {
    console.error("❌ 環境變數 CATCLAW_WORKSPACE 未設定（檢查 .env 檔案）");
    process.exit(1);
  }
  const configDir = resolve(process.env.CATCLAW_CONFIG_DIR);
  const workspace = resolve(process.env.CATCLAW_WORKSPACE);

  const catclawJsonPath = join(configDir, "catclaw.json");
  const catclawMdPath = join(workspace, "CATCLAW.md");
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
      // 去掉 JSONC 註解後寫入乾淨 JSON
      const exampleRaw = readFileSync(examplePath, "utf-8");
      const cleanJson = stripJsoncComments(exampleRaw);
      writeFileSync(catclawJsonPath, cleanJson, "utf-8");
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
      const raw = stripJsoncComments(readFileSync(catclawJsonPath, "utf-8"));
      const cfg = JSON.parse(raw);
      if (!cfg.discord?.token || cfg.discord.token === "your_discord_bot_token_here" || cfg.discord.token === "") {
        console.warn(`⚠️  ${catclawJsonPath} 中 discord.token 尚未設定`);
        needsToken = true;
      }
    } catch(err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  無法讀取 ${catclawJsonPath}，請確認格式正確:\n錯誤訊息: ${msg}`);
      // 顯示出錯位置的內容以利診斷
      const posMatch = msg.match(/position (\d+)/);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const snippet = raw.substring(Math.max(0, pos - 40), pos + 40);
        console.warn(`出錯位置附近內容（position ${pos}）：\n...${snippet}...`);
      }
      needsToken = true;
    }
  }

  // 建立預設 CATCLAW.md（若不存在）
  if (!existsSync(catclawMdPath)) {
    const defaultCatclaw = `# CATCLAW.md — CatClaw Bot 行為規則

你是 CatClaw，一個專案知識代理人。

## 重啟機制

當使用者要求重啟 bot 時，依序執行：

1. 編譯程式碼（若有修改）：
   \`\`\`bash
   pnpm build
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
    writeFileSync(catclawMdPath, defaultCatclaw, "utf-8");
    console.log(`📝 建立 CATCLAW.md：${catclawMdPath}`);
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
      const configDir = resolve(process.env.CATCLAW_CONFIG_DIR);
      console.error(`\n❌ 請先設定 ${join(configDir, "catclaw.json")} 中的 discord.token`);
      process.exit(1);
    }

    const forceFlag = process.argv.includes("-f") || process.argv.includes("--force");

    if (forceFlag) {
      // -f：強制 delete + re-register，確保 PM2 cwd 正確（重構後或跨環境部署時使用）
      console.log("🔧 強制重新註冊 PM2 進程...");
      try {
        execSync("npx pm2 delete catclaw", { cwd: __dirname, stdio: "pipe" });
        console.log("  ✓ 舊進程已移除");
      } catch {
        // 不存在也沒關係
      }
    } else if (isRunning()) {
      console.log("⚠️ catclaw 已在執行中，使用 restart 重啟或 stop 停止");
      console.log("   （若要強制重新註冊 PM2，使用 node catclaw.js start -f）");
      process.exit(0);
    }

    run("npx pnpm build");
    mkdirSync(resolve(__dirname, "signal"), { recursive: true });
    // --update-env：確保 ecosystem.config.cjs 的 env 覆蓋舊 PM2 進程環境（-f 必填）
    run(forceFlag
      ? "npx pm2 start ecosystem.config.cjs --update-env"
      : "npx pm2 start ecosystem.config.cjs");
    console.log("✅ catclaw 已啟動（背景執行，監聽 signal/RESTART）");
    break;
  }

  case "build":
    run("npx pnpm build");
    console.log("✅ 編譯完成");
    break;

  case "stop":
    run("npx pm2 stop catclaw");
    console.log("⏹ catclaw 已停止");
    break;

  case "restart":
    run("npx pnpm build");
    triggerRestart();
    run("npx pm2 restart catclaw");
    console.log("🔄 catclaw 已重啟");
    break;

  case "logs": {
    const clearFlag = process.argv.includes("-c");
    if (clearFlag) run("npx pm2 flush catclaw");
    run("npx pm2 logs catclaw");
    break;
  }

  case "status":
    run("npx pm2 status");
    break;

  case "reset-session": {
    if (!process.env.CATCLAW_WORKSPACE) { console.error("❌ 環境變數 CATCLAW_WORKSPACE 未設定"); process.exit(1); }
    const workspace = resolve(process.env.CATCLAW_WORKSPACE);
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

  case "help":
  case "-h":
  case "--help":
  default: {
    const isHelp = ["help", "-h", "--help"].includes(cmd);
    console.log(`CatClaw — Discord AI Agent Platform

用法：catclaw <command>

指令：
  init                       初始化 ~/.catclaw/ 目錄結構
  build                      編譯 TypeScript（不啟動）
  start [-f]                 編譯 + PM2 啟動（-f 強制重新註冊）
  stop                       停止
  restart                    重新編譯 + 重啟
  logs [-c]                  即時 log（-c 清除後再顯示）
  status                     PM2 狀態
  reset-session [channelId]  清除 session（全部或指定頻道）
  help                       顯示此說明

環境變數：
  CATCLAW_CONFIG_DIR         catclaw.json 所在目錄（預設 ~/.catclaw）
  CATCLAW_WORKSPACE          Agent 工作目錄（預設 ~/.catclaw/workspace）

設定檔：
  ~/.catclaw/catclaw.json    主設定（JSONC 格式）
  Dashboard：http://localhost:8088`);
    process.exit(isHelp ? 0 : 1);
  }
}
