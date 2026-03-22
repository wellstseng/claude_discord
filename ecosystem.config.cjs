/**
 * PM2 ecosystem 設定
 * 監聽 signal/ 目錄，寫入 signal/RESTART 觸發重啟
 * dist/ 變更（tsc 編譯）不會觸發重啟
 */
module.exports = {
  apps: [{
    name: "catclaw",
    script: "dist/index.js",
    watch: false,
    autorestart: true,
    env: {
      // 允許外部環境變數覆寫，fallback 到 ~/.catclaw 預設值
      // 用 require('os').homedir() 取得 HOME，避免 PM2 環境 process.env.HOME 為 undefined
      CATCLAW_CONFIG_DIR: process.env.CATCLAW_CONFIG_DIR || `${require('os').homedir()}/.catclaw`,
      CATCLAW_WORKSPACE: process.env.CATCLAW_WORKSPACE || `${require('os').homedir()}/.catclaw/workspace`,
    },
  }]
};
