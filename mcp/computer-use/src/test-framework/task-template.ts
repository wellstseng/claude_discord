/**
 * @file test-framework/task-template.ts
 * @description 測試任務模板定義 + 載入
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TestStep {
  name: string;
  description: string;
  successCondition: string;
  /** 單步超時（毫秒），預設 60000 */
  timeoutMs?: number;
}

export interface TestTemplate {
  name: string;
  description: string;
  /** 全局超時（毫秒），預設 300000 */
  timeout: number;
  steps: TestStep[];
}

const TEMPLATES_DIR = new URL("../../templates", import.meta.url).pathname;

/**
 * 載入所有模板
 */
export async function loadTemplates(): Promise<TestTemplate[]> {
  try {
    const files = await readdir(TEMPLATES_DIR);
    const templates: TestTemplate[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await readFile(join(TEMPLATES_DIR, f), "utf8");
      templates.push(JSON.parse(raw) as TestTemplate);
    }
    return templates;
  } catch {
    return [];
  }
}

/**
 * 按名稱載入模板
 */
export async function loadTemplate(name: string): Promise<TestTemplate | null> {
  const all = await loadTemplates();
  return all.find(t => t.name === name) ?? null;
}
