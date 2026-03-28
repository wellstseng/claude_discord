/**
 * PM2 ecosystem 設定
 * 監聽 signal/ 目錄，寫入 signal/RESTART 觸發重啟
 * dist/ 變更（tsc 編譯）不會觸發重啟
 */
const { homedir } = require('os');
const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');

// 手動載入 .env（dotenv 未安裝時的替代方案）
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const expandHome = (p) => p?.replace(/^~/, homedir()) ?? undefined;

module.exports = {
  apps: [{
    name: "catclaw",
    script: "dist/index.js",
    watch: ["signal"],
    watch_delay: 1000,
    autorestart: true,
    merge_logs: true,
    env: {
      CATCLAW_CONFIG_DIR: expandHome(process.env.CATCLAW_CONFIG_DIR) || `${homedir()}/.catclaw`,
      CATCLAW_WORKSPACE: expandHome(process.env.CATCLAW_WORKSPACE) || `${homedir()}/.catclaw/workspace`,
    },
  }]
};
