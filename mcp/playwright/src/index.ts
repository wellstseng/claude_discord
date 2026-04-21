/**
 * @file index.ts
 * @description CatClaw Playwright MCP Server
 *
 * 封裝 @playwright/mcp，提供 headless 瀏覽器自動化。
 * 預設 headless + chromium，可透過環境變數覆寫。
 *
 * 環境變數：
 *   PLAYWRIGHT_HEADLESS     - "true"(預設) / "false"
 *   PLAYWRIGHT_BROWSER      - "chromium"(預設) / "firefox" / "webkit"
 *   PLAYWRIGHT_VIEWPORT     - "1280x720"(預設)
 *   PLAYWRIGHT_USER_DATA    - 持久化 profile 路徑（預設 isolated）
 *   PLAYWRIGHT_TIMEOUT      - action timeout ms（預設 10000）
 *   PLAYWRIGHT_NAV_TIMEOUT  - navigation timeout ms（預設 60000）
 */

import { createConnection } from "@playwright/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function buildConfig() {
  const headless = (process.env.PLAYWRIGHT_HEADLESS ?? "true") === "true";
  const browserName = (process.env.PLAYWRIGHT_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";
  const viewport = process.env.PLAYWRIGHT_VIEWPORT ?? "1280x720";
  const [vw, vh] = viewport.split("x").map(Number);
  const userDataDir = process.env.PLAYWRIGHT_USER_DATA;
  const actionTimeout = parseInt(process.env.PLAYWRIGHT_TIMEOUT ?? "10000", 10);
  const navTimeout = parseInt(process.env.PLAYWRIGHT_NAV_TIMEOUT ?? "60000", 10);

  return {
    browser: {
      browserName,
      isolated: !userDataDir,
      ...(userDataDir ? { userDataDir } : {}),
      launchOptions: {
        headless,
      },
      contextOptions: {
        viewport: { width: vw || 1280, height: vh || 720 },
      },
    },
    capabilities: ["core" as const, "core-navigation" as const, "core-tabs" as const, "core-input" as const, "network" as const, "pdf" as const, "storage" as const],
    timeouts: {
      action: actionTimeout,
      navigation: navTimeout,
    },
    imageResponses: "allow" as const,
  };
}

async function main() {
  const config = buildConfig();
  const server = await createConnection(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[playwright-mcp] Server 已啟動 (stdio, headless=${config.browser.launchOptions.headless}, browser=${config.browser.browserName})`);
}

main().catch((err) => {
  console.error("[playwright-mcp] 啟動失敗:", err);
  process.exit(1);
});
