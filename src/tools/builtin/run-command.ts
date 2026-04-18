/**
 * @file tools/builtin/run-command.ts
 * @description run_command — 執行 shell 指令（elevated tier）
 *
 * 安全強化：
 * - stdout/stderr 合計上限 100KB
 * - sanitized env（只繼承 PATH/HOME/LANG/SHELL/TERM）
 * - 執行前經 SafetyGuard 黑名單/白名單檢查（由 before_tool_call hook 負責）
 * - 支援白名單模式（由 SafetyConfig.bash.mode 控制）
 */

import { spawn } from "node:child_process";
import { log } from "../../logger.js";
import type { Tool } from "../types.js";

const STDOUT_CAP = 100_000; // 100KB
const DEFAULT_TIMEOUT_MS = 0; // 0 = 無逾時限制

// ── Git Safety Protocol ─────────────────────────────────────────────────────

/**
 * 檢查 git 命令安全性，回傳錯誤訊息（null = 安全）。
 *
 * 規則：
 * 1. 禁止 --force / -f push（特別是 main/master）
 * 2. 禁止 --no-verify（跳過 hooks）
 * 3. 禁止 git reset --hard（除非使用者明確要求，由 exec-approval 處理）
 * 4. 禁止 git push --force 到 main/master
 * 5. 禁止 git checkout/restore . （丟棄所有變更）
 * 6. 禁止 git clean -f（刪除 untracked 檔案）
 * 7. 禁止 git branch -D（強制刪除分支）
 */
function checkGitSafety(command: string): string | null {
  // 正規化：去掉多餘空白
  const cmd = command.replace(/\s+/g, " ").trim();

  // 只檢查 git 命令
  if (!cmd.match(/\bgit\b/)) return null;

  // --no-verify：跳過 pre-commit hooks
  if (cmd.includes("--no-verify")) {
    return "Git Safety: --no-verify 被禁止。不要跳過 pre-commit hooks。如果 hook 失敗，請修正根本原因。";
  }

  // --no-gpg-sign / -c commit.gpgsign=false
  if (cmd.includes("--no-gpg-sign") || cmd.includes("commit.gpgsign=false")) {
    return "Git Safety: 禁止跳過 GPG 簽署。";
  }

  // git push --force / -f（特別保護 main/master）
  if (cmd.match(/\bgit\s+push\b/) && (cmd.includes("--force") || cmd.match(/\s-[a-zA-Z]*f/))) {
    if (cmd.includes("main") || cmd.includes("master")) {
      return "Git Safety: 禁止 force push 到 main/master。這會覆寫遠端歷史記錄。";
    }
    return "Git Safety: force push 有風險，可能覆寫遠端分支。請確認這是你要的操作。改用 --force-with-lease 更安全。";
  }

  // git reset --hard
  if (cmd.match(/\bgit\s+reset\b/) && cmd.includes("--hard")) {
    return "Git Safety: git reset --hard 會丟棄所有未提交的變更，無法復原。請確認是否有更安全的替代方案。";
  }

  // git checkout . / git checkout -- . / git restore .（丟棄所有變更）
  if (cmd.match(/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/)) {
    return "Git Safety: 這會丟棄工作目錄中所有未提交的修改。請改用指定檔案路徑的方式。";
  }

  // git clean -f（刪除 untracked 檔案）
  if (cmd.match(/\bgit\s+clean\b/) && cmd.match(/\s-[a-zA-Z]*f/)) {
    return "Git Safety: git clean -f 會永久刪除未追蹤的檔案。請先用 git clean -n 預覽。";
  }

  // git branch -D（強制刪除分支）
  if (cmd.match(/\bgit\s+branch\b/) && cmd.match(/\s-[a-zA-Z]*D/)) {
    return "Git Safety: git branch -D 會強制刪除分支（即使有未合併的 commit）。改用 -d 較安全。";
  }

  // git rebase -i（互動式，不支援非 TTY 環境）
  if (cmd.match(/\bgit\s+rebase\b/) && cmd.match(/\s-[a-zA-Z]*i/)) {
    return "Git Safety: git rebase -i 需要互動式終端，在此環境不支援。";
  }

  // git add -i（互動式）
  if (cmd.match(/\bgit\s+add\b/) && cmd.match(/\s-[a-zA-Z]*i/)) {
    return "Git Safety: git add -i 需要互動式終端，在此環境不支援。";
  }

  return null;
}

export const tool: Tool = {
  name: "run_command",
  description: "在 shell 執行指令並取得輸出",
  tier: "elevated",
  resultTokenCap: 3000,
  parameters: {
    type: "object",
    properties: {
      command:    { type: "string", description: "要執行的 shell 指令" },
      cwd:        { type: "string", description: "工作目錄（省略為預設）" },
      timeoutMs:  { type: "number", description: "逾時毫秒（預設 0 = 無限制）" },
    },
    required: ["command"],
  },
  async execute(params, ctx) {
    const command   = String(params["command"] ?? "").trim();
    const cwd       = params["cwd"] ? String(params["cwd"]) : undefined;
    const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : DEFAULT_TIMEOUT_MS;

    if (!command) return { error: "command 不能為空" };

    // Git Safety Protocol
    const gitSafetyError = checkGitSafety(command);
    if (gitSafetyError) {
      log.warn(`[run-command] git-safety blocked: ${command.slice(0, 80)} → ${gitSafetyError}`);
      return { error: gitSafetyError };
    }

    // PreCommandExec hook（可 block）
    try {
      const { getHookRegistry } = await import("../../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("PreCommandExec", ctx.agentId) > 0) {
        const pre = await hookReg.runPreCommandExec({
          event: "PreCommandExec",
          command,
          cwd,
          agentId: ctx.agentId,
          accountId: ctx.accountId,
        });
        if (pre.blocked) return { error: `PreCommandExec hook 阻擋：${pre.reason ?? ""}` };
      }
    } catch { /* hook 系統不可用，靜默通過 */ }

    return new Promise<{ result?: unknown; error?: string }>(resolve => {
      // sanitized env：只傳安全的環境變數
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "LANG", "SHELL", "TERM", "USER", "LOGNAME"]) {
        if (process.env[key]) safeEnv[key] = process.env[key];
      }

      const proc = spawn("sh", ["-c", command], {
        cwd,
        env: safeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;

      const onData = (chunk: Buffer) => {
        if (truncated) return;
        output += chunk.toString();
        if (output.length > STDOUT_CAP) {
          output = output.slice(0, STDOUT_CAP);
          truncated = true;
          proc.kill();
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            proc.kill();
            resolve({ error: `指令逾時（${timeoutMs}ms）：${command}` });
          }, timeoutMs)
        : null;

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const suffix = truncated ? "\n...[輸出超過 100KB，已截斷]" : "";
        resolve({ result: { exitCode: code, output: output + suffix } });
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({ error: `執行失敗：${err.message}` });
      });
    });
  },
};
