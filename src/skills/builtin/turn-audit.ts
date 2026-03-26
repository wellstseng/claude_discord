/**
 * @file skills/builtin/turn-audit.ts
 * @description /turn-audit skill — 查詢 Turn Audit Log
 *
 * 用法：
 *   /turn-audit              → 最近 10 turn 摘要
 *   /turn-audit --last 5     → 最近 5 turn 詳細
 *   /turn-audit --ce         → 只顯示 CE 有觸發的 turns
 */

import type { Skill } from "../types.js";
import { getTurnAuditLog, formatAuditSummary, type TurnAuditEntry } from "../../core/turn-audit-log.js";

export const skill: Skill = {
  name: "turn-audit",
  description: "查詢 Turn Audit Log（token 消耗、CE 觸發、訊息流追蹤）",
  tier: "standard",
  trigger: ["/turn-audit"],

  async execute({ args }) {
    const auditLog = getTurnAuditLog();
    if (!auditLog) return { text: "❌ TurnAuditLog 尚未初始化", isError: true };

    // 解析 flags
    const ceOnly = args.includes("--ce");
    const lastMatch = args.match(/--last\s+(\d+)/);
    const limit = lastMatch ? parseInt(lastMatch[1]!, 10) : 10;

    const filter = ceOnly
      ? (e: TurnAuditEntry) => e.ceApplied.length > 0
      : undefined;

    const entries = auditLog.recent(limit, filter);
    const summary = formatAuditSummary(entries);

    const header = ceOnly
      ? `📊 Turn Audit（CE 觸發，最近 ${limit} 筆）：`
      : `📊 Turn Audit（最近 ${limit} 筆）：`;

    return { text: `${header}\n\`\`\`\n${summary}\n\`\`\`` };
  },
};
