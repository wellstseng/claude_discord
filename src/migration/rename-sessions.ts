/**
 * @file migration/rename-sessions.ts
 * @description V1 → V2 Session 檔名遷移
 *
 * V1 格式：ch_{channelId}.json / dm_{accountId}_{channelId}.json
 * V2 格式：discord_ch_{channelId}.json / discord_dm_{accountId}_{channelId}.json
 *
 * 規則：
 * - 檔名以 ch_ 開頭 → 加 discord_ 前綴
 * - 檔名以 dm_ 開頭 → 加 discord_ 前綴
 * - 已有平台前綴（含 _ 的第一段是已知平台）→ 跳過
 * - 同時更新 JSON 內部的 sessionKey 欄位
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

const KNOWN_PLATFORMS = new Set(["discord", "telegram", "slack", "line", "whatsapp", "signal"]);

export interface RenameSessionsOptions {
  persistDir: string;
  platform?: string;  // 遷移目標平台（預設 "discord"）
  dryRun?: boolean;
}

export interface RenameSessionsResult {
  renamed: number;
  skipped: number;
  errors: number;
}

export function renameSessions(opts: RenameSessionsOptions): RenameSessionsResult {
  const { persistDir, platform = "discord", dryRun = false } = opts;
  const result: RenameSessionsResult = { renamed: 0, skipped: 0, errors: 0 };

  if (!existsSync(persistDir)) {
    log.info(`[migrate:rename-sessions] 目錄不存在，跳過：${persistDir}`);
    return result;
  }

  const files = readdirSync(persistDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"));

  for (const file of files) {
    const firstSegment = file.split("_")[0];

    // 已有平台前綴 → 跳過
    if (KNOWN_PLATFORMS.has(firstSegment)) {
      result.skipped++;
      continue;
    }

    // 只遷移 ch_ / dm_ 開頭的 V1 session 檔
    if (!file.startsWith("ch_") && !file.startsWith("dm_")) {
      result.skipped++;
      continue;
    }

    const newFile = `${platform}_${file}`;
    const oldPath = join(persistDir, file);
    const newPath = join(persistDir, newFile);

    if (existsSync(newPath)) {
      log.warn(`[migrate:rename-sessions] 目標已存在，跳過：${newFile}`);
      result.skipped++;
      continue;
    }

    try {
      // 更新 JSON 內部的 sessionKey 欄位
      const raw = readFileSync(oldPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;

      if (typeof data.sessionKey === "string") {
        const oldKey = data.sessionKey as string;
        // V1: ch:111 / dm:acc:111 → V2: discord:ch:111 / discord:dm:acc:111
        if (!KNOWN_PLATFORMS.has(oldKey.split(":")[0])) {
          data.sessionKey = `${platform}:${oldKey}`;
        }
      }

      if (!dryRun) {
        writeFileSync(newPath, JSON.stringify(data, null, 2), "utf-8");
        renameSync(oldPath, oldPath + ".v1bak");  // 保留備份
      }

      log.info(`[migrate:rename-sessions] ${dryRun ? "[dryRun] " : ""}${file} → ${newFile}`);
      result.renamed++;
    } catch (err) {
      log.warn(`[migrate:rename-sessions] 失敗 ${file}：${err instanceof Error ? err.message : String(err)}`);
      result.errors++;
    }
  }

  log.info(`[migrate:rename-sessions] 完成：renamed=${result.renamed} skipped=${result.skipped} errors=${result.errors}`);
  return result;
}
