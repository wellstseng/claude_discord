/**
 * 範例 Hook：FileChanged → Obsidian .md 變更自動寫入 atom
 *
 * 使用方式：
 *   1. 複製到 ~/.catclaw/workspace/hooks/
 *   2. catclaw.json 設定 fileWatcher 監聽 Obsidian vault：
 *      "fileWatcher": {
 *        "enabled": true,
 *        "watches": [{ "label": "obsidian", "path": "~/WellsDB" }]
 *      }
 *   3. fs.watch 自動 reload，Obsidian 中 .md 變更即觸發
 *
 * 行為：
 *   - 只處理 .md 檔案
 *   - 解析 H1 標題為 atom name，frontmatter tags 為 atom tags
 *   - 寫入 vault_{slug} atom（vault_ 前綴供 PostAtomWrite hook 辨識防迴圈）
 *
 * 檔名格式：{event}.{name}.ts → FileChanged.obsidian-sync.ts
 */

import { defineHook } from "../../src/hooks/sdk.js";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export default defineHook(
  {
    event: "FileChanged",
    name: "obsidian-sync",
    timeoutMs: 10000,
  },
  async (input) => {
    const { filePath, watchLabel } = input;

    // 只處理 .md 檔案
    if (extname(filePath).toLowerCase() !== ".md") {
      return { action: "passthrough" };
    }

    // 讀取檔案
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return { action: "passthrough" };
    }

    // 解析標題（H1）
    const h1Match = content.match(/^#\s+(.+)$/m);
    const name = h1Match?.[1]?.trim() ?? basename(filePath, ".md");

    // 解析 frontmatter tags
    let tags: string[] = [];
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const tagLine = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
      if (tagLine) {
        tags = tagLine[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
      }
    }

    // 產生 slug（vault_ 前綴防迴圈）
    const slug = basename(filePath, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "");
    const atomName = `vault_${slug}`;

    // 寫入 atom（需要 writeAtom 可用）
    // 這裡示範用 console.log 輸出，實際部署時替換為 writeAtom 呼叫
    console.log(JSON.stringify({
      action: "atom_write",
      name: atomName,
      tags: ["vault", watchLabel, ...tags],
      content: content.slice(0, 4000), // 截斷避免過大
      source: filePath,
    }));

    return { action: "passthrough" };
  },
);
