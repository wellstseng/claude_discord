---
name: 不要過度推測指令意圖
description: 使用者在 Claude Code 下指令時，直接執行，不要腦補成其他系統（CatClaw/溫蒂）的操作
type: feedback
originSessionId: 6f134e75-db87-495f-b0c3-a7024baf1118
---
使用者在 Claude Code session 裡輸入的指令，就直接當 Claude Code 指令執行，不要二次推測使用者是不是「其實想操作 CatClaw / 溫蒂」。

**Why:** 已多次發生 AI 正確辨識指令屬於 Claude Code，但仍反問「你是不是想清溫蒂的 session？」的情況。使用者明確表達這是反覆出現的問題且感到frustrated。

**How to apply:** 收到指令 → 辨識屬於哪個系統 → 直接執行。不要在已經辨識正確的情況下，又因為工作環境涉及 CatClaw 就把指令往 CatClaw 方向聯想。簡單指令不需要確認意圖。
