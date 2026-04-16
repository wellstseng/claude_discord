/**
 * @file hooks/metadata-parser.ts
 * @description 從 hook 腳本檔案抽取 metadata
 *
 * 支援兩種來源：
 * - .ts / .js / .mjs：spawn hook-runtime --metadata-only，讀 default export 的 metadata
 * - .sh / .bat / .ps1：讀檔頭尋找 `// @hook event=X toolFilter=Y,Z timeoutMs=3000` 註解
 *
 * Hook 命名/事件來源優先順序：
 *   檔案 metadata > 檔名規則（{event}.{name}.ext）> 拋錯
 */

import { promises as fs } from "node:fs";
import { extname, basename, resolve as pathResolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { HookMetadata } from "./sdk.js";
import type { HookEvent } from "./types.js";

const VALID_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "SessionStart", "SessionEnd",
  "UserMessageReceived", "UserPromptSubmit",
  "PreTurn", "PostTurn", "PreLlmCall", "PostLlmCall",
  "AgentResponseReady", "ToolTimeout",
  "PreAtomWrite", "PostAtomWrite", "PreAtomDelete", "PostAtomDelete",
  "AtomReplace", "MemoryRecall",
  "PreSubagentSpawn", "PostSubagentComplete", "SubagentError",
  "PreCompaction", "PostCompaction", "ContextOverflow",
  "CliBridgeSpawn", "CliBridgeSuspend", "CliBridgeTurn",
  "PreFileWrite", "PreFileEdit", "PreCommandExec",
  "SafetyViolation", "AgentError",
  "FileChanged", "FileDeleted",
  "ConfigReload", "ProviderSwitch",
]);

export type ScriptKind = "ts" | "js" | "shell" | "unknown";

export function detectScriptKind(filePath: string): ScriptKind {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts") return "ts";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
  if (ext === ".sh" || ext === ".bat" || ext === ".ps1") return "shell";
  return "unknown";
}

/** 從檔名推導預設 name / event：`{event}.{name}.ext` 或單純 `{name}.ext` */
export function deriveFromFilename(filePath: string): { name: string; eventHint?: HookEvent } {
  const base = basename(filePath, extname(filePath));
  const parts = base.split(".");
  if (parts.length >= 2 && VALID_EVENTS.has(parts[0])) {
    return {
      eventHint: parts[0] as HookEvent,
      name: parts.slice(1).join("."),
    };
  }
  return { name: base };
}

/** Shell 檔頭 `// @hook` 或 `# @hook` 解析 */
export async function parseShellMetadata(filePath: string): Promise<Partial<HookMetadata> | null> {
  const text = await fs.readFile(filePath, "utf8");
  const head = text.split("\n").slice(0, 10).join("\n");
  // 支援 `// @hook ...` 或 `# @hook ...` 或 `:: @hook ...` (bat)
  const m = head.match(/(?:\/\/|#|::)\s*@hook\s+(.+)/);
  if (!m) return null;

  const meta: Partial<HookMetadata> = {};
  const tokens = m[1].trim().split(/\s+/);
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq < 0) continue;
    const k = tok.slice(0, eq);
    const v = tok.slice(eq + 1);
    if (k === "event" && VALID_EVENTS.has(v)) {
      meta.event = v as HookEvent;
    } else if (k === "toolFilter") {
      meta.toolFilter = v.split(",");
    } else if (k === "timeoutMs") {
      const n = Number(v);
      if (!Number.isNaN(n)) meta.timeoutMs = n;
    } else if (k === "enabled") {
      meta.enabled = v !== "false";
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/** TS / JS metadata 經由 hook-runtime --metadata-only 取得 */
export async function parseScriptMetadata(filePath: string, kind: "ts" | "js"): Promise<Partial<HookMetadata> | null> {
  return new Promise((resolve) => {
    const runtimePath = pathResolve(dirname(fileURLToPath(import.meta.url)), "hook-runtime.js");
    const cmd = kind === "ts" ? "bunx" : "node";
    const args = kind === "ts"
      ? ["tsx", runtimePath, "--metadata-only", filePath]
      : [runtimePath, "--metadata-only", filePath];

    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.on("error", () => resolve(null));

    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } resolve(null); }, 5000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      try {
        const parsed = JSON.parse(stdout.trim()) as Partial<HookMetadata>;
        if (parsed.event && !VALID_EVENTS.has(parsed.event)) { resolve(null); return; }
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}
