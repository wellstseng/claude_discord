/**
 * @file accounts/role-tool-sets.ts
 * @description 角色 Tool Set 定義 — 按角色定義推薦的工具集
 *
 * 設計：
 * - 每個角色定義「額外允許」的 tool 名稱清單（補充 tier 過濾）
 * - developer 角色等同 Claude Code 完整 coding tool set
 * - guest 角色只有 read-only 工具
 * - 此配置由 PermissionGate.listAvailable() 使用，在 tier 過濾後疊加
 */

import type { Role } from "./registry.js";

// ── 角色 Tool Set 定義 ──────────────────────────────────────────────────────

export interface RoleToolSet {
  /** 角色描述 */
  label: string;
  /**
   * 額外允許的 tool 名稱（無論 tier 限制，這些 tool 會被加入可用清單）。
   * null = 不額外加入（完全由 tier 決定）。
   */
  extraTools: string[] | null;
  /**
   * 強制排除的 tool 名稱（即使 tier 允許也移除）。
   * 用於限制特定角色的能力。
   */
  denyTools?: string[];
}

/**
 * 內建角色 tool set 定義。
 *
 * Tool tiers 決定基本存取，此表定義角色特有的增減：
 * - guest: 基本 tier=public（只有 tool_search），額外開放 read-only 工具
 * - member: tier=public+standard，額外開放 read-only 工具
 * - developer: tier 已涵蓋所有，此處列出完整 coding set 作為文件化
 * - admin: 同 developer + admin tools
 * - platform-owner: 全部
 */
export const ROLE_TOOL_SETS: Record<Role, RoleToolSet> = {
  guest: {
    label: "Guest (Read-only)",
    extraTools: ["read_file", "glob", "grep"],
    denyTools: ["write_file", "edit_file", "run_command", "spawn_subagent", "config_get", "config_patch"],
  },
  member: {
    label: "Member (Read + Basic)",
    extraTools: ["read_file", "glob", "grep", "web_search", "web_fetch"],
    denyTools: ["config_get", "config_patch"],
  },
  developer: {
    label: "Developer (Full Coding)",
    // developer 的 tier (public+standard+elevated) 已包含所有 coding tools
    // 此處列出完整 set 作為文件化 + 確保未來 tier 調整時不遺漏
    extraTools: null,
  },
  admin: {
    label: "Admin (Full + Config)",
    extraTools: null,
  },
  "platform-owner": {
    label: "Platform Owner (All)",
    extraTools: null,
  },
};

/** 取得角色的 tool set 定義 */
export function getRoleToolSet(role: Role): RoleToolSet {
  return ROLE_TOOL_SETS[role];
}

/** 取得角色的額外允許 tool 名稱 */
export function getRoleExtraTools(role: Role): string[] {
  return ROLE_TOOL_SETS[role]?.extraTools ?? [];
}

/** 取得角色的強制排除 tool 名稱 */
export function getRoleDenyTools(role: Role): string[] {
  return ROLE_TOOL_SETS[role]?.denyTools ?? [];
}
