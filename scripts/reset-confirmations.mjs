#!/usr/bin/env node
/**
 * 一次性腳本：重置膨脹的 atom confirmations
 * confirmations > 10 → 重置為 3（保留 Last-used 不動）
 *
 * Usage: node scripts/reset-confirmations.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MEMORY_DIR = join(homedir(), ".catclaw", "memory");
const THRESHOLD = 10;
const RESET_TO = 3;
const dryRun = process.argv.includes("--dry-run");

const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
let changed = 0;

console.log(`掃描 ${files.length} 個 atom（threshold=${THRESHOLD}, reset_to=${RESET_TO}）\n`);

for (const file of files) {
  const filePath = join(MEMORY_DIR, file);
  const raw = readFileSync(filePath, "utf-8");
  const match = raw.match(/^(-\s+Confirmations:\s+)(\d+)/m);
  if (!match) continue;

  const current = parseInt(match[2], 10);
  if (current <= THRESHOLD) continue;

  const updated = raw.replace(/^(-\s+Confirmations:\s+)\d+/m, `$1${RESET_TO}`);
  console.log(`  ${file.replace(".md", "")}: ${current} → ${RESET_TO}`);

  if (!dryRun) {
    writeFileSync(filePath, updated, "utf-8");
  }
  changed++;
}

console.log(`\n${dryRun ? "[DRY RUN] " : ""}共 ${changed} 個 atom 已重置`);
