/**
 * @file index.ts
 * @description Computer Use MCP Server — stdio transport
 *
 * 提供螢幕截圖、鍵鼠操控、視窗管理等桌面自動化能力。
 * 透過 MCP protocol 讓 CatClaw agent 操控螢幕。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { takeScreenshot } from "./tools/screenshot.js";
import { performClick } from "./tools/click.js";
import { performType } from "./tools/type.js";
import { performScroll } from "./tools/scroll.js";
import { performCursor } from "./tools/cursor.js";
import { performWindows } from "./tools/windows.js";
import { getScreenInfo } from "./tools/screen-info.js";
import { recordOperation, getRecentHistory, exportMarkdownReport, clearHistory } from "./utils/history.js";
import { checkForStuck, resetStuckDetection } from "./utils/anomaly.js";
import { loadTemplates, loadTemplate } from "./test-framework/task-template.js";
import { createTask, startTask, completeStep, abortTask, getTask, listTasks } from "./test-framework/task-runner.js";
import { generateReport, generateSummary } from "./test-framework/report.js";

const server = new McpServer({
  name: "computer-use",
  version: "1.0.0",
});

// ── Phase 1: 基礎操控 ───────────────────────────────────────────────────────

server.tool(
  "computer_screenshot",
  "截取螢幕畫面。可指定視窗標題或區域。回傳圖片。注意：截圖可能包含敏感資訊，請勿在回覆中描述密碼等內容。",
  {
    windowTitle: z.string().optional().describe("指定視窗標題（模糊匹配）。未指定則截全螢幕"),
    region: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional().describe("截取指定區域（pixel 座標）"),
    scale: z.number().min(0.1).max(1.0).optional().describe("縮放比例（0.1-1.0），預設自動（長邊 ≤1568px）"),
    monitor: z.number().optional().describe("螢幕編號（多螢幕時指定），預設主螢幕"),
    checkStuck: z.boolean().optional().describe("是否進行卡住偵測（比較前後截圖差異）"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await takeScreenshot(params);

      // 卡住偵測
      let stuckInfo: Record<string, unknown> | undefined;
      if (params.checkStuck) {
        const buf = Buffer.from(result.base64, "base64");
        const stuck = await checkForStuck(buf);
        stuckInfo = stuck;
      }

      await recordOperation("computer_screenshot", params, {
        width: result.width,
        height: result.height,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        ...(stuckInfo ? { stuck: stuckInfo } : {}),
      }, undefined, Date.now() - start);

      const content: Array<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> = [
        { type: "image", data: result.base64, mimeType: result.mimeType },
      ];

      // 附加尺寸資訊
      let info = `尺寸: ${result.width}×${result.height}`;
      if (result.width !== result.originalWidth) {
        info += `（原始: ${result.originalWidth}×${result.originalHeight}）`;
      }
      if (stuckInfo) {
        const s = stuckInfo as { isStuck: boolean; unchangedCount: number; diffRatio: number };
        if (s.isStuck) {
          info += `\n⚠️ 畫面已連續 ${s.unchangedCount} 次無明顯變化（diff=${(s.diffRatio * 100).toFixed(1)}%），可能卡住了`;
        }
      }
      content.push({ type: "text", text: info });

      return { content };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `截圖失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "computer_click",
  "滑鼠點擊指定座標。支援左/右/中鍵、雙擊、組合鍵、長按。",
  {
    x: z.number().describe("X 座標（pixel）"),
    y: z.number().describe("Y 座標（pixel）"),
    button: z.enum(["left", "right", "middle"]).optional().describe("滑鼠按鍵，預設 left"),
    clicks: z.number().optional().describe("點擊次數（1=單擊, 2=雙擊），預設 1"),
    modifiers: z.array(z.enum(["ctrl", "alt", "shift", "meta", "cmd"])).optional().describe("組合鍵修飾（如 ctrl+click）"),
    holdMs: z.number().optional().describe("按住時間（毫秒），用於長按操作"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await performClick(params);
      await recordOperation("computer_click", params, result, undefined, Date.now() - start);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `點擊失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "computer_type",
  "鍵盤輸入文字或按鍵組合。text 逐字輸入，keys 同時按下（組合鍵）。二擇一。",
  {
    text: z.string().optional().describe("要輸入的文字（逐字輸入）"),
    keys: z.array(z.string()).optional().describe("按鍵組合，如 [\"ctrl\", \"c\"] 或 [\"enter\"]"),
    delayMs: z.number().optional().describe("每個按鍵間隔（毫秒），預設 50"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await performType(params);
      await recordOperation("computer_type", params, result, undefined, Date.now() - start);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `輸入失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Phase 2: 進階操控 ───────────────────────────────────────────────────────

server.tool(
  "computer_scroll",
  "滾輪操作。在指定座標位置滾動。",
  {
    x: z.number().describe("滾動位置 X 座標"),
    y: z.number().describe("滾動位置 Y 座標"),
    direction: z.enum(["up", "down", "left", "right"]).describe("滾動方向"),
    amount: z.number().optional().describe("滾動量（行數），預設 3"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await performScroll(params);
      await recordOperation("computer_scroll", params, result, undefined, Date.now() - start);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `滾動失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "computer_cursor",
  "游標操作：移動（move）、取得位置（position）、拖曳（drag）。",
  {
    action: z.enum(["move", "position", "drag"]).describe("操作類型"),
    x: z.number().optional().describe("目標 X（move/drag 用）"),
    y: z.number().optional().describe("目標 Y（move/drag 用）"),
    startX: z.number().optional().describe("拖曳起點 X（drag 用）"),
    startY: z.number().optional().describe("拖曳起點 Y（drag 用）"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await performCursor(params);
      await recordOperation("computer_cursor", params, result, undefined, Date.now() - start);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `游標操作失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "computer_windows",
  "視窗管理：列出（list）、聚焦（focus）、最小化（minimize）、最大化（maximize）、關閉（close）。",
  {
    action: z.enum(["list", "focus", "minimize"]).describe("操作類型"),
    title: z.string().optional().describe("視窗標題（模糊匹配）"),
    pid: z.number().optional().describe("Process ID（精確指定）"),
  },
  async (params) => {
    const start = Date.now();
    try {
      const result = await performWindows(params);
      await recordOperation("computer_windows", params, result, undefined, Date.now() - start);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `視窗操作失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "computer_screen_info",
  "查詢螢幕資訊：解析度、DPI、游標位置。",
  {},
  async () => {
    try {
      const result = await getScreenInfo();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `查詢失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Phase 3: 歷程與偵測 ─────────────────────────────────────────────────────

server.tool(
  "computer_history",
  "查詢操作歷程。可取得最近 N 步操作摘要或匯出 Markdown 報告。",
  {
    action: z.enum(["recent", "export", "clear"]).optional().describe("操作類型：recent（預設）、export（Markdown）、clear（清除）"),
    count: z.number().optional().describe("recent 時回傳的筆數，預設 10"),
  },
  async (params) => {
    try {
      const action = params.action ?? "recent";
      if (action === "clear") {
        await clearHistory();
        resetStuckDetection();
        return { content: [{ type: "text" as const, text: "歷程已清除" }] };
      }
      if (action === "export") {
        return { content: [{ type: "text" as const, text: exportMarkdownReport() }] };
      }
      const entries = getRecentHistory(params.count ?? 10);
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `歷程查詢失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Phase 4: 測試框架 ───────────────────────────────────────────────────────

server.tool(
  "computer_test",
  "測試任務管理：建立/啟動/推進/中止測試任務，查看模板和報告。",
  {
    action: z.enum(["templates", "start", "status", "step", "stop", "report", "list"]).describe(
      "操作：templates=列出模板, start=建立並啟動, status=查狀態, step=完成當前步驟, stop=中止, report=產生報告, list=列出所有任務"
    ),
    template: z.string().optional().describe("模板名稱（start 用）"),
    taskId: z.string().optional().describe("測試任務 ID（status/step/stop/report 用）"),
    passed: z.boolean().optional().describe("step 時：當前步驟是否通過"),
    notes: z.string().optional().describe("step 時：步驟備註"),
    screenshot: z.string().optional().describe("step 時：截圖 base64（附在報告中）"),
  },
  async (params) => {
    try {
      switch (params.action) {
        case "templates": {
          const templates = await loadTemplates();
          return { content: [{ type: "text" as const, text: JSON.stringify(templates.map(t => ({ name: t.name, description: t.description, steps: t.steps.length })), null, 2) }] };
        }
        case "start": {
          if (!params.template) throw new Error("start 需要 template 參數");
          const tmpl = await loadTemplate(params.template);
          if (!tmpl) throw new Error(`模板不存在: ${params.template}`);
          const task = createTask(tmpl);
          startTask(task.id);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            taskId: task.id,
            template: tmpl.name,
            status: task.status,
            currentStep: tmpl.steps[0]?.name,
            totalSteps: tmpl.steps.length,
          }) }] };
        }
        case "status": {
          if (!params.taskId) throw new Error("status 需要 taskId");
          const task = getTask(params.taskId);
          if (!task) throw new Error(`任務不存在: ${params.taskId}`);
          const cur = task.stepResults[task.currentStepIndex];
          return { content: [{ type: "text" as const, text: JSON.stringify({
            taskId: task.id,
            status: task.status,
            currentStep: cur?.step.name,
            currentStepIndex: task.currentStepIndex,
            totalSteps: task.stepResults.length,
            results: task.stepResults.map(s => ({ name: s.step.name, status: s.status })),
          }, null, 2) }] };
        }
        case "step": {
          if (!params.taskId) throw new Error("step 需要 taskId");
          const passed = params.passed ?? true;
          const task = completeStep(params.taskId, passed, params.notes, params.screenshot);
          const cur = task.stepResults[task.currentStepIndex];
          return { content: [{ type: "text" as const, text: JSON.stringify({
            taskId: task.id,
            status: task.status,
            completedStep: task.stepResults[task.currentStepIndex - 1]?.step.name,
            nextStep: cur?.step.name ?? "(完成)",
            summary: generateSummary(task),
          }) }] };
        }
        case "stop": {
          if (!params.taskId) throw new Error("stop 需要 taskId");
          const task = abortTask(params.taskId);
          return { content: [{ type: "text" as const, text: generateSummary(task) }] };
        }
        case "report": {
          if (!params.taskId) throw new Error("report 需要 taskId");
          const task = getTask(params.taskId);
          if (!task) throw new Error(`任務不存在: ${params.taskId}`);
          return { content: [{ type: "text" as const, text: generateReport(task) }] };
        }
        case "list": {
          const tasks = listTasks();
          return { content: [{ type: "text" as const, text: JSON.stringify(tasks.map(t => ({
            id: t.id,
            template: t.template.name,
            status: t.status,
            steps: `${t.stepResults.filter(s => s.status === "passed").length}/${t.stepResults.length}`,
          })), null, 2) }] };
        }
        default:
          throw new Error(`未知的 action: ${params.action}`);
      }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `測試操作失敗：${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── 啟動 ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[computer-use] MCP Server 已啟動 (stdio)");
}

main().catch((err) => {
  console.error("[computer-use] 啟動失敗:", err);
  process.exit(1);
});
