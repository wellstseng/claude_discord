/**
 * @file workflow/bootstrap.ts
 * @description 工作流引擎統一初始化 — 訂閱所有模組到 EventBus
 *
 * 呼叫：platform.ts 的 initPlatform() 完成後執行
 */

import { join } from "node:path";
import { log } from "../logger.js";
import { eventBus } from "../core/event-bus.js";
import { initFileTracker } from "./file-tracker.js";
import { initSyncReminder } from "./sync-reminder.js";
import { initOscillationDetector } from "./oscillation-detector.js";
import { initRutDetector } from "./rut-detector.js";
import { initWisdomEngine } from "./wisdom-engine.js";
import { initFailureDetector } from "./failure-detector.js";
import { initAidocsManager } from "./aidocs-manager.js";

export interface WorkflowConfig {
  enabled?: boolean;
  wisdomEngine?: { enabled?: boolean };
  fixEscalation?: { enabled?: boolean; retryThreshold?: number; timeoutMs?: number };
  aidocs?: { enabled?: boolean; contentGate?: boolean };
  rutDetection?: { enabled?: boolean; windowSize?: number; minOccurrences?: number };
  oscillation?: { enabled?: boolean };
}

/**
 * 初始化所有工作流模組
 *
 * @param config  catclaw.json 的 workflow 區塊
 * @param dataDir 工作流持久化目錄（e.g. ~/.catclaw/workspace/data/workflow）
 * @param memoryDir 記憶目錄（用於 failure-detector 寫 failures/）
 * @param projectRoot 專案根目錄（用於 aidocs-manager 偵測 _AIDocs/）
 */
export function initWorkflow(
  config: WorkflowConfig | undefined,
  dataDir: string,
  memoryDir: string,
  projectRoot?: string,
): void {
  if (config?.enabled === false) {
    log.info("[workflow] 已停用（config.workflow.enabled=false）");
    return;
  }

  log.info("[workflow] 初始化工作流引擎...");

  try {
    // ── 1. File Tracker（基礎：其他模組依賴它）
    initFileTracker(eventBus);

    // ── 2. Sync Reminder
    initSyncReminder(eventBus);

    // ── 3. Oscillation Detector
    if (config?.oscillation?.enabled !== false) {
      initOscillationDetector(eventBus, dataDir);
    }

    // ── 4. Rut Detector
    if (config?.rutDetection?.enabled !== false) {
      initRutDetector(eventBus, dataDir);
    }

    // ── 5. Wisdom Engine
    if (config?.wisdomEngine?.enabled !== false) {
      initWisdomEngine(eventBus);
    }

    // ── 6. Failure Detector
    initFailureDetector(eventBus, memoryDir);

    // ── 7. AIDocs Manager
    if (config?.aidocs?.enabled !== false) {
      initAidocsManager(eventBus, projectRoot);
    }

    log.info("[workflow] 工作流引擎初始化完成");
  } catch (err) {
    // graceful fallback：工作流不可用不影響主流程
    log.warn(`[workflow] 初始化失敗（graceful fallback）：${err instanceof Error ? err.message : String(err)}`);
  }
}
