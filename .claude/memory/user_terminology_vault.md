---
name: 「vault」一律指 Obsidian vault
description: 使用者口中的「vault」永遠是 Obsidian vault，不要再問「哪個 vault」或誤解為其他 vault（KeePass / 密管等）
type: user
originSessionId: 5dd08e06-2d86-4705-92b9-e6e7568c1ab4
---
當使用者說「傳到 vault」、「vault 裡的 X」、「貼到 vault」等：
- 永遠是 **Obsidian vault**
- 不要再問「是 Obsidian / 1Password / KeePass 哪個 vault」

實際路徑（已驗證 2026-04-24）：
- **Vault 根目錄**：`/Users/wellstseng/WellsDB`（本機路徑，不在 iCloud，bash 可直接 ls / cp）
- **計畫類文件目標資料夾**：`/Users/wellstseng/WellsDB/計畫與報告/`
- 取得方式：`cat ~/Library/Application\ Support/obsidian/obsidian.json` 列出所有 registered vaults

vault 內常用子資料夾（已知）：
- `計畫與報告/` — 規劃文件、報告
- `工作日誌/` — 日報
- `知識庫/` — 長期參考
- `人生經驗/` — 私事
- `封存/` — 過期歸檔
- `工作簿/` — work-in-progress

命名慣例（看 `計畫與報告/` 現有檔）：`<專案名> <主題> 規劃.md` 或 `<專案>-<主題>-Plan.md`，中英混雜可接受。

需要傳到 vault 時直接 cp 進對應子資料夾，不要再問是哪個 vault。
