/**
 * @file test-framework/report.ts
 * @description 測試報告產生器 — Markdown 格式
 */

import type { TestTask } from "./task-runner.js";

const STATUS_ICON: Record<string, string> = {
  passed: "✅",
  failed: "❌",
  skipped: "⏭️",
  running: "🔄",
  pending: "⏳",
};

/**
 * 產生 Markdown 測試報告
 */
export function generateReport(task: TestTask): string {
  const totalMs = task.startTime && task.endTime
    ? new Date(task.endTime).getTime() - new Date(task.startTime).getTime()
    : undefined;

  const passed = task.stepResults.filter(s => s.status === "passed").length;
  const failed = task.stepResults.filter(s => s.status === "failed").length;
  const skipped = task.stepResults.filter(s => s.status === "skipped").length;
  const total = task.stepResults.length;

  const lines: string[] = [
    `# 測試報告：${task.template.name}`,
    "",
    `> ${task.template.description}`,
    "",
    `| 項目 | 值 |`,
    `|------|-----|`,
    `| 狀態 | ${STATUS_ICON[task.status] ?? ""} ${task.status} |`,
    `| 開始時間 | ${task.startTime ?? "-"} |`,
    `| 結束時間 | ${task.endTime ?? "-"} |`,
    `| 耗時 | ${totalMs != null ? `${(totalMs / 1000).toFixed(1)}s` : "-"} |`,
    `| 步驟 | ${passed}/${total} passed, ${failed} failed, ${skipped} skipped |`,
    "",
    "## 步驟詳情",
    "",
    "| # | 步驟 | 狀態 | 耗時 | 備註 |",
    "|---|------|------|------|------|",
  ];

  for (let i = 0; i < task.stepResults.length; i++) {
    const sr = task.stepResults[i]!;
    const icon = STATUS_ICON[sr.status] ?? "";
    const dur = sr.durationMs != null ? `${(sr.durationMs / 1000).toFixed(1)}s` : "-";
    const notes = sr.notes ?? "-";
    lines.push(`| ${i + 1} | ${sr.step.name} | ${icon} ${sr.status} | ${dur} | ${notes} |`);
  }

  // 步驟描述和成功條件
  lines.push("", "## 步驟定義", "");
  for (let i = 0; i < task.template.steps.length; i++) {
    const step = task.template.steps[i]!;
    lines.push(`### ${i + 1}. ${step.name}`);
    lines.push(`- **描述**: ${step.description}`);
    lines.push(`- **成功條件**: ${step.successCondition}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 產生簡短摘要（適合 Discord 回覆）
 */
export function generateSummary(task: TestTask): string {
  const passed = task.stepResults.filter(s => s.status === "passed").length;
  const total = task.stepResults.length;
  const icon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";

  let msg = `${icon} **${task.template.name}** — ${passed}/${total} steps passed`;

  if (task.status === "failed") {
    const failedStep = task.stepResults.find(s => s.status === "failed");
    if (failedStep) {
      msg += `\n失敗步驟: ${failedStep.step.name}`;
      if (failedStep.notes) msg += ` — ${failedStep.notes}`;
    }
  }

  return msg;
}
