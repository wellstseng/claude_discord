/**
 * @file accounts/permission-gate.ts
 * @description Permission Gate — 角色 Tier + 帳號 allow/deny 覆寫
 *
 * 設計：
 * - Tool 聲明 tier，角色決定可存取哪些 tier
 * - 帳號可額外 allow（最多突破一級）或 deny 特定 tool
 * - LLM 看到的 tool list 由 listAvailable() 物理過濾後產生
 */

import type { AccountRegistry, Account, Role } from "./registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolTier, ToolDefinition } from "../tools/types.js";
import { toDefinition } from "../tools/types.js";
import { log } from "../logger.js";
import { getRoleExtraTools, getRoleDenyTools } from "./role-tool-sets.js";

// ── Tier 排序 ─────────────────────────────────────────────────────────────────

const TIER_ORDER: ToolTier[] = ["public", "standard", "elevated", "admin", "owner"];

const ROLE_TIER_ACCESS: Record<Role, ToolTier[]> = {
  "platform-owner": ["public", "standard", "elevated", "admin", "owner"],
  "admin":          ["public", "standard", "elevated", "admin"],
  "developer":      ["public", "standard", "elevated"],
  "member":         ["public", "standard"],
  "guest":          ["public"],
};

/** 各角色可 allow 突破的最高 tier（最多突破一級）*/
const ROLE_MAX_ALLOW_TIER: Record<Role, ToolTier> = {
  "platform-owner": "owner",
  "admin":          "owner",    // admin 已有 admin，突破到 owner
  "developer":      "admin",
  "member":         "elevated",
  "guest":          "standard",
};

// ── PermissionResult ──────────────────────────────────────────────────────────

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ── PermissionGate ────────────────────────────────────────────────────────────

export class PermissionGate {
  constructor(
    private readonly accountRegistry: AccountRegistry,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  // ── 進門檢查（不針對特定 tool） ────────────────────────────────────────────

  checkAccess(accountId: string): PermissionResult {
    const account = this.accountRegistry.get(accountId);
    if (!account) return { allowed: false, reason: `未知帳號：${accountId}` };
    if (account.disabled) return { allowed: false, reason: "帳號已停用" };
    return { allowed: true };
  }

  // ── 單一 Tool 權限檢查 ─────────────────────────────────────────────────────

  check(accountId: string, toolName: string): PermissionResult {
    const account = this.accountRegistry.get(accountId);
    if (!account) return { allowed: false, reason: `未知帳號：${accountId}` };
    if (account.disabled) return { allowed: false, reason: "帳號已停用" };

    const permissions = (account as Account & { permissions?: { allow?: string[]; deny?: string[] } }).permissions;

    // 1. deny 優先（帳號層級 + 角色層級）
    if (permissions?.deny?.includes(toolName)) {
      return { allowed: false, reason: "帳號層級禁止" };
    }
    if (getRoleDenyTools(account.role).includes(toolName)) {
      return { allowed: false, reason: `角色 ${account.role} 禁止使用此工具` };
    }

    // 2. allow 覆寫（突破 tier 但有上限）
    if (permissions?.allow?.includes(toolName)) {
      const tool = this.toolRegistry.get(toolName);
      if (tool) {
        // owner tier tool 永遠不可被 allow 覆寫（除非本來就有 owner tier）
        if (tool.tier === "owner" && account.role !== "platform-owner") {
          return { allowed: false, reason: "owner tier tool 不可被 allow 覆寫" };
        }
        const maxAllowTier = ROLE_MAX_ALLOW_TIER[account.role];
        const toolTierIdx = TIER_ORDER.indexOf(tool.tier);
        const maxAllowIdx = TIER_ORDER.indexOf(maxAllowTier);
        if (toolTierIdx <= maxAllowIdx) {
          return { allowed: true };
        }
        return { allowed: false, reason: `allow 最多突破至 ${maxAllowTier}` };
      }
    }

    // 3. Role Tool Set：角色額外允許
    if (getRoleExtraTools(account.role).includes(toolName)) {
      return { allowed: true };
    }

    // 4. Tier 檢查
    const tool = this.toolRegistry.get(toolName);
    if (!tool) return { allowed: false, reason: `未知工具：${toolName}` };

    const allowedTiers = ROLE_TIER_ACCESS[account.role];
    if (!allowedTiers.includes(tool.tier)) {
      return { allowed: false, reason: `角色 ${account.role} 無法存取 tier=${tool.tier}` };
    }

    return { allowed: true };
  }

  // ── Tier-only 檢查（無需指定 tool，供 Skill 權限檢查使用） ─────────────────

  checkTier(accountId: string, tier: ToolTier): PermissionResult {
    const account = this.accountRegistry.get(accountId);
    if (!account) return { allowed: false, reason: `未知帳號：${accountId}` };
    if (account.disabled) return { allowed: false, reason: "帳號已停用" };
    const allowedTiers = ROLE_TIER_ACCESS[account.role];
    if (!allowedTiers.includes(tier)) {
      return { allowed: false, reason: `角色 ${account.role} 無法存取 tier=${tier}` };
    }
    return { allowed: true };
  }

  // ── 取得帳號可用的 ToolDefinition 清單（物理移除，LLM 看不到被移除的） ────

  listAvailable(accountId: string): ToolDefinition[] {
    const account = this.accountRegistry.get(accountId);
    if (!account) {
      log.warn(`[permission-gate] listAvailable：帳號 ${accountId} 不存在，回傳空清單`);
      return [];
    }

    const permissions = (account as Account & { permissions?: { allow?: string[]; deny?: string[] } }).permissions;
    const allowedTiers = ROLE_TIER_ACCESS[account.role];

    // 基礎 tier 過濾
    let tools = this.toolRegistry.all()
      .filter(t => allowedTiers.includes(t.tier))
      .filter(t => !permissions?.deny?.includes(t.name));

    // allow 覆寫：加入突破 tier 的 tool
    if (permissions?.allow) {
      const maxAllowTier = ROLE_MAX_ALLOW_TIER[account.role];
      const maxAllowIdx = TIER_ORDER.indexOf(maxAllowTier);

      for (const name of permissions.allow) {
        if (tools.find(t => t.name === name)) continue;  // 已在清單中
        const tool = this.toolRegistry.get(name);
        if (!tool) continue;
        if (tool.tier === "owner" && account.role !== "platform-owner") continue;
        if (TIER_ORDER.indexOf(tool.tier) <= maxAllowIdx) {
          tools.push(tool);
        }
      }
    }

    // Role Tool Set：角色額外允許的 tool（補充 tier 過濾）
    const roleExtras = getRoleExtraTools(account.role);
    for (const name of roleExtras) {
      if (tools.find(t => t.name === name)) continue;
      const tool = this.toolRegistry.get(name);
      if (tool) tools.push(tool);
    }

    // Role Tool Set：角色強制排除的 tool
    const roleDeny = getRoleDenyTools(account.role);
    if (roleDeny.length > 0) {
      const denySet = new Set(roleDeny);
      tools = tools.filter(t => !denySet.has(t.name));
    }

    return tools.map(t => toDefinition(t));
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _gate: PermissionGate | null = null;

export function initPermissionGate(accountRegistry: AccountRegistry, toolRegistry: ToolRegistry): PermissionGate {
  _gate = new PermissionGate(accountRegistry, toolRegistry);
  return _gate;
}

export function getPermissionGate(): PermissionGate {
  if (!_gate) throw new Error("[permission-gate] 尚未初始化，請先呼叫 initPermissionGate()");
  return _gate;
}

export function resetPermissionGate(): void {
  _gate = null;
}
