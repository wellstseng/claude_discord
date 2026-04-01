import { join } from "node:path";
import { log } from "../logger.js";
import { getMemoryEngine } from "../memory/engine.js";
import { writeAtom } from "../memory/atom.js";
import type { CatClawEvents } from "../core/event-bus.js";
import type { KnowledgeItem } from "../memory/extract.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

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

export function initMemoryExtractor(eventBus: EventBus): void {
  eventBus.on("turn:after", (ctx, response) => {
    void (async () => {
      try {
        const engine = getMemoryEngine();
        const items = await engine.extractPerTurn(response, {
          accountId: ctx.accountId,
          projectId: ctx.projectId,
          namespace: ctx.projectId ? `project/${ctx.projectId}` : `account/${ctx.accountId}`,
        });

        if (!items.length) return;

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
            const dir = layerDir(globalDir, item.targetLayer, { projectId: ctx.projectId, accountId: ctx.accountId });
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
            log.debug(`[memory-extractor] 失敗：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        log.debug(`[memory-extractor] extractPerTurn 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  log.info("[memory-extractor] 初始化完成");
}
