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
      // 30s 超時
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call timeout: ${method}`));
        }
      }, 30_000);
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
    const deferred = this.cfg.deferred !== false; // 預設 true
    for (const mcpTool of this.tools) {
      const toolName = `mcp_${this.serverName}_${mcpTool.name}`;
      const client = this;

      this.registry.register({
        name: toolName,
        description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${this.serverName}`,
        tier,
        deferred,
        parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as import("../tools/types.js").JsonSchema,
        async execute(params) {
          try {
            const rich = await client.callRich(mcpTool.name, params);
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
