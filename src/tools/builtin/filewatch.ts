/**
 * @file tools/builtin/filewatch.ts
 * @description filewatch — 管理檔案監聽目錄（list/add/remove）
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "filewatch",
  description:
    "管理檔案監聽目錄（觸發 FileChanged / FileDeleted hook event）。" +
    "list: 列出所有監聽點及狀態；add: 動態新增監聽（runtime only，不改 catclaw.json）；" +
    "remove: 停止並移除某 label 的監聽。",
  tier: "elevated",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "操作：list / add / remove",
        enum: ["list", "add", "remove"],
      },
      label: {
        type: "string",
        description: "監聽識別名（add / remove 必填）",
      },
      path: {
        type: "string",
        description: "監聽路徑（add 必填，支援 ~ 展開）",
      },
      ignoreDirs: {
        type: "array",
        items: { type: "string" },
        description: "忽略的目錄名（add 選填，預設 [\".obsidian\", \".trash\", \".git\"]）",
      },
      ignorePatterns: {
        type: "array",
        items: { type: "string" },
        description: "忽略的 glob pattern（add 選填）",
      },
      debounceMs: {
        type: "number",
        description: "Debounce 毫秒（add 選填，預設 1500）",
      },
      cooldownMs: {
        type: "number",
        description: "Per-path 冷卻期毫秒（add 選填，預設 10000）",
      },
    },
    required: ["action"],
  },
  async execute(params) {
    const action = String(params["action"]).trim();

    const { getFileWatcher } = await import("../../hooks/file-watcher.js");
    const fw = getFileWatcher();

    if (!fw) {
      return { error: "FileWatcher 未啟動。請先在 catclaw.json 設定 fileWatcher.enabled: true 並加入 watches 項目。" };
    }

    switch (action) {
      case "list": {
        const watches = fw.listWatches();
        if (watches.length === 0) return { result: "目前沒有任何監聽點" };
        const lines = watches.map(w =>
          `• ${w.label}: ${w.path} [${w.status}]`
        );
        return { result: lines.join("\n") };
      }

      case "add": {
        const label = String(params["label"] ?? "").trim();
        const path = String(params["path"] ?? "").trim();
        if (!label) return { error: "add 需要 label 參數" };
        if (!path) return { error: "add 需要 path 參數" };
        const entry = {
          label,
          path,
          ignoreDirs: params["ignoreDirs"] as string[] | undefined,
          ignorePatterns: params["ignorePatterns"] as string[] | undefined,
          debounceMs: params["debounceMs"] as number | undefined,
          cooldownMs: params["cooldownMs"] as number | undefined,
        };
        const msg = fw.addWatch(entry);
        return { result: msg };
      }

      case "remove": {
        const label = String(params["label"] ?? "").trim();
        if (!label) return { error: "remove 需要 label 參數" };
        const msg = fw.removeWatch(label);
        return { result: msg };
      }

      default:
        return { error: `未知 action: ${action}，支援 list / add / remove` };
    }
  },
};
