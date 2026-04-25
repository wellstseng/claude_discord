/**
 * @file mcp/client.ts
 * @description MCP Client — 連接外部 MCP server（stdio JSON-RPC 2.0）
 *
 * 流程：
 *   spawn() → initialize → tools/list → registerTools()
 *   tools/call 由 execute() 發送
 *
 * 特性：
 *   - 每個 server 一個 client 實例
 *   - 崩潰自動重連（最多 3 次，每次間隔加倍）
 *   - tool 名稱格式：mcp_{serverName}_{toolName}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolTier } from "../tools/types.js";

const MCP_CALL_TIMEOUT_MS = 60_000;

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 此 server 所有 tools 的預設 tier（預設 elevated） */
  tier?: ToolTier;
  /** 是否以 deferred 模式註冊（預設 true，不注入完整 schema 到 LLM context） */
  deferred?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

// ── McpClient ─────────────────────────────────────────────────────────────────

export class McpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready = false;
  private tools: McpTool[] = [];
  private retries = 0;
  private stopping = false;

  constructor(
    readonly serverName: string,
    private readonly cfg: McpServerConfig,
    private readonly registry: ToolRegistry,
  ) {}

  async start(): Promise<void> {
    await this._spawn();
  }

  stop(): void {
    this.stopping = true;
    this._cleanup();
  }

  private _cleanup(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.ready = false;
    // 拒絕所有未完成的 pending
    for (const [, p] of this.pending) p.reject(new Error("MCP client stopped"));
    this.pending.clear();
  }

  private async _spawn(): Promise<void> {
    const env = { ...process.env, ...this.cfg.env };

    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.on("error", (err) => {
      log.warn(`[mcp:${this.serverName}] 啟動失敗：${err.message}`);
      this._handleCrash();
    });

    this.proc.on("exit", (code) => {
      if (!this.stopping) {
        log.warn(`[mcp:${this.serverName}] 程序退出 code=${code}，嘗試重連`);
        this._handleCrash();
      }
    });

    // stderr → debug log
    if (this.proc.stderr) {
      const errRl = createInterface({ input: this.proc.stderr });
      errRl.on("line", (l) => log.debug(`[mcp:${this.serverName}:stderr] ${l}`));
    }

    // stdout → JSON-RPC response 解析
    if (this.proc.stdout) {
      const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch { /* 非 JSON，忽略 */ }
      });
    }

    try {
      // initialize
      await this._call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "catclaw", version: "1.0.0" },
      });
      // notifications/initialized (fire & forget)
      this._notify("notifications/initialized");

      // list tools
      const res = await this._call("tools/list", {}) as { tools?: McpTool[] };
      this.tools = res?.tools ?? [];
      this.ready = true;
      this.retries = 0;

      this._registerTools();
      log.info(`[mcp:${this.serverName}] 已連接，工具=${this.tools.map(t => t.name).join(",")}`);
    } catch (err) {
      log.warn(`[mcp:${this.serverName}] 初始化失敗：${err instanceof Error ? err.message : String(err)}`);
      this._handleCrash();
    }
  }

  private _handleCrash(): void {
    if (this.stopping) return;
    this._cleanup();
    if (this.retries >= 3) {
      log.warn(`[mcp:${this.serverName}] 重試次數超過上限，放棄`);
      return;
    }
    const delay = 1000 * Math.pow(2, this.retries);
    this.retries++;
    log.info(`[mcp:${this.serverName}] ${delay}ms 後重連（第 ${this.retries} 次）`);
    setTimeout(() => { void this._spawn(); }, delay);
  }

  private _call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("MCP process not running"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.proc.stdin.write(JSON.stringify(req) + "\n");
      // 60s 超時（原本 30s 對 Playwright 在 iframe 裡跑 async JS 不夠 — run_code 等頁面 frame 反應常常就破 30s）
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call timeout: ${method}`));
        }
      }, MCP_CALL_TIMEOUT_MS);
    });
  }

  private _notify(method: string): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.callRich(toolName, args);
    return result.text;
  }

  /**
   * 呼叫 MCP tool，回傳 rich content（含圖片 blocks）。
   * 若有 image content，contentBlocks 會包含 { type: "image", data, mimeType }。
   */
  async callRich(toolName: string, args: Record<string, unknown>): Promise<{
    text: string;
    contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
    isError: boolean;
  }> {
    if (!this.ready) throw new Error(`MCP server ${this.serverName} 尚未就緒`);
    const res = await this._call("tools/call", { name: toolName, arguments: args }) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown }>;
      isError?: boolean;
    };
    const blocks = res?.content ?? [];
    const text = blocks
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n");
    const isError = !!res?.isError;
    if (isError) throw new Error(text || "MCP tool error");

    // 有 image blocks → 存檔 + 回傳 rich content
    const hasImage = blocks.some(c => c.type === "image");
    if (hasImage) {
      const savedPaths: string[] = [];
      const cfgDir = process.env.CATCLAW_CONFIG_DIR;
      const imgDir = join(cfgDir ?? process.cwd(), "outbounds");
      await mkdir(imgDir, { recursive: true });
      for (const block of blocks) {
        if (block.type === "image" && block.data) {
          const ext = block.mimeType === "image/jpeg" ? "jpg" : "png";
          const filename = `${this.serverName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const filePath = join(imgDir, filename);
          try {
            await writeFile(filePath, Buffer.from(block.data as string, "base64"));
            savedPaths.push(filePath);
          } catch (e) {
            log.warn(`[mcp:${this.serverName}] 圖片存檔失敗：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      const pathsText = savedPaths.length > 0
        ? `\n📎 圖片已存至：${savedPaths.join(", ")}\n（可用 files 參數附加到 Discord 回覆）`
        : "";
      return {
        text: text + pathsText,
        contentBlocks: blocks,
        isError,
      };
    }
    return { text, isError };
  }

  private _registerTools(): void {
    const tier = this.cfg.tier ?? "elevated";
    // Deferred default：對 deferred 機制本身有問題的 MCP（playwright、MCPControl 這類「一次互動會連續呼叫多個 tool」的）
    // 強制 eager 載入，避免 mid-turn tool 加入觸發 Anthropic API 空回應 quirk。
    // 這類 MCP 即使省了 token，也會在第一次 tool_search 後因 quirk 卡住整個 turn，得不償失。
    // 已驗證：default agent + wendy agent 都會中招（trace 82aa1fec、e8c55181、0a557a74），
    // 跟 atom 內容無關，是 deferred-activation 與 streamAnthropic 互動的固有問題。
    const ALWAYS_EAGER_SERVERS = new Set(["playwright", "MCPControl", "computer-use"]);
    const forcedEager = ALWAYS_EAGER_SERVERS.has(this.serverName);
    const deferred = forcedEager ? false : (this.cfg.deferred !== false); // 預設 true，但被 forcedEager 覆寫
    for (const mcpTool of this.tools) {
      const toolName = `mcp_${this.serverName}_${mcpTool.name}`;
      const client = this;
      const schema = mcpTool.inputSchema;

      if (forcedEager) {
        log.info(`[mcp:${this.serverName}] tool ${toolName} 強制 eager（避免 deferred-activation quirk）`);
      }
      this.registry.register({
        name: toolName,
        description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${this.serverName}`,
        tier,
        deferred,
        parameters: (schema ?? { type: "object", properties: {} }) as import("../tools/types.js").JsonSchema,
        async execute(params) {
          try {
            // LLM 常把 number/array/boolean 當 string 送過來（如 depth:"3"、fields:"[{...}]"）
            // → 依 inputSchema 做寬容型別強制，避免 MCP 端 Zod validation 失敗讓 loop 空轉
            const coerced = coerceByMcpSchema(params, schema);
            const rich = await client.callRich(mcpTool.name, coerced);
            return {
              result: rich.text,
              ...(rich.contentBlocks ? { contentBlocks: rich.contentBlocks } : {}),
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      });
    }
  }
}

// ── MCP 參數型別寬容強制 ──────────────────────────────────────────────────────

/**
 * 依 MCP tool inputSchema 把 LLM 送來的錯誤型別強制轉回預期型別。
 *
 * 只處理「單純型別誤植」，不做 fuzzy matching：
 *   - schema 期望 number，收到 "3" → 3
 *   - schema 期望 array，收到 "[{...}]"（JSON 字串）→ JSON.parse
 *   - schema 期望 boolean，收到 "true"/"false" → true/false
 *   - schema 期望 object，收到 JSON 字串 → JSON.parse
 *
 * 強制失敗時原樣放行，交給 MCP server 的 validation 吐錯（不隱藏真正的 schema 違反）。
 */
function coerceByMcpSchema(
  params: Record<string, unknown>,
  schema: { properties?: Record<string, unknown>; [k: string]: unknown } | undefined,
): Record<string, unknown> {
  if (!schema?.properties || typeof schema.properties !== "object") return params;
  const props = schema.properties as Record<string, { type?: string | string[]; [k: string]: unknown }>;
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(params)) {
    const propSchema = props[key];
    if (!propSchema) continue;
    const expected = Array.isArray(propSchema.type) ? propSchema.type[0] : propSchema.type;
    if (!expected) continue;
    out[key] = coerceValue(value, expected);
  }
  return out;
}

function coerceValue(value: unknown, expected: string): unknown {
  // number / integer：string 數字 → Number
  if ((expected === "number" || expected === "integer") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return value;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return expected === "integer" ? Math.trunc(n) : n;
    return value;
  }
  // boolean：字串 "true"/"false" → boolean
  if (expected === "boolean" && typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return value;
  }
  // array / object：JSON 字串 → 對應型別（僅當 JSON.parse 後型別符合）
  if ((expected === "array" || expected === "object") && typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const firstChar = trimmed[0];
    if ((expected === "array" && firstChar !== "[") || (expected === "object" && firstChar !== "{")) {
      return value;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (expected === "array" && Array.isArray(parsed)) return parsed;
      if (expected === "object" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 解析失敗 → 原樣放行
    }
    return value;
  }
  return value;
}
