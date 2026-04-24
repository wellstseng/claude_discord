/**
 * @file cli-bridge/process.ts
 * @description CliProcess — 持久 CLI child process 封裝（Provider-neutral thin shell）
 *
 * Phase 1 重構後職責：
 * - 管 ChildProcess 生命週期（spawn / kill / signals / lifecycle events）
 * - 管 stdin / stdout pipe + line-based buffer
 * - 透過 CliProvider 介面 delegate「CLI 怎麼講話」（spawn args、stdin encode、stdout parse）
 *
 * Provider-specific 邏輯（Claude / 未來 Codex）由 providers/{name}.ts 實作。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { log } from "../logger.js";
import type { CliProcessConfig, StdinImageBlock, CliBridgeEvent } from "./types.js";
import type { CliProvider, ProcessIO, ProviderContext, AskUserCallback } from "./providers/provider.js";

// ── CliProcess ──────────────────────────────────────────────────────────────────

export interface CliProcessEvents {
  event: [CliBridgeEvent];
  close: [code: number | null];
  error: [err: Error];
  /** 原始 stdout 行（debug / logging 用） */
  raw: [line: string];
}

export class CliProcess extends EventEmitter<CliProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";

  /** 最近一次 stderr 輸出（供 bridge 偵測啟動失敗原因） */
  lastStderr = "";

  /** 注入給 provider 用的 IO 介面 */
  private readonly io: ProcessIO = {
    writeStdinLine: (line: string) => {
      if (!this.proc?.stdin?.writable) {
        throw new Error(`[cli-bridge:${this.config.label}] stdin 不可寫入（process 未啟動或已關閉）`);
      }
      this.proc.stdin.write(line + "\n");
      log.debug(`[cli-bridge:${this.config.label}] stdin: ${line.slice(0, 100)}`);
    },
    signal: (sig: NodeJS.Signals) => {
      this.killProcess(sig);
    },
  };

  /** 提供給 provider 的 context（會在 emit / sessionId 等動態綁定） */
  private get providerCtx(): ProviderContext {
    return {
      emit: (evt: CliBridgeEvent) => this.emit("event", evt),
      sessionId: this.config.sessionId,
      askUser: this.askUser,
    };
  }

  constructor(
    private config: CliProcessConfig,
    private provider: CliProvider,
    private askUser?: AskUserCallback,
  ) {
    super();
  }

  // ── 啟動 ──────────────────────────────────────────────────────────────────

  async spawn(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      throw new Error(`[cli-bridge:${this.config.label}] process 已在執行中`);
    }

    // Provider 決定 spawn args + 額外 env（例：Claude 寫 MCP config）
    const { args, env: providerEnv } = this.provider.buildSpawn(this.config);

    const label = this.config.label;
    log.info(`[cli-bridge:${label}] spawn: ${this.config.cliBin} ${args.join(" ")}`);

    const bridgeEnv: Record<string, string> = { ...process.env as Record<string, string>, ...providerEnv };

    this.proc = spawn(this.config.cliBin, args, {
      cwd: this.config.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: bridgeEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    log.info(`[cli-bridge:${label}] process spawned, pid=${this.proc.pid}`);

    // 重置 provider 的串流狀態
    this.provider.resetStreamState();
    this.buffer = "";

    // ── stdout 監聽 ──
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    // ── stderr 監聽 ──
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        log.debug(`[cli-bridge:${label}] stderr: ${text.slice(0, 200)}`);
        this.lastStderr = text;
      }
    });

    // ── process 結束 ──
    this.proc.on("close", (code) => {
      log.info(`[cli-bridge:${label}] process closed, code=${code}`);
      // 沖出 buffer 殘留
      this.flushBuffer();
      this.proc = null;
      this.emit("close", code);
    });

    this.proc.on("error", (err) => {
      log.error(`[cli-bridge:${label}] process error: ${err.message}`);
      this.emit("error", err);
    });

    // 等待 process 實際啟動（等第一個 stdout 或短暫 delay）
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (!this.alive) {
      throw new Error(`[cli-bridge:${label}] process 啟動失敗`);
    }

    // Provider 後置初始化（Claude noop；Codex 會在這裡跑 initialize handshake）
    await this.provider.postSpawn(this.io, this.providerCtx);
  }

  // ── stdin 送訊息（依類型走 provider encode）──────────────────────────────

  sendUserMessage(text: string, imageBlocks?: StdinImageBlock[]): void {
    this.provider.sendUserMessage(this.io, text, imageBlocks, this.providerCtx);
  }

  sendKeepAlive(): boolean {
    const result = this.provider.sendKeepAlive(this.io);
    // null 代表 provider 不需要 keep-alive；當作 ping 成功即可（不觸發 crash 重啟）
    if (result === null) return true;
    return result;
  }

  sendControlResponse(requestId: string, allowed: boolean): void {
    this.provider.sendControlResponse(this.io, requestId, allowed);
  }

  // ── 優雅關閉 ──────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    const label = this.config.label;
    if (!this.proc || this.proc.killed) {
      log.debug(`[cli-bridge:${label}] shutdown: process 已不在`);
      return;
    }

    log.info(`[cli-bridge:${label}] shutdown: 關閉 stdin`);

    // Step 1: 關閉 stdin（EOF → CLI 優雅結束）
    this.proc.stdin?.end();

    // Step 2: 等待 process 結束（最多 5s）
    const closed = await this.waitForClose(5000);
    if (closed) return;

    // Step 3: SIGTERM
    log.info(`[cli-bridge:${label}] shutdown: SIGTERM`);
    this.killProcess("SIGTERM");

    const terminated = await this.waitForClose(3000);
    if (terminated) return;

    // Step 4: SIGKILL
    log.warn(`[cli-bridge:${label}] shutdown: SIGKILL`);
    this.killProcess("SIGKILL");
    await this.waitForClose(2000);
  }

  // ── 中斷當前 turn ────────────────────────────────────────────────────────

  sendInterrupt(): void {
    if (!this.proc || this.proc.killed) return;
    log.info(`[cli-bridge:${this.config.label}] sending interrupt (provider=${this.provider.name})`);
    this.provider.interrupt(this.io, this.providerCtx);
  }

  // ── 健康檢查 ──────────────────────────────────────────────────────────────

  ping(): boolean {
    if (!this.alive) return false;
    return this.sendKeepAlive();
  }

  // ── 狀態查詢 ──────────────────────────────────────────────────────────────

  get alive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  // ── stdout 解析（line-based buffer → provider.parseStdoutLine）─────────

  private handleStdoutChunk(chunk: Buffer): void {
    const raw = chunk.toString();
    this.buffer += raw;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      this.emit("raw", trimmed);

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // 非 JSON 行（debug log）
      }

      this.provider.parseStdoutLine(obj, this.providerCtx);
    }
  }

  private flushBuffer(): void {
    if (!this.buffer.trim()) return;
    try {
      const obj = JSON.parse(this.buffer.trim()) as Record<string, unknown>;
      this.provider.parseStdoutLine(obj, this.providerCtx);
    } catch {
      // 非 JSON，忽略
    }
    this.buffer = "";
  }

  // ── 內部輔助 ──────────────────────────────────────────────────────────────

  private killProcess(sig: NodeJS.Signals): void {
    if (!this.proc?.pid) return;
    try {
      // detached 模式下殺 process group
      if (process.platform !== "win32") {
        process.kill(-this.proc.pid, sig);
      } else {
        this.proc.kill(sig);
      }
    } catch {
      try { this.proc.kill(sig); } catch { /* 靜默 */ }
    }
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("close", onClose);
    });
  }
}
