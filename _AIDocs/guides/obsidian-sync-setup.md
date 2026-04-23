# Obsidian 同步設定指南

> 讓 CatClaw atom 和 Claude Code memory 自動同步到 Obsidian 知識庫。

## 前置需求

- Obsidian vault 路徑已知（例如 `C:\Users\wells\WellsDB\知識庫` 或 `~/WellsDB/知識庫`）
- Python 3 已安裝（Claude Code hook 需要）

## A. CatClaw Atom → Obsidian

CatClaw 的 PostAtomWrite hook，在 atom 寫入後自動複製到 Obsidian。

### 步驟

1. 在 `~/.catclaw/workspace/hooks/` 建立 `PostAtomWrite.obsidian-export.ts`：

```typescript
/**
 * Hook：PostAtomWrite → atom 寫入後同步到 Obsidian 知識庫
 */

import { defineHook } from "<CATCLAW_PROJECT_PATH>/src/hooks/sdk.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

// ★ 改成你的 Obsidian vault 路徑
const OBSIDIAN_BASE = "C:\\Users\\wells\\WellsDB\\知識庫\\CatClaw";

export default defineHook(
  {
    event: "PostAtomWrite",
    name: "obsidian-export",
    timeoutMs: 5000,
  },
  async (input) => {
    const { atomPath, scope, agentId } = input;
    const filename = basename(atomPath);

    // 防迴圈：跳過從 Obsidian 同步進來的 vault_ atom
    if (filename.startsWith("vault_")) {
      return { action: "passthrough" };
    }

    // 只處理 .md
    if (!filename.endsWith(".md")) {
      return { action: "passthrough" };
    }

    // 讀取 atom 內容
    let content: string;
    try {
      content = readFileSync(atomPath, "utf-8");
    } catch {
      return { action: "passthrough" };
    }

    // 組裝目標路徑
    const subDir = scope === "agent" ? (agentId ?? "unknown") : "global";
    const targetDir = join(OBSIDIAN_BASE, subDir);
    const targetPath = join(targetDir, filename);

    // 加 frontmatter
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const frontmatter = [
      "---",
      `source: catclaw-atom`,
      `scope: ${scope}`,
      `agent: ${agentId ?? "unknown"}`,
      `synced_at: ${now}`,
      `atom_path: ${atomPath}`,
      "---",
      "",
    ].join("\n");

    // 如果原文已有 frontmatter，替換；否則前綴加入
    let output: string;
    if (content.startsWith("---\n")) {
      const endIdx = content.indexOf("\n---\n", 4);
      if (endIdx !== -1) {
        output = frontmatter + content.slice(endIdx + 5);
      } else {
        output = frontmatter + content;
      }
    } else {
      output = frontmatter + content;
    }

    // 寫入 Obsidian
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetPath, output, "utf-8");
    } catch {
      // 寫入失敗不阻塞主流程
    }

    return { action: "passthrough" };
  },
);
```

2. 修改上面的兩個值：
   - `<CATCLAW_PROJECT_PATH>`：CatClaw 專案的絕對路徑（例如 `C:/Users/wells/project/catclaw`）
   - `OBSIDIAN_BASE`：Obsidian vault 中 CatClaw 同步的目標目錄

3. 重啟 CatClaw（hook scanner 會自動載入）

### 驗證

重啟後在 log 中應看到：
```
[hooks] 已載入：PostAtomWrite/obsidian-export
```

## B. Claude Code Memory → Obsidian

Claude Code 的 PostToolUse hook，在 Write/Edit memory 檔案時自動複製到 Obsidian。

### 步驟

1. 在 `~/.claude/hooks/` 建立 `obsidian-sync.py`：

```python
#!/usr/bin/env python3
"""
PostToolUse hook: Claude Code memory → Obsidian 同步
觸發條件：Write 或 Edit tool 寫入 memory/ 目錄下的 .md 檔案
"""

import sys
import json
import os
import re
from pathlib import Path
from datetime import datetime

# ★ 改成你的 Obsidian vault 路徑
OBSIDIAN_BASE = Path(r"C:\Users\wells\WellsDB\知識庫\ClaudeCode")

def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return

    tool_name = data.get("tool_name", "")
    if tool_name not in ("Write", "Edit"):
        return

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path:
        return

    # 只處理 memory 目錄下的 .md 檔案
    if "/memory/" not in file_path.replace("\\", "/") or not file_path.endswith(".md"):
        return

    # 提取 project slug
    # 路徑格式: ~/.claude/projects/{slug}/memory/{file}.md
    normalized = file_path.replace("\\", "/")
    match = re.search(r"\.claude/projects/([^/]+)/memory/", normalized)
    if not match:
        return

    slug = match.group(1)
    filename = os.path.basename(file_path)
    target_dir = OBSIDIAN_BASE / slug
    target_path = target_dir / filename

    # 讀取來源檔案
    source = Path(file_path)
    if not source.exists():
        return

    content = source.read_text(encoding="utf-8")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 組裝 frontmatter
    frontmatter = f"""---
source: claude-code-memory
project: {slug}
synced_at: {now}
original_path: {file_path}
---

"""

    # 如果原文已有 frontmatter 就替換
    if content.startswith("---\n"):
        end_idx = content.find("\n---\n", 4)
        if end_idx != -1:
            body = content[end_idx + 5:]
        else:
            body = content
    else:
        body = content

    output = frontmatter + body

    # 寫入 Obsidian
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path.write_text(output, encoding="utf-8")

if __name__ == "__main__":
    main()
```

2. 修改 `OBSIDIAN_BASE` 為你的 Obsidian vault 中 ClaudeCode 同步目標目錄。

3. 在 `~/.claude/settings.json` 的 `hooks.PostToolUse` 陣列中加入：

```json
{
  "matcher": "Write|Edit",
  "hooks": [
    {
      "type": "command",
      "command": "python3 \"$HOME/.claude/hooks/obsidian-sync.py\"",
      "timeout": 5
    }
  ]
}
```

> Windows 上 `$HOME` 可能需要改成 `%USERPROFILE%`，視 Claude Code 的 shell 環境而定。
> 如果不確定，直接用絕對路徑：`"python3 \"C:/Users/wells/.claude/hooks/obsidian-sync.py\""`

### 驗證

在 Claude Code 中寫入或編輯一個 memory 檔案後，檢查 Obsidian vault 中是否出現對應的 .md 檔。

## 同步方向總覽

```
Obsidian .md 變更
    │
    ▼ (FileChanged.obsidian-sync.ts)
CatClaw Atom ◄──────────────────────────────────┐
    │                                            │
    ▼ (PostAtomWrite.obsidian-export.ts)         │ 防迴圈：vault_ 前綴跳過
    │                                            │
Obsidian ~/知識庫/CatClaw/{agent}/ ──────────────┘

Claude Code Memory
    │
    ▼ (obsidian-sync.py PostToolUse hook)
    │
Obsidian ~/知識庫/ClaudeCode/{project-slug}/
```

## 注意事項

- 防迴圈：CatClaw 的 Obsidian→Atom 同步使用 `vault_` 前綴，Atom→Obsidian 同步會跳過此前綴
- 兩個方向的 frontmatter 會被替換，不會無限疊加
- Hook 失敗不會影響主流程（靜默 catch）
- Obsidian 目標目錄不存在會自動建立
