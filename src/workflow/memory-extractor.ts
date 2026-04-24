import { join } from "node:path";
import { log } from "../logger.js";
import { getMemoryEngine } from "../memory/engine.js";
import { writeAtom } from "../memory/atom.js";
import type { CatClawEvents } from "../core/event-bus.js";
import type { KnowledgeItem } from "../memory/extract.js";
type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

export interface ExtractorConfig {
  accumCharThreshold?: number;
  accumTurnThreshold?: number;
  cooldownMs?: number;
}

function layerDir(globalDir: string, layer: KnowledgeItem["targetLayer"], ctx: { projectId?: string; accountId: string }): string {
  switch (layer) {
    case "project":
      return ctx.projectId ? join(globalDir, "projects", ctx.projectId) : join(globalDir, "accounts", ctx.accountId);
    case "account":
      return join(globalDir, "accounts", ctx.accountId);
    case "global":
    default:
      return globalDir;
  }
}

function safeName(content: string): string {
  return content.slice(0, 20).replace(/[^a-z0-9]/gi, "_").slice(0, 20);
}

// ── 累積制 buffer（per session key）─────────────────────────────────────────

interface AccumBuffer {
  turns: { user: string; assistant: string }[];
  totalChars: number;
  lastCtx: CatClawEvents["turn:after"][0];
}

const _accumBuffers = new Map<string, AccumBuffer>();
let _cooldownMs = 120_000;

async function writeItems(items: KnowledgeItem[], ctx: { accountId: string; projectId?: string }): Promise<void> {
  if (!items.length) return;
  const engine = getMemoryEngine();
  const { globalDir } = engine.getStatus();

  for (const item of items) {
    try {
      const ns = item.targetLayer === "global" ? "global"
        : item.targetLayer === "project" ? `project/${ctx.projectId ?? "default"}`
        : `account/${ctx.accountId}`;
      const gate = await engine.checkWrite(item.content, ns);
      if (!gate.allowed) {
        log.debug(`[memory-extractor] write-gate 阻擋 (${gate.reason})：${item.content.slice(0, 40)}`);
        continue;
      }
      const name = `ext_${Date.now()}_${safeName(item.content)}`;
      const dir = layerDir(globalDir, item.targetLayer, ctx);
      writeAtom(dir, name, {
        description: item.content.slice(0, 60),
        confidence: "[臨]",
        scope: item.targetLayer,
        namespace: ns,
        triggers: item.triggers,
        content: item.content,
      });
      log.debug(`[memory-extractor] 寫入 ${name} → ${dir}`);
    } catch (err) {
      log.debug(`[memory-extractor] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function flushAccumBuffer(sessionKey: string, reason: string): Promise<void> {
  const buf = _accumBuffers.get(sessionKey);
  if (!buf || buf.turns.length === 0) return;
  _accumBuffers.delete(sessionKey);

  const ctx = buf.lastCtx;
  const combinedUser = buf.turns.map(t => t.user).join("\n");
  const combinedAssistant = buf.turns.map(t => t.assistant).join("\n");

  log.info(`[memory-extractor] flush(${reason})：${buf.turns.length} turns, ${buf.totalChars} chars, session=${sessionKey.slice(0, 20)}`);

  try {
    const engine = getMemoryEngine();
    const items = await engine.extractPerTurn(combinedAssistant, {
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      namespace: ctx.projectId ? `project/${ctx.projectId}` : `account/${ctx.accountId}`,
      userInput: combinedUser,
      cooldownMs: _cooldownMs,
    });
    await writeItems(items, ctx);
  } catch (err) {
    log.debug(`[memory-extractor] flush 萃取失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function initMemoryExtractor(eventBus: EventBus, cfg?: ExtractorConfig): void {
  const accumCharThreshold = cfg?.accumCharThreshold ?? 500;
  const accumTurnThreshold = cfg?.accumTurnThreshold ?? 5;
  _cooldownMs = cfg?.cooldownMs ?? 120_000;

  // ── 累積制：每 turn 累積，達閾值觸發萃取 ──────────────────────────────────
  eventBus.on("turn:after", (ctx, response) => {
    const sessionKey = ctx.sessionKey;
    let buf = _accumBuffers.get(sessionKey);
    if (!buf) {
      buf = { turns: [], totalChars: 0, lastCtx: ctx };
      _accumBuffers.set(sessionKey, buf);
    }
    buf.lastCtx = ctx;
    buf.turns.push({ user: ctx.prompt, assistant: response });
    buf.totalChars += ctx.prompt.length + response.length;

    if (buf.totalChars >= accumCharThreshold || buf.turns.length >= accumTurnThreshold) {
      void flushAccumBuffer(sessionKey, `accum(${buf.turns.length}t/${buf.totalChars}c)`);
    }
  });

  // ── Context 壓縮 → flush 累積（壓縮前的知識即將被丟棄）─────────────────────
  eventBus.on("context:compressed", (sessionKey) => {
    void flushAccumBuffer(sessionKey, "context:compressed");
  });

  // ── Session 結束 → flush 剩餘累積 ─────────────────────────────────────────
  eventBus.on("session:end", (sessionId) => {
    void flushAccumBuffer(sessionId, "session:end");
  });

  // ── 定期清理過期 buffer（防 session 永不結束的 leak）──────────────────────
  setInterval(() => {
    for (const [key, buf] of _accumBuffers) {
      if (buf.turns.length >= accumTurnThreshold * 2) {
        void flushAccumBuffer(key, "safety-flush");
      }
    }
  }, 5 * 60_000).unref();

  log.info(`[memory-extractor] 初始化完成（累積制：${accumCharThreshold} chars / ${accumTurnThreshold} turns）`);
}
