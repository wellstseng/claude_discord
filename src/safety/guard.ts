/**
 * @file safety/guard.ts
 * @description Safety Guard — 程式碼層攔截（路徑保護 + Bash 黑名單/白名單 + credential 掃描）
 *
 * 攔截順序（在 Permission Gate 之後）：
 *   Permission Gate → Safety Guard → Tool 執行
 *
 * 安全設計參考架構文件第 7 節。
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SafetyConfig, ToolPermissionRule } from "../core/config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface GuardResult {
  blocked: boolean;
  reason?: string;
}

/** 呼叫 check() 時傳入的身份上下文 */
export interface PermissionContext {
  /** 帳號 ID */
  accountId?: string;
  /** 帳號角色 */
  role?: string;
  /** Agent ID（非 admin 時限定寫入 agents/{agentId}/） */
  agentId?: string;
  /** 是否為管理者 agent（admin 不受路徑限制） */
  isAdmin?: boolean;
}

// ── 預設保護路徑 ──────────────────────────────────────────────────────────────

const PROTECTED_WRITE_PATHS_DEFAULT = [
  "~/.catclaw/catclaw.json",
  "~/.catclaw/accounts/",
  "~/.catclaw/tools/",
  "~/.catclaw/skills/",
  "~/.claude/",
  "~/.ssh/",
  "~/.gnupg/",
];

/** auth-profile 相關檔案（credential 檔 + 狀態檔）禁止 AI 讀寫 */
const AUTH_PROFILE_PATTERNS = [
  /auth-profile\.json$/,
  /auth-profiles\.json$/,
  /-profiles\.json$/,       // {providerId}-profiles.json 狀態檔
];

const PROTECTED_READ_PATHS_DEFAULT = [
  "~/.catclaw/catclaw.json",
  "~/.catclaw/accounts/",
  "~/.catclaw/_invites.json",
];

const CREDENTIAL_PATTERNS_DEFAULT = [
  /\.env$/,
  /credentials/i,
  /secret/i,
  /token/i,
  /password/i,
  /apikey/i,
  /api_key/i,
  /private_key/i,
];

// ── Bash 黑名單（最後防線，不可被 config 移除） ──────────────────────────────
// 注意：一般規則已移到 catclaw.json safety.bash.blacklist，此處僅保留
// 即使 selfProtect=true 也無法透過 config 關掉的核心安全底線。

const BASH_BLACKLIST_HARDCODED: RegExp[] = [
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,         // fork bomb（任何情況都禁止）
  /\beval\b/,                              // eval 任意代碼執行
  /\b(bash|sh|zsh)\s+-c\s/,              // shell -c injection bypass
  /curl\s+.*\|\s*(ba)?sh/,               // pipe to shell
  /wget\s+.*\|\s*(ba)?sh/,
  /base64\s+.*\|\s*(ba)?sh/,
];

// ── SafetyGuard 類別 ──────────────────────────────────────────────────────────

export class SafetyGuard {
  private selfProtect: boolean;
  private bashMode: "blacklist" | "whitelist";
  private bashBlacklist: RegExp[];
  private bashWhitelist: string[];
  private protectedWritePaths: string[];
  private protectedReadPaths: string[];
  private credentialPatterns: RegExp[];
  private toolRules: ToolPermissionRule[];
  private toolDefaultAllow: boolean;
  private configDir?: string;

  constructor(cfg?: SafetyConfig, configDir?: string) {
    this.configDir = configDir;
    this.selfProtect = cfg?.selfProtect ?? true;
    this.bashMode = (cfg?.bash as { mode?: string } | undefined)?.mode === "whitelist"
      ? "whitelist" : "blacklist";

    // Bash blacklist：硬編碼底線 + config 設定（config 為主要來源）
    const configBlacklist = cfg?.bash?.blacklist ?? [];
    this.bashBlacklist = [
      ...BASH_BLACKLIST_HARDCODED,
      ...configBlacklist.map(s => new RegExp(s)),
    ];

    // Bash whitelist（白名單模式）
    this.bashWhitelist = (cfg?.bash as { whitelist?: string[] } | undefined)?.whitelist
      ?? ["git", "npm", "node", "cat", "ls", "grep", "find", "echo", "pwd", "which", "curl"];

    // 路徑保護
    this.protectedWritePaths = [
      ...PROTECTED_WRITE_PATHS_DEFAULT,
      ...(cfg?.filesystem?.protectedPaths ?? []),
    ].map(p => this.expandPath(p));

    this.protectedReadPaths = PROTECTED_READ_PATHS_DEFAULT.map(p => this.expandPath(p));

    // credential patterns
    this.credentialPatterns = [
      ...CREDENTIAL_PATTERNS_DEFAULT,
      ...(cfg?.filesystem?.credentialPatterns ?? []).map(s => new RegExp(s, "i")),
    ];

    // 工具權限規則（支援 shorthand 和標準格式混用）
    this.toolRules = (cfg?.toolPermissions?.rules ?? []).map(rule => {
      // 如果 tool 欄位包含括號，展開 shorthand
      if (rule.tool.includes("(")) {
        const parsed = SafetyGuard.parseShorthand(rule.tool);
        return {
          ...rule,
          tool: parsed.tool,
          paramMatch: { ...parsed.paramMatch, ...rule.paramMatch },
        };
      }
      return rule;
    });
    this.toolDefaultAllow = cfg?.toolPermissions?.defaultAllow ?? true;
  }

  // ── 主要進入點（by tool call）────────────────────────────────────────────────

  check(toolName: string, params: Record<string, unknown>, ctx?: PermissionContext): GuardResult {
    // 工具權限規則（優先於其他安全檢查）
    if (ctx && this.toolRules.length > 0) {
      const permResult = this.checkToolPermissions(toolName, params, ctx);
      if (permResult.blocked) return permResult;
      // effect=allow 的明確允許不繞過後續 bash/filesystem 檢查（安全優先）
    }

    switch (toolName) {
      case "run_command": {
        const bashResult = this.checkBash(String(params["command"] ?? ""));
        if (bashResult.blocked) return bashResult;
        return this.checkBashProtectedPaths(String(params["command"] ?? ""));
      }

      case "read_file":
        return this.checkFilesystem(String(params["path"] ?? ""), "read");

      case "write_file":
      case "edit_file": {
        const fsResult = this.checkFilesystem(String(params["path"] ?? ""), "write");
        if (fsResult.blocked) return fsResult;
        // Agent 路徑白名單：非 admin 限定 agents/{self}/
        if (ctx?.agentId && !ctx.isAdmin) {
          return this.checkAgentWritePath(String(params["path"] ?? ""), ctx.agentId);
        }
        return fsResult;
      }

      case "glob":
      case "grep":
        // 讀取型操作：只檢查 read 路徑保護
        if (params["path"]) return this.checkFilesystem(String(params["path"]), "read");
        return { blocked: false };

      default:
        return { blocked: false };
    }
  }

  // ── 工具權限規則評估 ────────────────────────────────────────────────────────

  /**
   * 依序評估 toolPermissions.rules，第一條匹配的規則生效。
   * deny → blocked；allow → 允許（後續 bash/fs 檢查仍執行）；
   * 無匹配 → 依 defaultAllow 決定。
   */
  checkToolPermissions(
    toolName: string,
    params: Record<string, unknown>,
    ctx: PermissionContext
  ): GuardResult {
    for (const rule of this.toolRules) {
      // 比對 subject
      if (rule.subjectType === "role" && rule.subject !== ctx.role) continue;
      if (rule.subjectType === "account" && rule.subject !== ctx.accountId) continue;

      // 比對工具名稱（支援 * 萬用符）
      if (!this.matchToolPattern(rule.tool, toolName)) continue;

      // 比對參數條件（可選）
      if (rule.paramMatch) {
        const paramMatch = Object.entries(rule.paramMatch).every(([key, pattern]) => {
          const val = String(params[key] ?? "");
          try { return new RegExp(pattern).test(val); }
          catch { return false; }
        });
        if (!paramMatch) continue;
      }

      // 規則命中
      if (rule.effect === "deny") {
        return {
          blocked: true,
          reason: rule.reason ?? `工具 ${toolName} 對此帳號/角色不可用`,
        };
      }
      return { blocked: false }; // effect=allow：明確允許
    }

    // 無規則匹配
    if (!this.toolDefaultAllow) {
      return { blocked: true, reason: `工具 ${toolName} 預設不允許（defaultAllow=false）` };
    }
    return { blocked: false };
  }

  /** 工具名稱萬用符匹配（支援 * 作為任意字元） */
  private matchToolPattern(pattern: string, toolName: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return pattern === toolName;
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(toolName);
  }

  // ── Config shorthand 解析（Claude Code 風格） ─────────────────────────────

  /**
   * 解析 Claude Code 風格的 shorthand pattern：
   *   "run_command(git *)" → { tool: "run_command", paramMatch: { command: "^git " } }
   *   "read_file(*.env)"  → { tool: "read_file", paramMatch: { path: "\\.env$" } }
   *   "write_*"           → { tool: "write_*" }
   *
   * 括號內的 pattern 自動對應到該 tool 的主要參數：
   *   run_command → command, read_file/write_file/edit_file → path, glob → pattern, grep → pattern
   */
  static parseShorthand(shorthand: string): { tool: string; paramMatch?: Record<string, string> } {
    const match = shorthand.match(/^([a-zA-Z_*]+)\((.+)\)$/);
    if (!match) return { tool: shorthand };

    const tool = match[1];
    const paramPattern = match[2];

    // 將 glob-style pattern 轉為 regex
    const regex = paramPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    // 根據 tool 名稱推斷主要參數
    const TOOL_PRIMARY_PARAM: Record<string, string> = {
      run_command: "command",
      read_file: "path",
      write_file: "path",
      edit_file: "path",
      glob: "pattern",
      grep: "pattern",
    };

    const paramKey = TOOL_PRIMARY_PARAM[tool] ?? "command";
    return { tool, paramMatch: { [paramKey]: regex } };
  }

  // ── Bash 指令檢查 ──────────────────────────────────────────────────────────

  checkBash(command: string): GuardResult {
    if (!command.trim()) return { blocked: true, reason: "指令不能為空" };

    if (this.bashMode === "whitelist") {
      // 取第一個 token（指令名稱）
      const cmd = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
      if (!this.bashWhitelist.includes(cmd)) {
        return { blocked: true, reason: `白名單模式：${cmd} 不在允許清單內` };
      }
      return { blocked: false };
    }

    // 黑名單模式
    for (const pattern of this.bashBlacklist) {
      if (pattern.test(command)) {
        return { blocked: true, reason: `指令被安全規則阻擋：${pattern}` };
      }
    }
    return { blocked: false };
  }

  // ── 檔案系統路徑檢查 ───────────────────────────────────────────────────────

  checkFilesystem(filePath: string, operation: "read" | "write"): GuardResult {
    if (!filePath) return { blocked: true, reason: "路徑不能為空" };

    const abs = this.expandPath(filePath);

    // auth-profile 檔案：讀寫皆禁止
    const fileName = abs.split("/").pop() ?? "";
    for (const pat of AUTH_PROFILE_PATTERNS) {
      if (pat.test(fileName)) {
        return { blocked: true, reason: `禁止${operation === "write" ? "寫入" : "讀取"} auth-profile 檔案：${abs}` };
      }
    }

    // 寫入保護
    if (operation === "write") {
      for (const p of this.protectedWritePaths) {
        if (abs === p || abs.startsWith(p.endsWith("/") ? p : p + "/")) {
          return { blocked: true, reason: `禁止寫入受保護路徑：${abs}` };
        }
      }

      // credential 模式
      const credResult = this.checkCredential(abs);
      if (credResult.blocked) return credResult;
    }

    // 讀取保護
    if (operation === "read") {
      for (const p of this.protectedReadPaths) {
        if (abs === p || abs.startsWith(p.endsWith("/") ? p : p + "/")) {
          return { blocked: true, reason: `禁止讀取受保護路徑：${abs}` };
        }
      }
    }

    return { blocked: false };
  }

  checkCredential(filePath: string): GuardResult {
    const base = filePath.split("/").pop() ?? "";
    for (const pattern of this.credentialPatterns) {
      if (pattern.test(base) || pattern.test(filePath)) {
        return { blocked: true, reason: `禁止存取憑證相關檔案：${filePath}` };
      }
    }
    return { blocked: false };
  }

  checkSelfProtect(filePath: string): GuardResult {
    if (!this.selfProtect) return { blocked: false };
    const abs = this.expandPath(filePath);
    // 保護當前 configDir 以及預設 ~/.catclaw
    const dirsToProtect = [
      resolve(homedir(), ".catclaw"),
      ...(this.configDir ? [resolve(this.configDir)] : []),
    ];
    for (const dir of dirsToProtect) {
      if (abs === resolve(dir, "catclaw.json") || abs.startsWith(resolve(dir, "accounts"))) {
        return { blocked: true, reason: `selfProtect：禁止修改 CatClaw 核心設定 ${abs}` };
      }
    }
    return { blocked: false };
  }

  // ── Agent 路徑白名單 ────────────────────────────────────────────────────────

  /**
   * 非 admin agent 只能寫入自己的 agentDir（~/.catclaw/agents/{agentId}/）。
   * 額外允許 agent config.json 指定的 workspaceDir（未來 Sprint 接入）。
   */
  checkAgentWritePath(filePath: string, agentId: string): GuardResult {
    const abs = this.expandPath(filePath);
    const catclawDir = resolve(homedir(), ".catclaw");
    const allowedDir = resolve(catclawDir, "agents", agentId);

    if (abs.startsWith(allowedDir + "/") || abs === allowedDir) {
      return { blocked: false };
    }

    return {
      blocked: true,
      reason: `Agent「${agentId}」只能寫入 agents/${agentId}/，不可存取：${abs}`,
    };
  }

  // ── Bash 路徑保護（防止 run_command 繞過 filesystem guard）────────────────

  /**
   * 掃描 bash 指令是否嘗試操作受保護路徑。
   * 檢查 ~/ 形式、$HOME 形式、以及展開後的絕對路徑。
   */
  private checkBashProtectedPaths(command: string): GuardResult {
    const home = homedir();
    const pathForms: Array<{ display: string; variants: string[] }> = [];

    // 建立每個受保護路徑的多種表示形式
    for (const raw of PROTECTED_WRITE_PATHS_DEFAULT) {
      const expanded = raw.startsWith("~/")
        ? resolve(home, raw.slice(2))
        : resolve(raw);
      const variants = [expanded];
      if (raw.startsWith("~/")) {
        variants.push(raw);                         // ~/.catclaw/catclaw.json
        variants.push("$HOME/" + raw.slice(2));     // $HOME/.catclaw/catclaw.json
      }
      pathForms.push({ display: raw, variants });
    }

    // 加入 config 額外保護路徑
    for (const p of this.protectedWritePaths) {
      const already = pathForms.some(pf => pf.variants.includes(p));
      if (!already) {
        pathForms.push({ display: p, variants: [p] });
      }
    }

    for (const { display, variants } of pathForms) {
      for (const v of variants) {
        if (command.includes(v)) {
          return {
            blocked: true,
            reason: `Bash 指令不可操作受保護路徑：${display}`,
          };
        }
      }
    }

    return { blocked: false };
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  private expandPath(p: string): string {
    if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
    if (p === "~") return homedir();
    return resolve(p);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _guard: SafetyGuard | null = null;

export function initSafetyGuard(cfg?: SafetyConfig, configDir?: string): SafetyGuard {
  _guard = new SafetyGuard(cfg, configDir);
  return _guard;
}

export function getSafetyGuard(): SafetyGuard {
  if (!_guard) throw new Error("[safety-guard] 尚未初始化，請先呼叫 initSafetyGuard()");
  return _guard;
}

export function resetSafetyGuard(): void {
  _guard = null;
}
