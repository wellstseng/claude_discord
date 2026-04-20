/**
 * @file test-framework/task-runner.ts
 * @description 測試任務執行器 — 管理測試生命週期
 *
 * 注意：實際的步驟執行由 CatClaw agent loop 驅動。
 * 這裡只負責狀態管理和報告收集。
 */

import type { TestTemplate, TestStep } from "./task-template.js";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface StepResult {
  step: TestStep;
  status: StepStatus;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  notes?: string;
  screenshotBase64?: string;
}

export interface TestTask {
  id: string;
  template: TestTemplate;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  startTime?: string;
  endTime?: string;
  currentStepIndex: number;
  stepResults: StepResult[];
}

const tasks = new Map<string, TestTask>();
let nextTaskId = 1;

/**
 * 建立新測試任務
 */
export function createTask(template: TestTemplate): TestTask {
  const id = `test-${nextTaskId++}-${Date.now()}`;
  const task: TestTask = {
    id,
    template,
    status: "pending",
    currentStepIndex: 0,
    stepResults: template.steps.map(step => ({
      step,
      status: "pending" as StepStatus,
    })),
  };
  tasks.set(id, task);
  return task;
}

/**
 * 開始執行測試
 */
export function startTask(taskId: string): TestTask {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`測試任務不存在: ${taskId}`);
  task.status = "running";
  task.startTime = new Date().toISOString();
  if (task.stepResults[0]) {
    task.stepResults[0].status = "running";
    task.stepResults[0].startTime = new Date().toISOString();
  }
  return task;
}

/**
 * 標記當前步驟完成，推進到下一步
 */
export function completeStep(taskId: string, passed: boolean, notes?: string, screenshot?: string): TestTask {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`測試任務不存在: ${taskId}`);

  const idx = task.currentStepIndex;
  const sr = task.stepResults[idx];
  if (!sr) throw new Error(`步驟 ${idx} 不存在`);

  sr.status = passed ? "passed" : "failed";
  sr.endTime = new Date().toISOString();
  sr.durationMs = sr.startTime ? Date.now() - new Date(sr.startTime).getTime() : undefined;
  sr.notes = notes;
  sr.screenshotBase64 = screenshot;

  if (!passed) {
    task.status = "failed";
    task.endTime = new Date().toISOString();
    // 後續步驟標記 skipped
    for (let i = idx + 1; i < task.stepResults.length; i++) {
      task.stepResults[i]!.status = "skipped";
    }
    return task;
  }

  // 推進到下一步
  task.currentStepIndex++;
  if (task.currentStepIndex >= task.stepResults.length) {
    task.status = "completed";
    task.endTime = new Date().toISOString();
  } else {
    const next = task.stepResults[task.currentStepIndex]!;
    next.status = "running";
    next.startTime = new Date().toISOString();
  }

  return task;
}

/**
 * 中止測試
 */
export function abortTask(taskId: string): TestTask {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`測試任務不存在: ${taskId}`);
  task.status = "aborted";
  task.endTime = new Date().toISOString();
  for (const sr of task.stepResults) {
    if (sr.status === "pending" || sr.status === "running") {
      sr.status = "skipped";
    }
  }
  return task;
}

export function getTask(taskId: string): TestTask | undefined {
  return tasks.get(taskId);
}

export function listTasks(): TestTask[] {
  return Array.from(tasks.values());
}
