/**
 * @file core/dashboard.ts
 * @description Web Dashboard — 多分頁監控 + 操作面板
 *
 * 分頁：概覽 | Sessions | 日誌 | 操作 | Config
 * 端點：GET /  GET /api/usage  GET /api/sessions  GET /api/status
 *        GET /api/logs  POST /api/restart  GET /api/subagents
 *        GET /api/config  POST /api/config
 *        POST /api/sessions/clear  POST /api/sessions/delete
 *        POST /api/sessions/compact  POST /api/sessions/purge-expired
 *        POST /api/trigger
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, existsSync, mkdirSync, statSync, watchFile, unwatchFile } from "node:fs";
import { dirname, basename, join, join as pathJoin, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { getTraceStore, getTraceContextStore, MessageTrace, type MessageTraceEntry } from "./message-trace.js";
import { getSessionManager } from "./session.js";
import { getContextEngine } from "./context-engine.js";
import { getInboundHistoryStore } from "../discord/inbound-history.js";
import { PROTECTED_WRITE_PATHS_DEFAULT, PROTECTED_READ_PATHS_DEFAULT } from "../safety/guard.js";

// ── Codex OAuth 狀態 ────────────────────────────────────────────────────────
let _codexOAuthState: { status: string; authUrl?: string; expiresAt?: string; error?: string } | null = null;
/** 手動 callback URL 的 resolve 函式（供 onManualCodeInput 使用） */
let _codexManualResolve: ((value: string) => void) | null = null;

// ── Config 備份 ──────────────────────────────────────────────────────────────
const BACKUP_KEEP = 5;

/** 將提交資料中仍為 "***" 的敏感欄位還原為原始值 */
function restoreMasked(submitted: unknown, original: unknown): unknown {
  if (Array.isArray(submitted)) {
    return submitted.map((item, i) => restoreMasked(item, Array.isArray(original) ? original[i] : undefined));
  }
  if (submitted && typeof submitted === "object" && original && typeof original === "object") {
    const r: Record<string, unknown> = {};
    const orig = original as Record<string, unknown>;
    for (const [k, v] of Object.entries(submitted as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k) && v === "***" && typeof orig[k] === "string") {
        r[k] = orig[k]; // 未變動，還原原始值
      } else {
        r[k] = restoreMasked(v, orig[k]);
      }
    }
    return r;
  }
  return submitted;
}

function backupConfig(configPath: string): void {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = `${configPath}.bak.${ts}`;
  writeFileSync(backupPath, readFileSync(configPath, "utf-8"), "utf-8");
  const dir = dirname(configPath);
  const base = basename(configPath);
  const old = readdirSync(dir).filter(f => f.startsWith(`${base}.bak.`)).sort().reverse();
  for (const f of old.slice(BACKUP_KEEP)) {
    try { unlinkSync(pathJoin(dir, f)); } catch { /* 忽略 */ }
  }
}

// ── Config 敏感欄位遮罩 ───────────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set(["token", "apiKey", "api_key", "password", "credential"]);
function maskConfig(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskConfig);
  if (obj && typeof obj === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      r[k] = SENSITIVE_KEYS.has(k) && typeof v === "string" ? "***" : maskConfig(v);
    return r;
  }
  return obj;
}

// ── Log tail helper ──────────────────────────────────────────────────────────
function tailLog(lines = 100): string {
  const candidates = [
    pathJoin(homedir(), ".pm2", "logs", "catclaw-out.log"),
    pathJoin(homedir(), ".pm2", "logs", "catclaw-test-out.log"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const all = content.split("\n");
        return all.slice(-lines).join("\n");
      } catch { /* 忽略 */ }
    }
  }
  return "(log file not found)";
}

// ── SSE Log Streaming ────────────────────────────────────────────────────────
const _sseClients = new Set<ServerResponse>();
let _logWatchPath: string | null = null;
let _logLastSize = 0;

function findLogFile(): string | null {
  const candidates = [
    pathJoin(homedir(), ".pm2", "logs", "catclaw-out.log"),
    pathJoin(homedir(), ".pm2", "logs", "catclaw-test-out.log"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function startLogWatch(): void {
  if (_logWatchPath) return;
  const p = findLogFile();
  if (!p) return;
  _logWatchPath = p;
  try { _logLastSize = statSync(p).size; } catch { _logLastSize = 0; }
  watchFile(p, { interval: 500 }, () => {
    if (_sseClients.size === 0) return;
    try {
      const newSize = statSync(p).size;
      if (newSize <= _logLastSize) { _logLastSize = newSize; return; }
      const buf = Buffer.alloc(newSize - _logLastSize);
      const fd = require("node:fs").openSync(p, "r");
      require("node:fs").readSync(fd, buf, 0, buf.length, _logLastSize);
      require("node:fs").closeSync(fd);
      _logLastSize = newSize;
      const chunk = buf.toString("utf-8");
      const lines = chunk.split("\n").filter(l => l.length > 0);
      for (const line of lines) {
        const msg = `data: ${JSON.stringify(line)}\n\n`;
        for (const client of _sseClients) {
          try { client.write(msg); } catch { _sseClients.delete(client); }
        }
      }
    } catch { /* ignore */ }
  });
}

function stopLogWatch(): void {
  if (_logWatchPath) {
    unwatchFile(_logWatchPath);
    _logWatchPath = null;
  }
}

// ── Signal restart ───────────────────────────────────────────────────────────
function touchRestart(): boolean {
  const candidates = [
    resolve(process.cwd(), "signal", "RESTART"),
    resolve(homedir(), "project", "catclaw", "signal", "RESTART"),
  ];
  for (const p of candidates) {
    try {
      writeFileSync(p, new Date().toISOString(), "utf-8");
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ── API Data Builders ────────────────────────────────────────────────────────

function buildApiData(days = 7) {
  const traceStore = getTraceStore();
  if (!traceStore) return { error: "TraceStore not initialized" };

  const cutoff = Date.now() - days * 86400_000;
  const entries = traceStore.recent(100000, (e) => new Date(e.ts).getTime() >= cutoff);

  const totalInput = entries.reduce((s, e) => s + (e.totalInputTokens ?? 0), 0);
  const totalOutput = entries.reduce((s, e) => s + (e.totalOutputTokens ?? 0), 0);
  const totalCacheRead = entries.reduce((s, e) => s + (e.totalCacheRead ?? 0), 0);
  const totalCacheWrite = entries.reduce((s, e) => s + (e.totalCacheWrite ?? 0), 0);
  const totalCost = entries.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);
  const ceEntries = entries.filter(e => (e.contextEngineering?.strategiesApplied?.length ?? 0) > 0);
  const avgTokensSaved = ceEntries.length > 0
    ? Math.round(ceEntries.reduce((s, e) =>
        s + ((e.contextEngineering?.tokensBeforeCE ?? 0) - (e.contextEngineering?.tokensAfterCE ?? 0)), 0) / ceEntries.length)
    : 0;

  // provider 分布統計
  const providerCounts: Record<string, { turns: number; input: number; output: number }> = {};
  for (const e of entries) {
    const key = e.llmCalls[0]?.provider ?? "unknown";
    const p = providerCounts[key] ??= { turns: 0, input: 0, output: 0 };
    p.turns++;
    p.input += e.totalInputTokens ?? 0;
    p.output += e.totalOutputTokens ?? 0;
  }

  // 分類統計
  const categoryCounts: Record<string, number> = {};
  for (const e of entries) {
    const cat = e.category ?? "unknown";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  const dailyMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; ceTokensSaved: number; cost: number }>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const d = dailyMap.get(date) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ceTokensSaved: 0, cost: 0 };
    d.input += e.totalInputTokens ?? 0;
    d.output += e.totalOutputTokens ?? 0;
    d.cacheRead += e.totalCacheRead ?? 0;
    d.cacheWrite += e.totalCacheWrite ?? 0;
    d.cost += e.estimatedCostUsd ?? 0;
    if ((e.contextEngineering?.strategiesApplied?.length ?? 0) > 0) {
      d.ceTokensSaved += (e.contextEngineering?.tokensBeforeCE ?? 0) - (e.contextEngineering?.tokensAfterCE ?? 0);
    }
    dailyMap.set(date, d);
  }
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  const recentTurns: MessageTraceEntry[] = entries.slice(0, 20);

  return {
    totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost,
    totalTokens: totalInput + totalOutput,
    totalTurns: entries.length, ceTriggers: ceEntries.length, avgTokensSaved,
    providerCounts, categoryCounts, daily, recentTurns,
  };
}

function buildSessionsData() {
  const traceStore = getTraceStore();
  if (!traceStore) return { error: "TraceStore not initialized" };

  const entries = traceStore.recent(100000);
  const sessMap = new Map<string, {
    sessionKey: string; turns: number; inputTokens: number; outputTokens: number;
    cacheRead: number; cacheWrite: number; cost: number;
    firstTs: string; lastTs: string; ceTriggers: number;
    category?: string;
    providers: Set<string>; models: Set<string>;
    recentTurns: MessageTraceEntry[];
  }>();

  for (const e of entries) {
    const k = e.sessionKey ?? e.channelId;
    const s = sessMap.get(k) ?? {
      sessionKey: k, turns: 0, inputTokens: 0, outputTokens: 0,
      cacheRead: 0, cacheWrite: 0, cost: 0,
      firstTs: e.ts, lastTs: e.ts, ceTriggers: 0,
      category: e.category,
      providers: new Set<string>(), models: new Set<string>(),
      recentTurns: [],
    };
    s.turns++;
    s.inputTokens += e.totalInputTokens ?? 0;
    s.outputTokens += e.totalOutputTokens ?? 0;
    s.cacheRead += e.totalCacheRead ?? 0;
    s.cacheWrite += e.totalCacheWrite ?? 0;
    s.cost += e.estimatedCostUsd ?? 0;
    const provider = e.llmCalls[0]?.provider;
    const model = e.llmCalls[0]?.model;
    if (provider) s.providers.add(provider);
    if (model) s.models.add(model);
    if ((e.contextEngineering?.strategiesApplied?.length ?? 0) > 0) s.ceTriggers++;
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (s.recentTurns.length < 10) s.recentTurns.push(e);
    sessMap.set(k, s);
  }

  const sessions = Array.from(sessMap.values())
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
    .slice(0, 50)
    .map(s => ({
      ...s,
      providers: Array.from(s.providers),
      models: Array.from(s.models),
    }));

  return { sessions };
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CatClaw Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f1117; --bg2: #1a1d2e; --bg3: #1e2130; --bg4: #161827;
  --fg: #e0e0e0; --fg2: #888; --fg3: #666;
  --accent: #a78bfa; --accent2: #818cf8;
  --border: #2a2d3e;
  --green: #065f46; --green2: #34d399;
  --red: #7f1d1d; --red2: #f87171;
  --blue: #1e3a5f; --blue2: #60a5fa;
  --purple: #4c1d95; --purple2: #5b21b6;
  --warn: #f59e0b;
  --font-scale: 1;
}
[data-theme="light"] {
  --bg: #f5f5f5; --bg2: #ffffff; --bg3: #f0f0f0; --bg4: #e8e8e8;
  --fg: #1a1a1a; --fg2: #666; --fg3: #999;
  --accent: #7c3aed; --accent2: #6d28d9;
  --border: #d0d0d0;
  --green: #d1fae5; --green2: #059669;
  --red: #fee2e2; --red2: #dc2626;
  --blue: #dbeafe; --blue2: #2563eb;
  --purple: #ede9fe; --purple2: #7c3aed;
  --warn: #d97706;
}
html { font-size: calc(14px * var(--font-scale)); }
body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.topbar { background: var(--bg2); padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); }
.topbar h1 { font-size: 1.1rem; color: var(--accent); flex: 1; }
.tabs { display: flex; gap: 2px; background: var(--bg); padding: 0 20px; border-bottom: 1px solid var(--border); }
.tab { padding: 10px 16px; cursor: pointer; font-size: 0.85rem; color: var(--fg2); border-bottom: 2px solid transparent; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab:hover:not(.active) { color: var(--fg); }
.pane { display: none; padding: 20px; }
.pane.active { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.card { background: var(--bg3); border-radius: 8px; padding: 16px; }
.card h2 { font-size: 0.9rem; color: var(--accent2); margin-bottom: 10px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
.stat { background: var(--bg3); border-radius: 8px; padding: 12px; text-align: center; }
.stat-val { font-size: 1.3rem; font-weight: bold; color: var(--accent); }
.stat-lbl { font-size: 0.72rem; color: var(--fg2); margin-top: 4px; }
canvas { max-height: 200px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.tbl th { color: var(--accent2); background: var(--bg4); }
.tbl tr:hover td { background: var(--bg3); }
.btn { background: var(--purple); border: none; color: white; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.btn:hover { background: var(--purple2); }
.btn-green { background: var(--green); } .btn-green:hover { background: #047857; }
.btn-red { background: var(--red); } .btn-red:hover { background: #991b1b; }
.btn-sm { padding: 3px 8px; font-size: 0.72rem; }
.btn-danger { background: var(--red); border: none; color: white; padding: 2px 7px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; } .btn-danger:hover { background: #991b1b; }
.msg { font-size: 0.8rem; margin: 6px 0; }
.msg.ok { color: var(--green2); } .msg.err { color: var(--red2); }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; }
.badge-run { background: var(--green); color: var(--green2); }
.badge-done { background: var(--blue); color: var(--blue2); }
.badge-err { background: var(--red); color: var(--red2); }
textarea { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: monospace; font-size: 0.78rem; resize: vertical; }
details summary { cursor: pointer; color: #818cf8; font-size: 0.78rem; padding: 4px 0; }
details[open] summary { margin-bottom: 6px; }
.cfg-section { margin-bottom: 12px; }
.cfg-section summary { font-size: 0.88rem; font-weight: bold; color: var(--accent); cursor: pointer; padding: 8px 12px; background: var(--bg4); border-radius: 6px; }
.cfg-section[open] summary { border-radius: 6px 6px 0 0; }
.cfg-fields { padding: 12px; background: var(--bg2); border-radius: 0 0 6px 6px; }
.cfg-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.cfg-row label { min-width: 180px; font-size: 0.78rem; color: var(--fg2); }
.cfg-row input[type=text], .cfg-row input[type=number], .cfg-row input[type=password], .cfg-row select {
  flex: 1; min-width: 160px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-size: 0.78rem; font-family: monospace;
}
.cfg-row input[type=number] { max-width: 120px; }
.cfg-toggle { position: relative; display: block; width: 36px; min-width: 36px; max-width: 36px; height: 20px; flex: 0 0 36px; overflow: hidden; }
label.cfg-toggle { min-width: 36px; }
.cfg-toggle input { opacity: 0; width: 0; height: 0; }
.cfg-toggle .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #333; border-radius: 10px; transition: .2s; }
.cfg-toggle .slider:before { content: ""; position: absolute; height: 14px; width: 14px; left: 3px; bottom: 3px; background: var(--fg2); border-radius: 50%; transition: .2s; }
.cfg-toggle input:checked + .slider { background: var(--green); }
.cfg-toggle input:checked + .slider:before { transform: translateX(16px); background: var(--green2); }
.th-tip { display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;font-size:0.65rem;background:var(--bg4);color:var(--fg2);border:1px solid var(--border);border-radius:50%;cursor:help;margin-left:3px;vertical-align:middle; }
.cfg-map { width: 100%; }
.cfg-map-row { display: flex; gap: 4px; margin-bottom: 4px; align-items: center; }
.cfg-map-row input { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 0.75rem; font-family: monospace; }
.cfg-map-row .btn-x { background: var(--red); border: none; color: var(--red2); width: 22px; height: 22px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; }
.cfg-add { background: var(--blue); border: none; color: var(--blue2); padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; margin-top: 4px; }
.cfg-list { width: 100%; }
.cfg-list-item { display: flex; gap: 4px; margin-bottom: 4px; }
.cfg-list-item input { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 0.75rem; font-family: monospace; }
.cfg-sub { margin-left: 16px; border-left: 2px solid var(--border); padding-left: 12px; margin-top: 6px; margin-bottom: 6px; }
.cfg-dynamic-entry { background: var(--bg4); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
.cfg-dynamic-entry .entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cfg-dynamic-entry .entry-header input { flex: 1; font-weight: bold; }
/* ── Mobile responsive ──────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .topbar { padding: 8px 12px; gap: 6px; flex-wrap: wrap; }
  .topbar h1 { font-size: 0.95rem; }
  .tabs { padding: 0 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .tab { padding: 8px 10px; font-size: 0.78rem; white-space: nowrap; }
  .pane { padding: 10px; }
  .grid { grid-template-columns: 1fr; gap: 10px; }
  .stats { grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .stat { padding: 8px; }
  .stat-val { font-size: 1.1rem; }
  .card { padding: 10px; }
  .tbl { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .cfg-row { flex-direction: column; align-items: stretch; }
  .cfg-row label { min-width: auto; }
  .cfg-row input[type=text], .cfg-row input[type=number], .cfg-row input[type=password], .cfg-row select { min-width: auto; }
  .cfg-section summary { font-size: 0.82rem; padding: 6px 8px; }
  .cfg-fields { padding: 8px; }
  textarea { font-size: 0.72rem; }
}
@media (max-width: 480px) {
  .topbar h1 { font-size: 0.85rem; }
  .stats { grid-template-columns: 1fr 1fr; }
  .stat-val { font-size: 0.95rem; }
  .btn { padding: 5px 10px; font-size: 0.75rem; }
  .tbl th, .tbl td { padding: 4px 5px; font-size: 0.72rem; }
}
.cfg-hint { font-size: 0.68rem; color: var(--fg3); margin-left: 4px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🐱 CatClaw Dashboard</h1>
  <span style="font-size:0.72rem;color:var(--fg2)">字體</span>
  <input type="range" id="font-slider" min="0.7" max="1.4" step="0.05" value="1" style="width:80px;accent-color:var(--accent)" onchange="setFontScale(this.value)" oninput="setFontScale(this.value)">
  <span id="font-pct" style="font-size:0.72rem;color:var(--fg2);min-width:30px">100%</span>
  <button class="btn btn-sm" id="theme-btn" onclick="toggleTheme()">☀️ Light</button>
  <button class="btn btn-sm" onclick="refreshAll()">↻ 全部刷新</button>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('overview',this)">概覽</div>
  <div class="tab" onclick="switchTab('sessions',this)">Sessions</div>
  <div class="tab" onclick="switchTab('logs',this)">日誌</div>
  <div class="tab" onclick="switchTab('ops',this)">操作</div>
  <div class="tab" onclick="switchTab('cron',this)">排程</div>
  <div class="tab" onclick="switchTab('traces',this)">Traces</div>
  <div class="tab" onclick="switchTab('tasks',this)">Tasks</div>
  <div class="tab" onclick="switchTab('auth',this)">Auth Profiles</div>
  <div class="tab" onclick="switchTab('config',this)">Config</div>
  <div class="tab" onclick="switchTab('memory',this)">Memory</div>
  <div class="tab" onclick="switchTab('pipeline',this)">Pipeline</div>
  <div class="tab" onclick="switchTab('inbound',this)">Inbound</div>
  <div class="tab" onclick="switchTab('clibridge',this)">CLI Bridge</div>
  <div class="tab" onclick="switchTab('chat',this)" style="color:var(--accent);font-weight:600">💬 Chat</div>
</div>

<!-- 概覽 -->
<div id="pane-overview" class="pane active">
  <div class="stats" id="stats"></div>
  <div class="card" style="margin-bottom:16px">
    <h2>Provider 分布</h2>
    <div id="provider-dist" style="font-size:0.82rem;padding:4px 0;color:#ccc"></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2>Bot 狀態</h2>
    <div id="status-grid" class="stats" style="margin-bottom:0"></div>
  </div>
  <div class="grid">
    <div class="card"><h2>每日 Token 用量（含 Cache）</h2><canvas id="tokenChart"></canvas></div>
    <div class="card"><h2>CE 壓縮效果</h2><canvas id="ceChart"></canvas></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>最近 Turns</h2>
    <div id="turns"></div>
  </div>
</div>

<!-- Sessions -->
<div id="pane-sessions" class="pane">
  <div class="card">
    <h2>Sessions（最近 50）<span style="float:right;display:inline-flex;gap:6px"><button class="btn btn-sm" onclick="purgeExpiredSessions()">🧹 Purge Expired</button><button class="btn btn-sm" onclick="loadSessions()">↻</button></span></h2>
    <div id="sessions-list"></div>
  </div>
</div>

<!-- Inbound History -->
<div id="pane-inbound" class="pane">
  <div class="card">
    <h2>Inbound History（未消費）<span style="float:right;display:inline-flex;gap:6px"><button class="btn btn-sm btn-red" onclick="clearAllInbound()">🗑 全部清除</button><button class="btn btn-sm" onclick="loadInboundHistory()">↻</button></span></h2>
    <div id="inbound-list" style="font-size:0.8rem;color:var(--fg2)">按 ↻ 載入</div>
  </div>
</div>

<!-- 日誌 -->
<div id="pane-logs" class="pane">
  <div class="card">
    <h2>PM2 日誌（即時串流）
      <button class="btn btn-sm" style="float:right" onclick="connectLogStream()">↻ 重新連線</button>
    </h2>
    <textarea id="log-area" rows="30" readonly></textarea>
  </div>
</div>

<!-- 操作 -->
<div id="pane-ops" class="pane">
  <div class="grid">
    <div class="card">
      <h2>Bot 控制</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-red" onclick="doRestart()">⟳ 重啟 Bot</button>
      </div>
      <div id="ops-msg" class="msg"></div>
    </div>
    <div class="card">
      <h2>Active Subagents</h2>
      <div id="subagents-list"></div>
    </div>
  </div>
</div>

<!-- 排程 -->
<div id="pane-cron" class="pane">
  <div class="card">
    <h2>Cron Jobs
      <button class="btn btn-sm" style="float:right;margin-left:4px" onclick="showCronAdd()">+ 新增</button>
      <button class="btn btn-sm" style="float:right" onclick="loadCron()">↻</button>
    </h2>
    <div id="cron-msg" class="msg"></div>
    <div id="cron-list"><p style="color:#888;font-size:0.8rem">載入中...</p></div>
  </div>
  <div id="cron-add-panel" class="card" style="margin-top:16px;display:none">
    <h2>新增 Job（JSON）</h2>
    <p style="font-size:0.72rem;color:#888;margin-bottom:6px">格式：{"name":"...","schedule":{"kind":"cron","expr":"0 9 * * *"},"action":{"type":"message","channelId":"...","text":"..."}}</p>
    <textarea id="cron-add-json" rows="8" placeholder='{"name":"my-job","enabled":true,"schedule":{"kind":"cron","expr":"0 9 * * *"},"action":{"type":"message","channelId":"CHANNEL_ID","text":"hello"}}'></textarea>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-green" onclick="addCronJob()">新增</button>
      <button class="btn" onclick="hideCronAdd()">取消</button>
    </div>
  </div>
</div>

<!-- Traces（全域搜尋） -->
<div id="pane-traces" class="pane">
  <div class="card">
    <h2>Message Lifecycle Traces（全域）
      <button class="btn btn-sm" style="float:right" onclick="loadTraces()">↻</button>
      <input id="trace-agent-filter" placeholder="Agent ID" style="float:right;margin-right:8px;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;width:100px;font-size:0.78rem" oninput="loadTraces()">
      <select id="trace-status-filter" style="float:right;margin-right:8px;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:0.78rem" onchange="loadTraces()">
        <option value="">Status: All</option>
        <option value="completed">✅ completed</option>
        <option value="in_progress">⏳ in_progress</option>
        <option value="aborted">⏹ aborted</option>
        <option value="error">❌ error</option>
      </select>
      <select id="trace-category-filter" style="float:right;margin-right:8px;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:0.78rem" onchange="loadTraces()">
        <option value="">Category: All</option>
        <option value="discord">discord</option>
        <option value="subagent">subagent</option>
        <option value="cron">cron</option>
        <option value="api">api</option>
      </select>
      <select id="trace-ce-filter" style="float:right;margin-right:8px;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:0.78rem" onchange="loadTraces()">
        <option value="">CE: All</option>
        <option value="any">CE: Any triggered</option>
        <option value="decay">CE: decay</option>
        <option value="compaction">CE: compaction</option>
        <option value="overflow-hard-stop">CE: overflow</option>
      </select>
      <select id="trace-limit" style="float:right;margin-right:8px;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:2px 6px;border-radius:4px" onchange="loadTraces()">
        <option value="20">20</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
      </select>
    </h2>
    <div id="trace-list" style="margin-top:8px"></div>
  </div>
</div>

<!-- Trace Detail（全域共用，任何 tab 都能開啟） -->
<div class="card" style="margin:0 20px 20px;display:none" id="trace-detail-card">
  <h2>Trace Detail <span id="trace-detail-id" style="font-size:0.8em;color:var(--fg2)"></span>
    <button class="btn btn-sm" style="float:right" onclick="document.getElementById('trace-detail-card').style.display='none'">✕ 關閉</button>
  </h2>
  <div id="trace-detail"></div>
</div>

<!-- Tasks -->
<div id="pane-tasks" class="pane">
  <div class="card">
    <h2>Tasks
      <button class="btn btn-sm" style="float:right" onclick="loadTasks()">↻ 重新載入</button>
    </h2>
    <div id="tasks-list" style="font-size:0.82rem;color:#ccc">載入中...</div>
  </div>
</div>

<!-- Auth Profiles & Models -->
<div id="pane-auth" class="pane">
  <div class="card">
    <h2>模型設定（models-config.json）
      <button class="btn btn-sm" style="float:right" onclick="loadModelsConfig()">↻ 重新載入</button>
    </h2>
    <div id="models-config-msg" class="msg"></div>
    <div id="models-config-panel" style="margin-top:8px">載入中...</div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>Auth Profiles（憑證管理）
      <button class="btn btn-sm" style="float:right" onclick="loadAuthProfiles()">↻ 讀取</button>
    </h2>
    <div id="auth-msg" class="msg"></div>
    <div id="auth-creds"></div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2d3e">
      <h3 style="font-size:0.82rem;color:#818cf8;margin-bottom:8px">新增憑證</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="auth-new-provider" onchange="onAuthProviderChange()" style="flex:0 0 130px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem">
          <option value="anthropic">Anthropic</option>
          <option value="openai-codex">OpenAI Codex</option>
          <option value="ollama">Ollama</option>
        </select>
        <span id="auth-apikey-fields" style="display:contents">
          <input id="auth-new-id" placeholder="名稱（如 key-1）" style="flex:0 0 120px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
          <select id="auth-new-type" style="flex:0 0 100px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem">
            <option value="api_key">API Key</option>
            <option value="token">Token</option>
          </select>
          <input id="auth-new-cred" type="password" placeholder="Token / API Key" style="flex:1;min-width:200px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
          <button class="btn btn-green btn-sm" onclick="addAuthProfile()">+ 新增</button>
        </span>
        <span id="auth-oauth-fields" style="display:none">
          <input id="auth-oauth-id" placeholder="名稱（如 default）" value="default" style="flex:0 0 120px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
          <select id="auth-oauth-type" style="flex:0 0 100px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem">
            <option value="token">Token</option>
            <option value="api_key">API Key</option>
          </select>
          <button class="btn btn-green btn-sm" onclick="startCodexOAuth()">OpenAI OAuth 登入</button>
          <span id="codex-oauth-status" style="font-size:0.78rem;color:#888;margin-left:8px"></span>
          <div id="codex-oauth-manual" style="display:none;margin-top:8px;width:100%">
            <p style="font-size:0.75rem;color:#facc15;margin:0 0 4px">瀏覽器登入完成後，若未自動跳轉回來，請複製網址列的 callback URL 貼到下方：</p>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="codex-oauth-url" placeholder="http://localhost:1455/callback?code=..." style="flex:1;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
              <button class="btn btn-green btn-sm" onclick="submitCodexCallback()">送出</button>
            </div>
          </div>
        </span>
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>Provider 狀態（Cooldown / Round-Robin）</h2>
    <div id="auth-statuses"></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>models.json（唯讀）
      <button class="btn btn-sm" style="float:right" onclick="loadModelsJson()">↻ 讀取</button>
    </h2>
    <div id="models-json-viewer" style="font-size:0.75rem;color:#888">點擊「讀取」載入</div>
  </div>
</div>

<!-- Config -->
<div id="pane-config" class="pane">
  <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
    <button class="btn" onclick="loadCfg()">↻ 讀取</button>
    <button class="btn btn-green" onclick="saveCfg()">💾 備份後儲存</button>
    <div id="cfg-msg" class="msg" style="flex:1"></div>
    <p style="font-size:0.72rem;color:var(--fg3);margin:0">🔒 敏感欄位顯示 ***，儲存時自動保留原值</p>
  </div>
  <div id="cfg-gui"></div>
</div>

<!-- Chat -->
<!-- Memory -->
<div id="pane-memory" class="pane">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <!-- Stats Panel -->
    <div class="card">
      <h3 style="margin:0 0 8px">統計</h3>
      <div id="mem-stats">載入中...</div>
    </div>
    <!-- Recall Tester -->
    <div class="card">
      <h3 style="margin:0 0 8px">Recall 測試</h3>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input id="mem-recall-input" type="text" placeholder="輸入查詢 prompt..." style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem" onkeydown="if(event.key==='Enter')testMemRecall()">
        <button class="btn btn-green btn-sm" onclick="testMemRecall()">測試</button>
      </div>
      <div id="mem-recall-result" style="font-size:0.82rem;max-height:300px;overflow-y:auto"></div>
    </div>
  </div>
  <!-- Atom Browser -->
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 style="margin:0">Atom 列表</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="mem-filter" type="text" placeholder="搜尋..." style="padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem;width:180px" oninput="filterMemAtoms()">
        <select id="mem-sort" style="padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem" onchange="sortMemAtoms()">
          <option value="name">名稱</option>
          <option value="confirmations">Confirmations ↓</option>
          <option value="lastUsed">Last Used ↓</option>
          <option value="confidence">Confidence</option>
        </select>
      </div>
    </div>
    <div id="mem-atoms" style="max-height:500px;overflow-y:auto">載入中...</div>
  </div>
  <!-- Atom Detail Modal -->
  <div id="mem-detail" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:100;display:none;align-items:center;justify-content:center" onclick="if(event.target===this)closeMemDetail()">
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:700px;width:90%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 id="mem-detail-title" style="margin:0"></h3>
        <button class="btn btn-sm" onclick="closeMemDetail()">✕</button>
      </div>
      <pre id="mem-detail-content" style="white-space:pre-wrap;font-size:0.82rem;background:var(--bg2);padding:12px;border-radius:8px;max-height:50vh;overflow-y:auto"></pre>
      <div id="mem-detail-meta" style="font-size:0.78rem;color:var(--fg2);margin-top:8px"></div>
    </div>
  </div>
</div>

<!-- Pipeline -->
<div id="pane-pipeline" class="pane">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <!-- 監控區：Ollama 狀態 -->
    <div class="card">
      <h3 style="margin:0 0 8px">Ollama 狀態</h3>
      <div id="pl-ollama-status">載入中...</div>
    </div>
    <!-- 監控區：Pipeline 設定 -->
    <div class="card">
      <h3 style="margin:0 0 8px">Pipeline 設定</h3>
      <div id="pl-pipeline-cfg">載入中...</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <!-- 監控區：Vector DB -->
    <div class="card">
      <h3 style="margin:0 0 8px">Vector DB</h3>
      <div id="pl-vector-stats">載入中...</div>
      <button class="btn btn-green btn-sm" style="margin-top:8px" onclick="pipelineResync()">🔄 Vector Resync</button>
      <div id="pl-resync-result" style="font-size:0.82rem;margin-top:8px"></div>
    </div>
    <!-- 操作區：Embedding 切換 -->
    <div class="card">
      <h3 style="margin:0 0 8px">Embedding Model 切換</h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <select id="pl-embed-select" style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem"></select>
        <button class="btn btn-sm" onclick="pipelineSwitchEmbed()">套用</button>
      </div>
      <div id="pl-embed-msg" style="font-size:0.82rem"></div>
    </div>
    <!-- 操作區：Extract Model 切換 -->
    <div class="card">
      <h3 style="margin:0 0 8px">Extract Model 切換</h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <select id="pl-extract-select" style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem"></select>
        <button class="btn btn-sm" onclick="pipelineSwitchExtract()">套用</button>
      </div>
      <div id="pl-extract-msg" style="font-size:0.82rem"></div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <!-- 操作區：Ollama 模型管理 -->
    <div class="card">
      <h3 style="margin:0 0 8px">Ollama 模型管理</h3>
      <div id="pl-models-list" style="max-height:300px;overflow-y:auto;font-size:0.82rem;margin-bottom:8px">載入中...</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="pl-pull-input" type="text" placeholder="模型名稱（如 qwen3:8b）" style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem">
        <button class="btn btn-green btn-sm" onclick="pipelinePullModel()">Pull</button>
      </div>
      <div id="pl-pull-msg" style="font-size:0.82rem;margin-top:8px"></div>
    </div>
    <!-- 操作區：Recall Test -->
    <div class="card">
      <h3 style="margin:0 0 8px">Recall Test</h3>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input id="pl-recall-input" type="text" placeholder="輸入查詢..." style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem" onkeydown="if(event.key==='Enter')pipelineRecallTest()">
        <button class="btn btn-green btn-sm" onclick="pipelineRecallTest()">測試</button>
      </div>
      <div id="pl-recall-result" style="font-size:0.82rem;max-height:350px;overflow-y:auto"></div>
    </div>
  </div>
</div>

<!-- CLI Bridge -->
<div id="pane-clibridge" class="pane">
  <div class="card" style="margin-bottom:12px">
    <h2>設定 <span style="font-size:0.72rem;color:var(--fg3)">cli-bridges.json</span>
      <button class="btn btn-sm" onclick="cbLoadConfig()" style="float:right;margin-left:6px">↻ 重載</button>
      <button class="btn btn-sm btn-green" onclick="cbSaveConfig()" style="float:right;margin-left:6px">💾 儲存</button>
      <button class="btn btn-sm" onclick="cbAddBridge()" style="float:right">+ 新增 Bridge</button>
    </h2>
    <div id="cb-config-forms"></div>
    <div id="cb-config-msg" style="font-size:0.78rem;margin-top:6px;color:var(--fg3)"></div>
  </div>
  <div class="card" style="margin-bottom:12px">
    <h2>CLI Bridge 總覽 <button class="btn btn-sm" onclick="loadCliBridges()" style="float:right">↻</button></h2>
    <div id="cb-list" style="font-size:0.82rem;color:var(--fg2)">載入中...</div>
  </div>
  <div id="cb-detail" style="display:none">
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div class="card">
        <h2 id="cb-detail-title">Bridge</h2>
        <div id="cb-detail-info" style="font-size:0.82rem"></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="cbInterrupt()">⏸ 中斷</button>
          <button class="btn btn-sm btn-red" onclick="cbRestart()">⟳ 重啟</button>
          <button class="btn btn-sm" onclick="cbExport()">📥 匯出</button>
          <button class="btn btn-sm" onclick="cbLoadStatus()">↻ 刷新</button>
        </div>
      </div>
      <div class="card">
        <h2>Console</h2>
        <div style="display:flex;gap:8px">
          <input id="cb-console-input" type="text" placeholder="送出訊息..." style="flex:1;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.85rem" onkeydown="if(event.key==='Enter')cbSendConsole()">
          <button class="btn btn-green btn-sm" onclick="cbSendConsole()">送出</button>
        </div>
        <div id="cb-console-msg" style="font-size:0.78rem;margin-top:6px;color:var(--fg3)"></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <h2>即時日誌 <span id="cb-stream-status" style="font-size:0.72rem;color:var(--fg3)"></span></h2>
      <div id="cb-log-stream" style="max-height:300px;overflow-y:auto;font-size:0.78rem;font-family:monospace;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;white-space:pre-wrap;word-break:break-all"></div>
    </div>
    <div class="card">
      <h2>Turn 歷程 <button class="btn btn-sm" onclick="cbLoadTurns()" style="float:right">↻</button></h2>
      <div id="cb-turns" style="font-size:0.82rem"></div>
    </div>
  </div>
</div>

<div id="pane-chat" class="pane">
  <div style="display:flex;flex-direction:column;height:calc(100vh - 140px)">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <label style="font-size:0.78rem;color:var(--fg2)">Session:</label>
      <select id="chat-session" style="flex:1;max-width:300px;padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem">
        <option value="">（新 Session）</option>
      </select>
      <button class="btn btn-sm" onclick="refreshChatSessions()" title="重新整理 session 列表">🔄</button>
      <button class="btn btn-sm btn-red" onclick="clearChatSession()">🗑 清除</button>
      <span id="chat-status" style="font-size:0.72rem;color:var(--fg3)">就緒</span>
    </div>
    <div id="chat-messages" style="flex:1;overflow-y:auto;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;font-size:0.85rem;line-height:1.6">
      <div style="color:var(--fg3);text-align:center;padding:40px 0">在下方輸入訊息開始對話</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <textarea id="chat-input" rows="2" placeholder="輸入訊息..." style="flex:1;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:0.85rem;resize:vertical;font-family:inherit" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendChat()}"></textarea>
      <button class="btn btn-green" onclick="sendChat()" style="align-self:flex-end;height:38px;padding:0 20px">送出</button>
    </div>
  </div>
</div>

<script>
// ── Theme + Font Scale ──────────────────────────────────────────────────────
function setFontScale(v) {
  document.documentElement.style.setProperty('--font-scale', v);
  document.getElementById('font-pct').textContent = Math.round(v * 100) + '%';
  localStorage.setItem('cc-font-scale', v);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? '' : 'light';
  if (next) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  document.getElementById('theme-btn').textContent = next === 'light' ? '🌙 Dark' : '☀️ Light';
  localStorage.setItem('cc-theme', next || 'dark');
}
(function initPrefs() {
  const t = localStorage.getItem('cc-theme');
  if (t === 'light') { document.documentElement.setAttribute('data-theme', 'light'); document.getElementById('theme-btn').textContent = '🌙 Dark'; }
  const f = localStorage.getItem('cc-font-scale');
  if (f) { document.getElementById('font-slider').value = f; setFontScale(f); }
})();

let tokenChart, ceChart;
let logTimer = null;
let logES = null;

// ── Auth token（從 URL query param 提取，自動附加到所有 fetch）──
const _urlParams = new URLSearchParams(window.location.search);
const _authToken = _urlParams.get('token') || '';
function authFetch(url, opts) {
  const sep = url.includes('?') ? '&' : '?';
  const authUrl = _authToken ? url + sep + 'token=' + encodeURIComponent(_authToken) : url;
  return fetch(authUrl, opts);
}

function fmtK(n) { return n >= 10000 ? (n/1000).toFixed(1)+'k' : n.toLocaleString(); }
function fmtCache(r, w) {
  if (!r && !w) return '-';
  return \`📖\${fmtK(r||0)} / ✏️\${fmtK(w||0)}\`;
}

let _traceAutoRefresh = null;
let _sessAutoRefresh = null;
let _cbAutoRefresh = null;
function switchTab(id, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pane-' + id).classList.add('active');
  // 切換 tab 時隱藏 trace detail
  const detailCard = document.getElementById('trace-detail-card');
  if (detailCard) detailCard.style.display = 'none';
  // 自動刷新：進入對應 tab 啟動，離開停止
  if (_traceAutoRefresh) { clearInterval(_traceAutoRefresh); _traceAutoRefresh = null; }
  if (_sessAutoRefresh) { clearInterval(_sessAutoRefresh); _sessAutoRefresh = null; }
  if (_cbAutoRefresh) { clearInterval(_cbAutoRefresh); _cbAutoRefresh = null; }
  if (id === 'sessions') { loadSessions(); _sessAutoRefresh = setInterval(loadSessions, 10000); }
  if (id === 'inbound') { loadInboundHistory(); }
  if (id === 'chat') { refreshChatSessions(); }
  if (id === 'logs') connectLogStream();
  if (id !== 'logs') disconnectLogStream();
  if (id === 'ops') { loadSubagents(); }
  if (id === 'tasks') { loadTasks(); }
  if (id === 'auth') { loadModelsConfig(); loadAuthProfiles(); }
  if (id === 'traces') { loadTraces(); _traceAutoRefresh = setInterval(loadTraces, 5000); }
  if (id === 'cron') loadCron();
  if (id === 'config') loadCfg();
  if (id === 'memory') loadMemory();
  if (id === 'pipeline') loadPipeline();
  if (id === 'clibridge') { cbLoadConfig(); loadCliBridges(); _cbAutoRefresh = setInterval(() => { loadCliBridges(); if (_cbSelectedLabel) cbLoadStatus(); }, 10000); }
  if (id !== 'clibridge') cbDisconnectStream();
}

function refreshAll() { loadOverview(); loadStatus(); }

// ── 概覽 ─────────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await authFetch('/api/status').then(r => r.json());
    document.getElementById('status-grid').innerHTML = [
      ['Uptime', d.uptimeStr], ['Memory', d.memoryMB + ' MB'],
      ['Heap', d.heapUsedMB + ' MB'], ['PID', d.pid],
      ['Config 目錄', d.configDir || '(未設定)'], ['工作目錄', d.workspace || '(未設定)'],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val" style="font-size:\${String(v).length > 20 ? '0.7rem' : '1rem'}">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');
  } catch {}
}

async function loadOverview() {
  try {
    const d = await authFetch('/api/usage').then(r => r.json());
    document.getElementById('stats').innerHTML = [
      ['合計 Tokens', (d.totalTokens||0).toLocaleString()],
      ['輸入', (d.totalInput||0).toLocaleString()],
      ['輸出', (d.totalOutput||0).toLocaleString()],
      ['📖 Cache Read', fmtK(d.totalCacheRead||0)],
      ['✏️ Cache Write', fmtK(d.totalCacheWrite||0)],
      ['CE 觸發', d.ceTriggers||0],
      ['平均省 Tokens', (d.avgTokensSaved||0).toLocaleString()],
      ['Turns', d.totalTurns||0],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');

    // Provider 分布
    const pc = d.providerCounts || {};
    const provHtml = Object.entries(pc).map(([k,v]) =>
      \`<span style="margin-right:12px"><b>\${k}</b> \${v.turns}t ↑\${v.input.toLocaleString()}/↓\${v.output.toLocaleString()}</span>\`
    ).join('');
    const provEl = document.getElementById('provider-dist');
    if (provEl) provEl.innerHTML = provHtml || '<span style="color:#888">無資料</span>';

    const labels = d.daily.map(x => x.date.slice(5));
    if (tokenChart) tokenChart.destroy();
    tokenChart = new Chart(document.getElementById('tokenChart'), {
      type:'bar', data:{ labels, datasets:[
        {label:'輸入',data:d.daily.map(x=>x.input),backgroundColor:'#4c1d95'},
        {label:'輸出',data:d.daily.map(x=>x.output),backgroundColor:'#1d4ed8'},
        {label:'📖 Cache Read',data:d.daily.map(x=>x.cacheRead||0),backgroundColor:'#0d9488'},
        {label:'✏️ Cache Write',data:d.daily.map(x=>x.cacheWrite||0),backgroundColor:'#d97706'},
      ]},
      options:{responsive:true,scales:{x:{stacked:true},y:{stacked:true}},plugins:{legend:{labels:{color:'#ccc'}}}},
    });

    if (ceChart) ceChart.destroy();
    ceChart = new Chart(document.getElementById('ceChart'), {
      type:'bar', data:{labels,datasets:[{label:'省 Tokens',data:d.daily.map(x=>x.ceTokensSaved),backgroundColor:'#065f46'}]},
      options:{responsive:true,plugins:{legend:{labels:{color:'#ccc'}}}},
    });

    const rows = (d.recentTurns||[]).map(e => {
      const ts = new Date(e.ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const inp = e.totalInputTokens != null ? e.totalInputTokens.toLocaleString() : '-';
      const out = (e.totalOutputTokens??0).toLocaleString();
      const cache = fmtCache(e.totalCacheRead, e.totalCacheWrite);
      const dur = e.totalDurationMs != null ? \`\${(e.totalDurationMs/1000).toFixed(1)}s\` : '-';
      const sk = (e.sessionKey||e.channelId||'').slice(-16);
      const firstCall = (e.llmCalls||[])[0];
      const mdl = firstCall?.model ? \`<span title="\${firstCall.model}">\${firstCall.model.length>18?firstCall.model.slice(0,18)+'…':firstCall.model}</span>\` : '-';
      const prov = firstCall?.provider || '-';
      const cat = e.category ? \`<span style="font-size:0.7rem;opacity:0.6">[\${e.category}]</span> \` : '';
      const ceStrats = e.contextEngineering?.strategiesApplied || [];
      const cost = e.estimatedCostUsd != null ? \`$\${e.estimatedCostUsd.toFixed(4)}\` : '-';
      return \`<tr><td>\${ts}</td><td title="\${e.sessionKey||e.channelId}">\${cat}\${sk}</td><td>\${prov}</td><td>\${mdl}</td><td>↑\${inp}</td><td>↓\${out}</td><td>\${cache}</td><td>\${ceStrats.join('+')||'-'}</td><td>\${cost}</td><td>\${dur}</td></tr>\`;
    }).join('');
    document.getElementById('turns').innerHTML =
      \`<table class="tbl"><thead><tr><th>時間</th><th>Session</th><th>Provider</th><th>Model</th><th>輸入</th><th>輸出</th><th>Cache</th><th>CE</th><th>Cost</th><th>耗時</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { console.error(e); }
}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const d = await authFetch('/api/sessions').then(r => r.json());
    if (!d.sessions?.length) { document.getElementById('sessions-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無資料</p>'; return; }
    // 記住展開狀態（skId → sessionKey）
    const expandedMap = new Map();
    document.querySelectorAll('.sess-expand').forEach(r => {
      if (r.style.display !== 'none') {
        const skId = r.id.replace('row-', '');
        // 從 header row 的 onclick 取 sessionKey
        const hdr = r.previousElementSibling;
        const m = hdr?.getAttribute('onclick')?.match(/toggleSessionRow\\(this,'([^']+)'/);
        if (m) expandedMap.set(skId, m[1]);
      }
    });
    const rows = d.sessions.map(s => {
      const last = new Date(s.lastTs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const tok = \`↑\${s.inputTokens.toLocaleString()}/↓\${s.outputTokens.toLocaleString()}\`;
      const cache = fmtCache(s.cacheRead, s.cacheWrite);
      const provs = (s.providers||[]).join(', ') || '-';
      const mdls = (s.models||[]).map(m => m.length>20?m.slice(0,20)+'…':m).join(', ') || '-';
      const skId = 'sess-' + s.sessionKey.replace(/[^a-zA-Z0-9]/g, '_');
      const colCount = 8;
      const sk = s.sessionKey.replace(/'/g, "\\\\'");
      const acts = \`<span style="display:inline-flex;gap:4px"><button class="btn btn-sm" onclick="event.stopPropagation();sessAction('clear','\${sk}')" title="清空訊息">🗑 Clear</button><button class="btn btn-sm" onclick="event.stopPropagation();sessAction('compact','\${sk}')" title="強制 CE 壓縮">📦 Compact</button><button class="btn-danger" onclick="event.stopPropagation();sessAction('delete','\${sk}')" title="刪除 session">✕</button></span>\`;
      return \`<tr style="cursor:pointer" onclick="toggleSessionRow(this,'\${s.sessionKey}','\${skId}')"><td title="\${s.sessionKey}">\${s.sessionKey.slice(-24)}</td><td>\${last}</td><td>\${s.turns}</td><td>\${tok}</td><td>\${cache}</td><td title="\${mdls}">\${provs}</td><td>\${s.ceTriggers}</td><td>\${acts}</td></tr>
<tr class="sess-expand" id="row-\${skId}" style="display:none"><td colspan="\${colCount}" style="padding:8px 12px;background:var(--bg4)"><div id="\${skId}" style="font-size:0.8rem;color:var(--fg2)">載入 traces…</div></td></tr>\`;
    }).join('');
    document.getElementById('sessions-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Session</th><th>最後活躍</th><th>Turns</th><th>Tokens</th><th>Cache</th><th>Provider</th><th>CE</th><th>操作</th></tr></thead><tbody>\${rows}</tbody></table>\`;
    // 恢復展開狀態 + 重新載入 traces
    expandedMap.forEach((sessionKey, skId) => {
      const expandRow = document.getElementById('row-' + skId);
      const headerRow = expandRow?.previousElementSibling;
      if (expandRow) {
        expandRow.style.display = '';
        if (headerRow) headerRow.style.background = 'var(--bg3)';
        loadSessionTraces(sessionKey, skId);
      }
    });
  } catch(e) { document.getElementById('sessions-list').innerHTML = '讀取失敗：' + e; }
}

function toggleSessionRow(headerRow, sessionKey, skId) {
  const expandRow = document.getElementById('row-' + skId);
  if (!expandRow) return;
  const isOpen = expandRow.style.display !== 'none';
  if (isOpen) {
    expandRow.style.display = 'none';
    headerRow.style.background = '';
  } else {
    expandRow.style.display = '';
    headerRow.style.background = 'var(--bg3)';
    loadSessionTraces(sessionKey, skId);
  }
}

async function loadSessionTraces(sessionKey, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    // 同時 fetch live + history，合併去重
    const [liveRes, histRes] = await Promise.all([
      authFetch('/api/traces/live').then(r => r.json()),
      authFetch('/api/traces?limit=50&sessionKey=' + encodeURIComponent(sessionKey)).then(r => r.json()),
    ]);
    const liveTraces = (liveRes.traces || []).filter(t => t.sessionKey === sessionKey);
    const histTraces = histRes.traces || [];
    const seenIds = new Set();
    const traces = [];
    for (const t of liveTraces) { seenIds.add(t.traceId); traces.push(t); }
    for (const t of histTraces) { if (!seenIds.has(t.traceId)) traces.push(t); }

    if (!traces.length) { el.innerHTML = '<div style="color:var(--fg2)">此 session 無 trace 記錄</div>'; return; }
    let html = '<table class="tbl"><thead><tr><th>時間</th><th>Duration</th><th>↑ Eff</th><th>↓ Out</th><th>Cache</th><th>Tools</th><th>LLM</th><th>Cost</th><th>Status</th><th>Preview</th><th></th></tr></thead><tbody>';
    for (const t of traces) {
      const ts = new Date(t.ts).toLocaleTimeString('zh-TW', {hour12:false});
      const dur = t.totalDurationMs ? (t.totalDurationMs/1000).toFixed(1)+'s' : '-';
      const isLive = t.status === 'in_progress';
      const statusIcon = isLive ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'aborted' ? '⏹' : '❌';
      const cost = t.estimatedCostUsd ? '$' + t.estimatedCostUsd.toFixed(4) : '-';
      const prev = (t.inbound?.textPreview ?? '').slice(0, 30);
      const liveStyle = isLive ? 'background:rgba(255,200,0,0.08);' : '';
      html += '<tr style="' + liveStyle + '">';
      html += '<td>' + ts + '</td>';
      html += '<td>' + dur + '</td>';
      html += '<td>' + (t.effectiveInputTokens ?? t.totalInputTokens ?? 0).toLocaleString() + '</td>';
      html += '<td>' + (t.totalOutputTokens ?? 0).toLocaleString() + '</td>';
      html += '<td style="color:var(--fg2)">' + (t.totalCacheRead??0).toLocaleString() + '/' + (t.totalCacheWrite??0).toLocaleString() + '</td>';
      html += '<td>' + (t.totalToolCalls ?? 0) + '</td>';
      html += '<td>' + (t.llmCalls?.length ?? 0) + '</td>';
      html += '<td style="color:var(--warn)">' + cost + '</td>';
      html += '<td>' + statusIcon + '</td>';
      html += '<td style="color:var(--fg2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + prev + '</td>';
      html += '<td><a href="#" style="color:var(--accent);text-decoration:none;font-size:0.78rem" onclick="event.preventDefault();showTraceDetail(\\'' + t.traceId + '\\')">📋 詳情</a></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '載入失敗：' + e; }
}

// ── Session 操作 ────────────────────────────────────────────────────────────
async function sessAction(action, sessionKey) {
  const labels = { clear: '清空訊息', compact: '壓縮', delete: '刪除' };
  if (action === 'delete' && !confirm('確定刪除 session ' + sessionKey.slice(-24) + '？')) return;
  try {
    const r = await authFetch('/api/sessions/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    });
    const d = await r.json();
    if (d.success) {
      let msg = labels[action] + ' 成功';
      if (d.clearedMessages != null) msg += '（' + d.clearedMessages + ' 條訊息, ' + (d.tracesDeleted||0) + ' 筆 trace）';
      if (d.strategies?.length) msg += '（策略：' + d.strategies.join(', ') + '）';
      alert(msg);
      loadSessions();
    } else {
      alert('失敗：' + (d.error || '未知錯誤'));
    }
  } catch(e) { alert('錯誤：' + e); }
}

async function purgeExpiredSessions() {
  if (!confirm('確定清除所有過期 session？')) return;
  try {
    const r = await authFetch('/api/sessions/purge-expired', { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      alert('已清除 ' + d.purgedCount + ' 個過期 session');
      loadSessions();
    } else {
      alert('失敗：' + (d.error || '未知錯誤'));
    }
  } catch(e) { alert('錯誤：' + e); }
}

// ── Inbound History ─────────────────────────────────────────────────────────
async function loadInboundHistory() {
  const el = document.getElementById('inbound-list');
  try {
    const d = await authFetch('/api/inbound-history').then(r => r.json());
    const channels = d.channels || [];
    if (!channels.length) { el.innerHTML = '<p style="color:#888">無 pending entries</p>'; return; }
    let html = '<table class="tbl"><thead><tr><th>Channel</th><th>Pending</th><th>最新</th><th></th></tr></thead><tbody>';
    for (const ch of channels) {
      const chD = new Date(ch.lastTs);
      const ts = chD.toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) + '.' + String(chD.getMilliseconds()).padStart(3,'0');
      html += '<tr>';
      html += '<td title="' + ch.channelId + '">' + ch.channelId.slice(-12) + '</td>';
      html += '<td>' + ch.count + '</td>';
      html += '<td>' + ts + '</td>';
      html += '<td><a href="#" style="color:var(--accent);text-decoration:none;font-size:0.78rem" onclick="event.preventDefault();expandInbound(\\'' + ch.channelId + '\\',this.closest(\\'tr\\'))">展開</a> <a href="#" style="color:var(--red2);text-decoration:none;font-size:0.78rem;margin-left:6px" onclick="event.preventDefault();clearInbound(\\'' + ch.channelId + '\\')">清除</a></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '載入失敗：' + e; }
}

async function expandInbound(channelId, row) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('inbound-expand')) {
    existing.remove(); return;
  }
  try {
    const d = await authFetch('/api/inbound-history?channelId=' + encodeURIComponent(channelId)).then(r => r.json());
    const entries = d.entries || [];
    let html = '<td colspan="4" style="padding:8px 12px;background:var(--bg4);font-size:0.78rem">';
    if (!entries.length) { html += '無 entries'; }
    else {
      html += '<div style="max-height:200px;overflow-y:auto">';
      for (const e of entries) {
        const d = new Date(e.ts);
        const ts = d.toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) + '.' + String(d.getMilliseconds()).padStart(3,'0');
        html += '<div style="margin:2px 0"><span style="color:var(--fg2)">' + ts + '</span> <b>' + (e.authorName||'?') + '</b>: ' + (e.content||'').slice(0,120) + '</div>';
      }
      html += '</div>';
    }
    html += '</td>';
    const tr = document.createElement('tr');
    tr.className = 'inbound-expand';
    tr.innerHTML = html;
    row.after(tr);
  } catch(e) { alert('載入失敗：' + e); }
}

async function clearInbound(channelId) {
  if (!confirm('清除 channel ' + channelId.slice(-12) + ' 的 inbound entries？')) return;
  try {
    const r = await authFetch('/api/inbound-history/clear', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ channelId }),
    });
    const d = await r.json();
    if (d.success) { alert('已清除 ' + d.cleared + ' 筆'); loadInboundHistory(); }
    else alert('失敗：' + (d.error||''));
  } catch(e) { alert('錯誤：' + e); }
}

async function clearAllInbound() {
  if (!confirm('清除所有 channel 的 inbound entries？')) return;
  try {
    const r = await authFetch('/api/inbound-history/clear', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({}),
    });
    const d = await r.json();
    if (d.success) { alert('已清除 ' + d.cleared + ' 筆'); loadInboundHistory(); }
    else alert('失敗：' + (d.error||''));
  } catch(e) { alert('錯誤：' + e); }
}

// ── 日誌（SSE 即時串流）──────────────────────────────────────────────────────
function connectLogStream() {
  if (logES) { logES.close(); logES = null; }
  const el = document.getElementById('log-area');
  el.value = '連線中...';
  logES = new EventSource('/api/logs/stream' + (_authToken ? '?token=' + encodeURIComponent(_authToken) : ''));
  logES.onmessage = function(e) {
    const data = JSON.parse(e.data);
    if (typeof data === 'string' && data.includes('\\n')) {
      // 初始整包
      el.value = data;
    } else {
      // 增量行
      el.value += '\\n' + data;
      // 限制顯示行數避免 DOM 過大
      const lines = el.value.split('\\n');
      if (lines.length > 2000) el.value = lines.slice(-1500).join('\\n');
    }
    el.scrollTop = el.scrollHeight;
  };
  logES.onerror = function() {
    el.value += '\\n[SSE 斷線，3 秒後重連...]';
  };
}
function disconnectLogStream() {
  if (logES) { logES.close(); logES = null; }
}
// 相容舊按鈕
async function loadLogs() { connectLogStream(); }
function startLogRefresh() { connectLogStream(); }

// ── 操作 ─────────────────────────────────────────────────────────────────────
async function doRestart() {
  if (!confirm('確定重啟 Bot？')) return;
  try {
    const d = await authFetch('/api/restart', {method:'POST'}).then(r => r.json());
    const el = document.getElementById('ops-msg');
    el.className = 'msg ' + (d.success ? 'ok' : 'err');
    el.textContent = d.success ? '✓ 重啟信號已送出' : '錯誤：' + d.error;
  } catch(e) { const el = document.getElementById('ops-msg'); el.className='msg err'; el.textContent='失敗：'+e; }
}

async function loadSubagents() {
  try {
    const d = await authFetch('/api/subagents').then(r => r.json());
    if (!d.subagents?.length) { document.getElementById('subagents-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無 subagent 記錄</p>'; return; }
    const rows = d.subagents.slice(0, 30).map(s => {
      const badge = s.status === 'running' ? 'badge-run' : s.status === 'completed' ? 'badge-done' : 'badge-err';
      const dur = s.endedAt ? ((s.endedAt - s.createdAt)/1000).toFixed(1)+'s' : s.status === 'running' ? ((Date.now()-s.createdAt)/1000).toFixed(0)+'s...' : '-';
      const task = (s.task || '-').slice(0, 40);
      const killBtn = s.status === 'running' ? \`<button class="btn btn-sm btn-red" onclick="killSubagent('\${s.runId}')">✕</button>\` : '';
      const agent = s.agentId ? \`<span class="badge" style="background:#7c3aed;color:#fff;font-size:0.65rem">\${s.agentId}</span>\` : '';
      return \`<tr>
        <td title="\${s.runId}">\${(s.label||s.runId).slice(-12)} \${agent}</td>
        <td><span class="badge \${badge}">\${s.status}</span></td>
        <td style="font-size:0.72rem" title="\${s.task}">\${task}</td>
        <td>\${s.turns||0}</td>
        <td style="font-size:0.72rem">\${dur}</td>
        <td>\${killBtn}</td>
      </tr>\`;
    }).join('');
    document.getElementById('subagents-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Label</th><th>狀態</th><th>Task</th><th>Turns</th><th>時長</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch {}
}

async function killSubagent(runId) {
  if (!confirm('確定強制中止 ' + runId + '？')) return;
  try {
    const d = await authFetch('/api/subagents/kill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId})}).then(r=>r.json());
    const el = document.getElementById('ops-msg');
    el.className = 'msg ' + (d.success ? 'ok' : 'err');
    el.textContent = d.success ? '✓ 已中止 ' + runId : '錯誤：' + d.error;
    loadSubagents();
  } catch(e) { const el = document.getElementById('ops-msg'); el.className='msg err'; el.textContent='失敗：'+e; }
}

// ── 排程 ─────────────────────────────────────────────────────────────────────
async function loadCron() {
  try {
    const d = await authFetch('/api/cron').then(r => r.json());
    const jobs = d.jobs || {};
    const entries = Object.entries(jobs);
    if (!entries.length) { document.getElementById('cron-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無 cron job</p>'; return; }
    const rows = entries.map(([id, job]) => {
      const j = job;
      const schedStr = j.schedule.kind === 'cron' ? j.schedule.expr
        : j.schedule.kind === 'every' ? ('每 ' + Math.round(j.schedule.everyMs/1000) + 's')
        : (j.schedule.at || '-');
      const lastRun = j.lastRunAtMs ? new Date(j.lastRunAtMs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
      const nextRun = j.nextRunAtMs && j.nextRunAtMs < 9e15 ? new Date(j.nextRunAtMs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
      const resultBadge = j.lastResult === 'success' ? '<span class="badge badge-done">✓</span>' : j.lastResult === 'error' ? '<span class="badge badge-err">✗</span>' : '-';
      const enCls = j.enabled !== false ? 'badge-done' : 'badge-err';
      const enLabel = j.enabled !== false ? '啟用' : '停用';
      return \`<tr>
        <td title="\${id}">\${id.slice(-8)}</td>
        <td>\${j.name||'-'}</td>
        <td style="font-size:0.72rem;font-family:monospace">\${schedStr}</td>
        <td><span class="badge \${enCls}">\${enLabel}</span></td>
        <td style="font-size:0.72rem">\${lastRun}</td>
        <td>\${resultBadge}</td>
        <td style="font-size:0.72rem">\${nextRun}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-green" onclick="triggerCronJob('\${id}')">▶</button>
          <button class="btn btn-sm" onclick="toggleCronJob('\${id}', \${j.enabled === false})">⊘</button>
          <button class="btn btn-sm btn-red" onclick="deleteCronJob('\${id}')">✕</button>
        </td>\`;
    }).join('');
    document.getElementById('cron-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>ID</th><th>名稱</th><th>排程</th><th>狀態</th><th>上次執行</th><th>結果</th><th>下次執行</th><th>操作</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { document.getElementById('cron-list').innerHTML = '讀取失敗：' + e; }
}

function showCronAdd() { document.getElementById('cron-add-panel').style.display = ''; }
function hideCronAdd() { document.getElementById('cron-add-panel').style.display = 'none'; }

async function addCronJob() {
  const raw = document.getElementById('cron-add-json').value.trim();
  try { JSON.parse(raw); } catch(e) { showCronMsg('JSON 格式錯誤：' + e, false); return; }
  try {
    const d = await authFetch('/api/cron',{method:'POST',headers:{'Content-Type':'application/json'},body:raw}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已新增', true); hideCronAdd(); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function deleteCronJob(id) {
  if (!confirm('確定刪除 job ' + id + '？')) return;
  try {
    const d = await authFetch('/api/cron/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已刪除', true); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function triggerCronJob(id) {
  try {
    const d = await authFetch('/api/cron/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已排入立即執行（下次 tick 生效）', true); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function toggleCronJob(id, enable) {
  try {
    const d = await authFetch('/api/cron/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,enabled:enable})}).then(r=>r.json());
    if (d.success) { loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

function showCronMsg(msg, ok) {
  const el = document.getElementById('cron-msg');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

// ── Config GUI ───────────────────────────────────────────────────────────────
let _cfgData = null;

// Schema: 描述 config 結構，驅動表單生成
const CFG_SCHEMA = [
  { key:'_basic', label:'基本設定', fields:[
    {k:'logLevel',t:'select',l:'Log Level',opts:['debug','info','warn','error'],d:'日誌輸出等級，debug 最詳細'},
    {k:'turnTimeoutMs',t:'num',l:'Turn Timeout (ms)',d:'單次 turn（無 tool call）的最長執行時間，預設 300000（5 分鐘）'},
    {k:'turnTimeoutToolCallMs',t:'num',l:'Tool Call Timeout (ms)',d:'含 tool call 的 turn 最長時間，預設為 turnTimeoutMs × 1.6'},
    {k:'debounceMs',t:'num',l:'Debounce (ms)',d:'連續訊息合併延遲，在此毫秒內的連續訊息會合併為一次處理'},
    {k:'showToolCalls',t:'select',l:'Show Tool Calls',opts:['all','summary','none'],d:'Discord 回覆中是否顯示 tool 呼叫過程'},
  ]},
  { key:'discord', label:'Discord', fields:[
    {k:'discord.token',t:'pw',l:'Token',d:'Discord Bot Token（修改後需重啟才生效）'},
    {k:'discord.dm.enabled',t:'bool',l:'DM 啟用',d:'是否允許私訊觸發 bot'},
    {k:'admin.allowedUserIds',t:'list',l:'管理員 User IDs',d:'擁有 owner 權限的 Discord User ID 清單'},
  ]},
  /* modelRouting 已移至 models-config.json，由「模型設定」面板管理 */
  { key:'guilds', label:'Guilds', dynamic:true, dynamicPath:'discord.guilds', entryFields:[
    {k:'allow',t:'bool',l:'Allow',d:'是否允許此 guild 使用 bot'},
    {k:'requireMention',t:'bool',l:'Require Mention',d:'需要 @mention 才觸發回覆'},
    {k:'allowBot',t:'bool',l:'Allow Bot',d:'是否回應其他 bot 的訊息'},
    {k:'blockGroupMentions',t:'bool',l:'Block Group Mentions',d:'忽略 @everyone / @here 等群組 mention'},
    {k:'allowFrom',t:'list',l:'Allow From (IDs)',d:'白名單 User ID，空 = 允許所有人'},
  ], hasChannels:true, channelFields:[
    {k:'allow',t:'bool',l:'Allow',d:'是否啟用此頻道'},
    {k:'requireMention',t:'bool',l:'Require Mention',d:'此頻道需 @mention 才觸發'},
    {k:'allowBot',t:'bool',l:'Allow Bot',d:'此頻道是否回應 bot 訊息'},
    {k:'provider',t:'text',l:'Provider',d:'此頻道專用模型（覆蓋 modelRouting）'},
    {k:'boundProject',t:'text',l:'Bound Project',d:'綁定專案 ID，此頻道只用該專案的記憶和設定'},
    {k:'blockGroupMentions',t:'bool',l:'Block Group Mentions',d:'忽略群組 mention'},
    {k:'interruptOnNewMessage',t:'bool',l:'Interrupt On New Message',d:'收到新訊息時中斷目前回覆'},
    {k:'autoThread',t:'bool',l:'Auto Thread',d:'自動建立 thread 回覆'},
    {k:'allowFrom',t:'list',l:'Allow From (IDs)',d:'此頻道白名單 User ID'},
  ]},
  { key:'session', label:'Session', fields:[
    {k:'session.ttlHours',t:'num',l:'TTL (hours)',d:'Session 閒置多久後過期（小時），預設 168（7 天）'},
    {k:'session.maxHistoryTurns',t:'num',l:'Max History Turns',d:'Session 保留的最大對話輪數，預設 50'},
    {k:'session.compactAfterTurns',t:'num',l:'Compact After Turns',d:'超過此輪數後觸發對話壓縮，預設 30'},
    {k:'session.persistPath',t:'text',l:'Persist Path',d:'Session 檔案持久化目錄的絕對路徑'},
  ]},
  { key:'memory', label:'Memory', fields:[
    {k:'memory.enabled',t:'bool',l:'啟用',d:'記憶系統總開關'},
    {k:'memory.root',t:'text',l:'Root Path',d:'記憶 atom 檔案的儲存根目錄'},
    {k:'memory.vectorDbPath',t:'text',l:'Vector DB Path',d:'LanceDB 向量索引存放路徑'},
    {k:'memory.contextBudget',t:'num',l:'Context Budget (tokens)',d:'每次 turn 注入的記憶 token 上限'},
  ], sub:[
    {k:'memory.contextBudgetRatio',l:'Context Budget Ratio',fields:[
      {k:'global',t:'num',l:'Global',step:'0.1',d:'全域記憶佔 context budget 的比例（0-1）'},
      {k:'project',t:'num',l:'Project',step:'0.1',d:'專案記憶佔 context budget 的比例（0-1）'},
      {k:'account',t:'num',l:'Account',step:'0.1',d:'個人記憶佔 context budget 的比例（0-1）'},
    ]},
    {k:'memory.writeGate',l:'Write Gate',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'寫入前檢查重複和品質'},
      {k:'dedupThreshold',t:'num',l:'Dedup Threshold',step:'0.01',d:'向量相似度超過此值視為重複（0-1），預設 0.8'},
    ]},
    {k:'memory.recall',l:'Recall',fields:[
      {k:'triggerMatch',t:'bool',l:'Trigger Match',d:'使用 MEMORY.md 的 trigger 關鍵詞匹配 atom'},
      {k:'vectorSearch',t:'bool',l:'Vector Search',d:'使用向量語意搜尋找相關 atom'},
      {k:'relatedEdgeSpreading',t:'bool',l:'Related Edge Spreading',d:'命中 atom 後沿 Related 欄位展開關聯 atom'},
      {k:'vectorMinScore',t:'num',l:'Vector Min Score',step:'0.01',d:'向量搜尋最低相似度門檻（0-1），預設 0.35'},
      {k:'vectorTopK',t:'num',l:'Vector Top K',d:'向量搜尋最多回傳幾個結果，預設 10'},
      {k:'llmSelect',t:'bool',l:'LLM Select',d:'用 LLM 從候選 atom 中篩選最相關的'},
      {k:'llmSelectMax',t:'num',l:'LLM Select Max',d:'LLM 篩選後保留的最大數量，預設 5'},
    ]},
    {k:'memory.extract',l:'Extract',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'自動從對話中萃取知識寫入記憶'},
      {k:'perTurn',t:'bool',l:'Per Turn',d:'每個 turn 結束後萃取'},
      {k:'onSessionEnd',t:'bool',l:'On Session End',d:'Session 結束時萃取'},
      {k:'maxItemsPerTurn',t:'num',l:'Max Items Per Turn',d:'每 turn 最多萃取幾條記憶，預設 3'},
      {k:'maxItemsSessionEnd',t:'num',l:'Max Items Session End',d:'Session 結束時最多萃取幾條，預設 5'},
      {k:'minNewChars',t:'num',l:'Min New Chars',d:'對話累積至少多少新字元才觸發萃取，預設 500'},
    ]},
    {k:'memory.consolidate',l:'Consolidate',fields:[
      {k:'autoPromoteThreshold',t:'num',l:'Auto Promote Threshold',d:'命中超過此次數自動晉升信心等級，預設 20'},
      {k:'suggestPromoteThreshold',t:'num',l:'Suggest Promote Threshold',d:'命中超過此次數建議晉升，預設 4'},
    ]},
    {k:'memory.consolidate.decay',l:'Decay',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'記憶衰減機制，長期未使用的 atom 會被歸檔'},
      {k:'halfLifeDays',t:'num',l:'Half Life (days)',d:'記憶半衰期（天），預設 30'},
      {k:'archiveThreshold',t:'num',l:'Archive Threshold',step:'0.01',d:'分數低於此值的 atom 被歸檔（0-1），預設 0.3'},
    ]},
    {k:'memory.episodic',l:'Episodic',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'情境記憶（每次對話的摘要記錄）'},
      {k:'ttlDays',t:'num',l:'TTL (days)',d:'情境記憶保留天數，過期自動清除'},
    ]},
    {k:'memory.rutDetection',l:'Rut Detection',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'偵測 AI 是否陷入重複模式（車轍偵測）'},
      {k:'windowSize',t:'num',l:'Window Size',d:'檢查最近幾個 turn 的模式'},
      {k:'minOccurrences',t:'num',l:'Min Occurrences',d:'同一模式出現幾次才觸發警告'},
    ]},
    {k:'memory.oscillation',l:'Oscillation',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'偵測 atom 是否在新增/刪除間反覆震盪'},
    ]},
    {k:'memory.sessionMemory',l:'Session Memory',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'Session 內的短期記憶摘要'},
      {k:'intervalTurns',t:'num',l:'Interval Turns',d:'每隔幾個 turn 產生一次摘要'},
      {k:'maxHistoryTurns',t:'num',l:'Max History Turns',d:'摘要時回看的最大 turn 數'},
    ]},
  ]},
  { key:'safety', label:'Safety', fields:[
    {k:'safety.enabled',t:'bool',l:'啟用',d:'安全系統總開關（強烈建議保持啟用）'},
    {k:'safety.selfProtect',t:'bool',l:'Self Protect',d:'保護 catclaw.json、accounts/ 等核心檔案不被 AI 直接修改'},
    {k:'safety.bash.blacklist',t:'list',l:'Bash Blacklist (硬擋)',d:'Bash 指令黑名單（正則表達式），匹配的指令永遠阻擋，不可授權'},
    {k:'safety.filesystem.protectedPaths',t:'list',l:'Protected Paths (軟擋)',d:'受保護路徑，寫入/bash 操作需 Exec Approval 授權（未啟用 Approval 時為硬擋）',defaults:${JSON.stringify(PROTECTED_WRITE_PATHS_DEFAULT)}},
    {k:'safety.filesystem.credentialPatterns',t:'list',l:'Credential Patterns (硬擋)',d:'憑證檔案模式（正則），匹配的檔案永遠禁止存取，不可授權'},
  ], sub:[
    {k:'safety.execApproval',l:'Exec Approval',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'高風險指令執行前需要 owner DM 核准'},
      {k:'dmUserId',t:'text',l:'DM User ID',d:'接收核准請求的 Discord User ID'},
      {k:'timeoutMs',t:'num',l:'Timeout (ms)',d:'等待核准的逾時時間，預設 60000（1 分鐘）'},
      {k:'allowedPatterns',t:'list',l:'Allowed Patterns',d:'免核准的指令前綴（如 echo, ls, git status）'},
    ]},
    {k:'safety.toolPermissions',l:'Tool Permissions',fields:[
      {k:'defaultAllow',t:'bool',l:'Default Allow',d:'無匹配規則時預設允許（false = 白名單模式，true = 黑名單模式）'},
    ]},
  ]},
  { key:'workflow', label:'Workflow', sub:[
    {k:'workflow.guardian',l:'Guardian',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'Workflow Guardian：追蹤檔案修改、提醒同步'},
      {k:'syncReminder',t:'bool',l:'Sync Reminder',d:'在未同步的修改累積時提醒 AI'},
      {k:'fileTracking',t:'bool',l:'File Tracking',d:'追蹤 tool 產生的檔案修改'},
    ]},
    {k:'workflow.fixEscalation',l:'Fix Escalation',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'同一問題多次修復失敗時升級為精確修正會議'},
      {k:'retryThreshold',t:'num',l:'Retry Threshold',d:'重試幾次後觸發升級，預設 2'},
    ]},
    {k:'workflow.wisdomEngine',l:'Wisdom Engine',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'智慧引擎：從失敗模式中學習，注入防範建議'},
    ]},
    {k:'workflow.aidocs',l:'AIDocs',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'自動維護專案知識庫（_AIDocs/）'},
      {k:'contentGate',t:'bool',l:'Content Gate',d:'檢查內容是否適合放入 _AIDocs（vs _staging）'},
    ]},
  ]},
  { key:'accounts', label:'Accounts', fields:[
    {k:'accounts.registrationMode',t:'select',l:'Registration Mode',opts:['open','invite','closed'],d:'帳號註冊模式：open=自由註冊, invite=需邀請, closed=關閉'},
    {k:'accounts.defaultRole',t:'text',l:'Default Role',d:'新帳號的預設角色（member/developer/admin）'},
    {k:'accounts.pairingEnabled',t:'bool',l:'Pairing Enabled',d:'允許透過配對碼綁定 Discord 身份'},
    {k:'accounts.pairingExpireMinutes',t:'num',l:'Pairing Expire (min)',d:'配對碼有效時間（分鐘）'},
  ]},
  { key:'cron', label:'Cron', fields:[
    {k:'cron.enabled',t:'bool',l:'啟用',d:'排程任務系統總開關'},
    {k:'cron.maxConcurrentRuns',t:'num',l:'Max Concurrent Runs',d:'同時最多執行幾個 cron job'},
    {k:'cron.defaultAccountId',t:'text',l:'Default Account ID',d:'Cron job 預設使用的帳號 ID'},
    {k:'cron.defaultProvider',t:'text',l:'Default Provider',d:'Cron job 預設使用的模型（alias）'},
  ]},
  { key:'contextEngineering', label:'Context Engineering', fields:[
    {k:'contextEngineering.enabled',t:'bool',l:'啟用',d:'Context Engineering 總開關：管理 context window 使用策略'},
  ], sub:[
    {k:'contextEngineering.strategies.decay',l:'Decay（漸進衰減）',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'漸進式訊息衰減：依 turn 年齡逐步壓縮/移除舊訊息'},
      {k:'mode',t:'select',l:'Mode',opts:['auto','discrete','continuous','time-aware'],d:'auto=三合一（推薦），discrete=固定閾值，continuous=指數衰減，time-aware=含對話節奏調整'},
      {k:'baseDecay',t:'num',l:'Base Decay',d:'指數衰減係數（預設 0.3），越大衰減越快'},
      {k:'referenceIntervalSec',t:'num',l:'Reference Interval (sec)',d:'對話節奏參考間隔（預設 60 秒），用於計算 tempo multiplier'},
    ]},
    {k:'contextEngineering.strategies.compaction',l:'Compaction',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'對話壓縮：超過觸發 token 數後用 LLM 摘要早期對話'},
      {k:'model',t:'text',l:'Model',d:'用於壓縮的模型（建議用便宜的如 claude-haiku）'},
      {k:'triggerTokens',t:'num',l:'Trigger Tokens',d:'累積超過多少 token 後觸發壓縮（預設 20000）'},
      {k:'preserveRecentTurns',t:'num',l:'Preserve Recent Turns',d:'壓縮時保留最近幾輪不壓縮'},
    ]},
    {k:'contextEngineering.strategies.overflowHardStop',l:'Overflow Hard Stop',fields:[
      {k:'enabled',t:'bool',l:'啟用',d:'緊急截斷：context 超硬上限時只保留最近 4 條'},
      {k:'hardLimitUtilization',t:'num',l:'Hard Limit %',d:'context window 使用率閾值（預設 0.95 = 95%）'},
      {k:'contextWindowTokens',t:'num',l:'Context Window Tokens',d:'context window 大小（預設 100000）'},
    ]},
    {k:'contextEngineering.toolBudget',l:'Tool Budget',fields:[
      {k:'resultTokenCap',t:'num',l:'Result Token Cap',d:'單次 tool 回傳結果的 token 上限（預設 8000，0=無限制）'},
      {k:'perTurnTotalCap',t:'num',l:'Per Turn Total Cap',d:'單 turn 內所有 tool 結果的 token 總上限（預設 0=無限制）'},
      {k:'toolTimeoutMs',t:'num',l:'Tool Timeout (ms)',d:'單次 tool 執行逾時（預設 30000ms，0=無限制）'},
      {k:'maxWriteFileBytes',t:'num',l:'Max Write Bytes',d:'write/edit 單次上限 bytes（預設 512000=500KB，0=無限制）'},
    ]},
  ]},
  { key:'inboundHistory', label:'Inbound History', fields:[
    {k:'inboundHistory.enabled',t:'bool',l:'啟用',d:'記錄頻道的歷史訊息，供 context 注入'},
    {k:'inboundHistory.fullWindowHours',t:'num',l:'Full Window (hours)',d:'完整保留的時間窗口（小時），此範圍內訊息不衰減'},
    {k:'inboundHistory.decayWindowHours',t:'num',l:'Decay Window (hours)',d:'衰減窗口（小時），超過 full window 後逐漸降低權重'},
    {k:'inboundHistory.bucketBTokenCap',t:'num',l:'Bucket B Token Cap',d:'中期歷史的 token 上限'},
    {k:'inboundHistory.decayIITokenCap',t:'num',l:'Decay II Token Cap',d:'遠期歷史的 token 上限'},
    {k:'inboundHistory.inject.enabled',t:'bool',l:'Inject Enabled',d:'是否將歷史訊息注入 system prompt'},
  ]},
  { key:'dashboard', label:'Dashboard', fields:[
    {k:'dashboard.enabled',t:'bool',l:'啟用',d:'Dashboard 監控面板開關'},
    {k:'dashboard.port',t:'num',l:'Port',d:'Dashboard HTTP 服務埠號，預設 8088'},
    {k:'dashboard.token',t:'pw',l:'Auth Token',d:'存取認證 token，設定後需帶 ?token=xxx 才能進入'},
  ]},
  // CLI Bridge 設定已移至獨立檔案 cli-bridges.json，透過 CLI Bridge tab 管理
  { key:'botCircuitBreaker', label:'Bot Circuit Breaker', fields:[
    {k:'botCircuitBreaker.enabled',t:'bool',l:'啟用',d:'Bot-to-Bot 對話防呆（同頻道 bot 互相回覆過度活躍時暫停）'},
    {k:'botCircuitBreaker.maxRounds',t:'num',l:'最大輪數',d:'連續 bot 互動來回幾輪後觸發暫停（預設 10）'},
    {k:'botCircuitBreaker.maxDurationMs',t:'num',l:'最大持續時間 (ms)',d:'連續 bot 互動持續多久後觸發暫停（預設 180000 = 3 分鐘）'},
  ]},
  { key:'subagents', label:'Subagents', fields:[
    {k:'subagents.maxConcurrent',t:'num',l:'Max Concurrent',d:'同時最多運行幾個子 agent'},
    {k:'subagents.defaultTimeoutMs',t:'num',l:'Default Timeout (ms)',d:'子 agent 預設執行逾時（毫秒）'},
    {k:'subagents.defaultKeepSession',t:'bool',l:'Default Keep Session',d:'子 agent 完成後是否保留 session（可被後續任務復用）'},
  ]},
  { key:'rateLimit', label:'Rate Limit', dynamic:true, dynamicPath:'rateLimit', entryFields:[
    {k:'requestsPerMinute',t:'num',l:'Requests Per Minute',d:'該角色每分鐘最多發送幾則訊息'},
  ]},
  { key:'mcpServers', label:'MCP Servers', dynamic:true, dynamicPath:'mcpServers', entryFields:[
    {k:'command',t:'text',l:'Command',d:'MCP server 啟動指令（如 node, python）'},
    {k:'args',t:'list',l:'Args',d:'啟動指令的參數列表'},
    {k:'tier',t:'select',l:'Tier',opts:['public','standard','elevated','admin','owner'],d:'工具權限層級：public=所有人, elevated=需核准, owner=僅管理員'},
  ]},
];

// ── 工具函式 ──
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

// ── 表單欄位渲染 ──
function renderField(f, val, prefix) {
  const id = prefix + '__' + f.k;
  const v = val ?? '';
  const hint = f.d ? \`<span class="cfg-hint" title="\${esc(f.d)}">ℹ️ \${f.d}</span>\` : '';
  if (f.t === 'bool') {
    return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><label class="cfg-toggle"><input type="checkbox" data-path="\${id}" \${v ? 'checked' : ''}><span class="slider"></span></label></div>\`;
  }
  if (f.t === 'select') {
    const opts = (f.opts||[]).map(o => \`<option value="\${o}" \${v===o?'selected':''}>\${o||'(auto)'}</option>\`).join('');
    return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><select data-path="\${id}">\${opts}</select></div>\`;
  }
  if (f.t === 'list') {
    const items = Array.isArray(val) ? val : [];
    const rows = items.map((item, i) =>
      \`<div class="cfg-list-item"><input value="\${esc(item)}" data-path="\${id}[\${i}]"><button class="btn-x" onclick="this.parentElement.remove()">✕</button></div>\`
    ).join('');
    const defaultsHtml = Array.isArray(f.defaults) && f.defaults.length
      ? \`<div style="font-size:0.7rem;color:#9ca3af;margin-top:4px;padding:4px 6px;background:#0f1117;border-left:2px solid #818cf8;border-radius:2px">🔒 預設保護（不可移除）：\${f.defaults.map(esc).join(', ')}</div>\`
      : '';
    return \`<div class="cfg-row" style="align-items:start"><label>\${f.l}\${hint}</label><div class="cfg-list" id="list_\${id}">\${rows}<button class="cfg-add" onclick="addListItem('list_\${id}','\${id}')">+ 新增</button>\${defaultsHtml}</div></div>\`;
  }
  const inputType = f.t === 'pw' ? 'password' : f.t === 'num' ? 'number' : 'text';
  const step = f.step ? \` step="\${f.step}"\` : '';
  return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><input type="\${inputType}" data-path="\${id}" value="\${esc(String(v ?? ''))}"\${step}></div>\`;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function addListItem(containerId, pathPrefix) {
  const c = document.getElementById(containerId);
  const items = c.querySelectorAll('.cfg-list-item');
  const idx = items.length;
  const div = document.createElement('div');
  div.className = 'cfg-list-item';
  div.innerHTML = \`<input value="" data-path="\${pathPrefix}[\${idx}]"><button class="btn-x" onclick="this.parentElement.remove()">✕</button>\`;
  c.insertBefore(div, c.querySelector('.cfg-add'));
}

// ── Map 欄位（key→value） ──
function renderMap(m, data, prefix) {
  const obj = getPath(data, m.k) || {};
  const id = prefix + '__' + m.k.replace(/\\./g,'_');
  let rows = Object.entries(obj).map(([k,v]) =>
    \`<div class="cfg-map-row"><input value="\${esc(k)}" class="map-key" placeholder="key"><input value="\${esc(String(v))}" class="map-val" placeholder="value"><button class="btn-x" onclick="this.parentElement.remove()">✕</button></div>\`
  ).join('');
  return \`<div class="cfg-row" style="align-items:start"><label>\${m.l}</label><div class="cfg-map" id="map_\${id}" data-map-path="\${m.k}">\${rows}<button class="cfg-add" onclick="addMapRow('map_\${id}')">+ 新增</button></div></div>\`;
}

function addMapRow(containerId) {
  const c = document.getElementById(containerId);
  const div = document.createElement('div');
  div.className = 'cfg-map-row';
  div.innerHTML = '<input value="" class="map-key" placeholder="key"><input value="" class="map-val" placeholder="value"><button class="btn-x" onclick="this.parentElement.remove()">✕</button>';
  c.insertBefore(div, c.querySelector('.cfg-add'));
}

// ── Sub section ──
function renderSub(s, data) {
  const subData = getPath(data, s.k) || {};
  const fields = (s.fields||[]).map(f => renderField(f, subData[f.k], s.k)).join('');
  return \`<div class="cfg-sub"><div style="font-size:0.78rem;color:#818cf8;margin-bottom:6px;font-weight:bold">\${s.l}</div>\${fields}</div>\`;
}

// ── Dynamic entries (providers, guilds, mcpServers, rateLimit) ──
function renderDynamic(section, data) {
  const path = section.dynamicPath || section.key;
  const obj = getPath(data, path) || {};
  let html = '';
  const secId = path.replace(/\\./g, '_');
  for (const [entryKey, entryVal] of Object.entries(obj)) {
    const ev = entryVal || {};
    let fieldsHtml = (section.entryFields||[]).map(f => renderField(f, ev[f.k], path+'.'+entryKey)).join('');
    // Guilds 有 channels 子區塊
    if (section.hasChannels && ev.channels) {
      let chHtml = '';
      for (const [chId, chVal] of Object.entries(ev.channels)) {
        const cv = chVal || {};
        const chFields = (section.channelFields||[]).map(f => renderField(f, cv[f.k], path+'.'+entryKey+'.channels.'+chId)).join('');
        chHtml += \`<div class="cfg-dynamic-entry" style="background:#0f1117"><div class="entry-header"><span style="color:#60a5fa;font-size:0.75rem">📌 Channel</span><input value="\${esc(chId)}" class="dyn-key" style="font-size:0.75rem" disabled></div>\${chFields}</div>\`;
      }
      fieldsHtml += \`<div class="cfg-sub"><div style="font-size:0.75rem;color:#60a5fa;margin-bottom:6px">Channels</div>\${chHtml}</div>\`;
    }
    html += \`<div class="cfg-dynamic-entry" id="dyn_\${secId}_\${esc(entryKey)}"><div class="entry-header"><span style="color:#a78bfa;font-size:0.75rem">🔑</span><input value="\${esc(entryKey)}" class="dyn-key" disabled style="color:#a78bfa;background:transparent;border:none;font-size:0.82rem;flex:1"><button class="btn btn-red btn-sm" onclick="removeDynEntry('\${secId}','\${esc(entryKey)}',this)">刪除</button></div>\${fieldsHtml}</div>\`;
  }
  html += \`<div style="margin-top:8px"><input id="new_dyn_\${secId}" placeholder="新 ID" style="background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace;width:200px"><button class="cfg-add" style="margin-left:8px" onclick="addDynEntry('\${secId}','\${path}')">+ 新增</button></div>\`;
  return html;
}

function addDynEntry(secId, path) {
  const input = document.getElementById('new_dyn_' + secId);
  const id = input.value.trim();
  if (!id) return;
  // 在 _cfgData 中加入空 entry，重新渲染整個 config GUI
  const obj = getPath(_cfgData, path) || {};
  obj[id] = {};
  setPath(_cfgData, path, obj);
  input.value = '';
  document.getElementById('cfg-gui').innerHTML = renderConfigGUI(_cfgData);
}

function removeDynEntry(secId, key, btn) {
  if (!confirm('確定刪除 ' + key + '？')) return;
  btn.closest('.cfg-dynamic-entry').remove();
  // 同步從 _cfgData 移除
  const path = secId.replace(/_/g, '.');
  const obj = getPath(_cfgData, path);
  if (obj) delete obj[key];
}

// ── 完整 GUI 渲染 ──
function renderConfigGUI(data) {
  let html = '';
  for (const sec of CFG_SCHEMA) {
    let content = '';
    // 一般欄位
    if (sec.fields) {
      content += sec.fields.map(f => {
        const val = f.k.includes('.') ? getPath(data, f.k) : data[f.k];
        return renderField(f, val, sec.key);
      }).join('');
    }
    // Maps
    if (sec.maps) content += sec.maps.map(m => renderMap(m, data, sec.key)).join('');
    // Sub sections
    if (sec.sub) content += sec.sub.map(s => renderSub(s, data)).join('');
    // Dynamic entries
    if (sec.dynamic) content += renderDynamic(sec, data);

    html += \`<details class="cfg-section" \${sec.key==='_basic'?'open':''}><summary>\${sec.label}</summary><div class="cfg-fields">\${content}</div></details>\`;
  }
  return html;
}

// ── 收集表單值回 JSON ──
function collectConfigJSON() {
  const result = JSON.parse(JSON.stringify(_cfgData)); // deep clone
  // 收集所有 data-path input/select/checkbox
  document.querySelectorAll('#cfg-gui [data-path]').forEach(el => {
    const rawPath = el.dataset.path;
    // 跳過 dynamic entry 中的 list index — 由 list 收集器處理
    const listMatch = rawPath.match(/^(.+)\\[(\\d+)\\]\$/);
    if (listMatch) return; // list items 下面統一處理

    // 將 section__key 轉回 dot path
    const path = rawPath.replace(/__/g, '.');
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'number') val = el.value === '' ? undefined : Number(el.value);
    else val = el.value;
    if (val !== undefined && val !== '') setPath(result, path, val);
  });

  // 收集 list 欄位
  document.querySelectorAll('#cfg-gui .cfg-list').forEach(listEl => {
    const items = listEl.querySelectorAll('.cfg-list-item input');
    const firstItem = items[0];
    if (!firstItem) return;
    const basePath = firstItem.dataset.path.replace(/\\[\\d+\\]\$/, '').replace(/__/g, '.');
    const arr = Array.from(items).map(i => i.value).filter(v => v !== '');
    setPath(result, basePath, arr);
  });

  // 收集 map 欄位
  document.querySelectorAll('#cfg-gui .cfg-map').forEach(mapEl => {
    const path = mapEl.dataset.mapPath;
    const obj = {};
    mapEl.querySelectorAll('.cfg-map-row').forEach(row => {
      const k = row.querySelector('.map-key')?.value;
      const v = row.querySelector('.map-val')?.value;
      if (k) obj[k] = v;
    });
    setPath(result, path, obj);
  });

  return result;
}

async function loadCfg() {
  try {
    const text = await authFetch('/api/config').then(r => r.text());
    _cfgData = JSON.parse(text);
    document.getElementById('cfg-gui').innerHTML = renderConfigGUI(_cfgData);
    showCfgMsg('', true);
  } catch(e) { showCfgMsg('讀取失敗：' + e, false); }
}

async function saveCfg() {
  if (!_cfgData) { showCfgMsg('請先讀取 config', false); return; }
  try {
    const body = JSON.stringify(collectConfigJSON(), null, 2);
    const d = await authFetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body}).then(r=>r.json());
    showCfgMsg(d.success ? '✓ 已備份並儲存' : '錯誤：' + d.error, d.success);
  } catch(e) { showCfgMsg('儲存失敗：' + e, false); }
}

function showCfgMsg(msg, ok) {
  const el = document.getElementById('cfg-msg');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

// ── Models JSON Viewer ──────────────────────────────────────────────────────
async function loadModelsJson() {
  try {
    const d = await authFetch('/api/models-json').then(r => r.json());
    const el = document.getElementById('models-json-viewer');
    if (!d.exists) { el.innerHTML = '<span style="color:#f59e0b">models.json 不存在（V1 模式？）</span>'; return; }
    const providers = d.data?.providers || {};
    let html = '<div style="font-size:0.68rem;color:#666;margin-bottom:8px">📁 ' + (d.path||'') + '</div>';
    for (const [pid, prov] of Object.entries(providers)) {
      const p = prov || {};
      html += '<div style="margin-bottom:10px;padding:8px;background:#161827;border-radius:6px">';
      html += '<div style="font-weight:bold;color:#a78bfa;margin-bottom:6px">' + esc(pid) + ' <span style="color:#666;font-weight:normal;font-size:0.72rem">' + esc(p.baseUrl||'') + ' / ' + esc(p.api||'auto') + '</span></div>';
      const models = p.models || [];
      if (models.length > 0) {
        html += '<table class="tbl" style="font-size:0.72rem"><thead><tr><th>Model ID</th><th>Name</th><th>Context</th><th>Max Out</th><th>Cost (in/out)</th><th>Input</th></tr></thead><tbody>';
        for (const m of models) {
          html += '<tr><td style="color:#60a5fa">' + esc(m.id) + '</td><td>' + esc(m.name||'') + '</td><td>' + (m.contextWindow||'?').toLocaleString() + '</td><td>' + (m.maxTokens||'?').toLocaleString() + '</td><td>$' + (m.cost?.input??'?') + '/$' + (m.cost?.output??'?') + '</td><td>' + (m.input||[]).join(', ') + '</td></tr>';
        }
        html += '</tbody></table>';
      } else {
        html += '<span style="color:#888">無模型定義</span>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch(e) { document.getElementById('models-json-viewer').innerHTML = '<span class="msg err">讀取失敗：' + e + '</span>'; }
}

// ── Models Config ────────────────────────────────────────────────────────────
async function loadModelsConfig() {
  const panel = document.getElementById('models-config-panel');
  const msg = document.getElementById('models-config-msg');
  try {
    const d = await authFetch('/api/models-config').then(r => r.json());
    if (!d.exists) { panel.innerHTML = '<p style="color:#888">models-config.json 不存在</p>'; return; }
    const mc = d.data;
    const primary = mc.primary || '(未設定)';
    const fallbacks = (mc.fallbacks || []).join(', ') || '(無)';
    const aliases = mc.aliases || {};
    const aliasKeys = Object.keys(aliases);

    let html = '<div style="margin-bottom:12px"><strong style="color:#818cf8">當前模型：</strong><span style="color:#34d399;font-size:1.1em;font-weight:bold">' + primary + '</span>';
    html += '  <span style="color:#888;font-size:0.8em;margin-left:8px">fallback: ' + fallbacks + '</span></div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">';
    for (const alias of aliasKeys) {
      const isCurrent = alias === primary;
      const btnClass = isCurrent ? 'btn btn-green btn-sm' : 'btn btn-sm';
      html += '<button class="' + btnClass + '" onclick="switchPrimary(&quot;' + alias + '&quot;)" ' + (isCurrent ? 'disabled' : '') + '>' + alias + '</button>';
    }
    html += '</div>';
    // routing 區塊
    const routing = mc.routing || {};
    html += '<details style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2d3e"><summary style="cursor:pointer;color:#818cf8;font-size:0.82rem;font-weight:bold">模型路由（channel/project/role 覆蓋）</summary>';
    html += '<div style="margin-top:8px">';
    // routing maps
    const routingMaps = [
      { key: 'channels', label: 'Channel → Model（最高優先）' },
      { key: 'roles', label: 'Role → Model' },
      { key: 'projects', label: 'Project → Model' },
    ];
    for (const rm of routingMaps) {
      const map = routing[rm.key] || {};
      const entries = Object.entries(map);
      html += '<div style="margin-bottom:8px"><strong style="font-size:0.78rem;color:#a78bfa">' + rm.label + '</strong>';
      if (entries.length === 0) {
        html += '<span style="color:#555;font-size:0.75rem;margin-left:8px">(未設定)</span>';
      }
      html += '<div style="margin-top:4px">';
      for (const [k, v] of entries) {
        html += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:3px">';
        html += '<code style="font-size:0.72rem;color:#e0e0e0;min-width:120px">' + k + '</code>';
        html += '<span style="color:#888">→</span>';
        html += '<code style="font-size:0.72rem;color:#34d399">' + v + '</code>';
        html += '<button class="btn btn-red btn-sm" style="font-size:0.65rem;padding:1px 6px" onclick="removeRoutingEntry(&quot;' + rm.key + '&quot;,&quot;' + k + '&quot;)">✕</button>';
        html += '</div>';
      }
      html += '<div style="display:flex;gap:4px;align-items:center;margin-top:4px">';
      html += '<input id="routing-new-' + rm.key + '-key" placeholder="ID" style="width:120px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:3px;padding:2px 6px;font-size:0.72rem;font-family:monospace">';
      html += '<span style="color:#888">→</span>';
      html += '<input id="routing-new-' + rm.key + '-val" placeholder="model alias" style="width:100px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:3px;padding:2px 6px;font-size:0.72rem;font-family:monospace">';
      html += '<button class="btn btn-green btn-sm" style="font-size:0.65rem;padding:1px 6px" onclick="addRoutingEntry(&quot;' + rm.key + '&quot;)">+</button>';
      html += '</div></div></div>';
    }
    html += '</div></details>';

    html += '<details style="margin-top:8px"><summary style="cursor:pointer;color:#888;font-size:0.78rem">Alias 對照表</summary>';
    html += '<table class="tbl" style="margin-top:4px"><tr><th>Alias</th><th>Provider/Model</th></tr>';
    for (const [alias, ref] of Object.entries(aliases)) {
      const isCurrent = alias === primary;
      html += '<tr' + (isCurrent ? ' style="color:#34d399"' : '') + '><td>' + alias + '</td><td style="font-family:monospace;font-size:0.75rem">' + ref + '</td></tr>';
    }
    html += '</table></details>';
    panel.innerHTML = html;
    msg.className = 'msg'; msg.textContent = '';
  } catch(e) { msg.className = 'msg err'; msg.textContent = '載入失敗：' + e; }
}

async function switchPrimary(alias) {
  const msg = document.getElementById('models-config-msg');
  try {
    const d = await authFetch('/api/models-config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'set-primary',primary:alias})}).then(r=>r.json());
    if (d.success) {
      msg.className = 'msg ok'; msg.textContent = '已切換為 ' + alias + '，重啟中...';
      await authFetch('/api/restart', {method:'POST'});
      setTimeout(() => { msg.textContent = '已切換為 ' + alias + '（已重啟）'; loadModelsConfig(); }, 3000);
    } else { msg.className = 'msg err'; msg.textContent = d.error; }
  } catch(e) { msg.className = 'msg err'; msg.textContent = '切換失敗：' + e; }
}

async function addRoutingEntry(mapKey) {
  const key = document.getElementById('routing-new-' + mapKey + '-key').value.trim();
  const val = document.getElementById('routing-new-' + mapKey + '-val').value.trim();
  const msg = document.getElementById('models-config-msg');
  if (!key || !val) { msg.className = 'msg err'; msg.textContent = 'ID 和 model 都要填'; return; }
  try {
    const d = await authFetch('/api/models-config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'set-routing', mapKey, key, value: val})}).then(r=>r.json());
    if (d.success) { msg.className = 'msg ok'; msg.textContent = '已新增 ' + mapKey + '.' + key + ' → ' + val + '，重啟中...'; await authFetch('/api/restart',{method:'POST'}); setTimeout(()=>{ msg.textContent = '路由已更新（已重啟）'; loadModelsConfig(); }, 3000); }
    else { msg.className = 'msg err'; msg.textContent = d.error; }
  } catch(e) { msg.className = 'msg err'; msg.textContent = '失敗：' + e; }
}

async function removeRoutingEntry(mapKey, entryKey) {
  const msg = document.getElementById('models-config-msg');
  try {
    const d = await authFetch('/api/models-config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'remove-routing', mapKey, key: entryKey})}).then(r=>r.json());
    if (d.success) { msg.className = 'msg ok'; msg.textContent = '已移除 ' + mapKey + '.' + entryKey + '，重啟中...'; await authFetch('/api/restart',{method:'POST'}); setTimeout(()=>{ msg.textContent = '路由已更新（已重啟）'; loadModelsConfig(); }, 3000); }
    else { msg.className = 'msg err'; msg.textContent = d.error; }
  } catch(e) { msg.className = 'msg err'; msg.textContent = '失敗：' + e; }
}

// ── Tasks ────────────────────────────────────────────────────────────────────
async function loadTasks() {
  try {
    const d = await authFetch('/api/tasks').then(r => r.json());
    const el = document.getElementById('tasks-list');
    if (!d.sessions?.length) { el.innerHTML = '<p style="color:#888">目前無任務</p>'; return; }
    const statusIcon = { pending: '⏳', in_progress: '🔄', completed: '✅' };
    let html = '';
    for (const sess of d.sessions) {
      html += '<div style="margin-bottom:12px"><strong style="color:#4fc3f7">Session: ' + sess.sessionKey + '</strong>';
      html += '<table class="tbl" style="margin-top:4px"><thead><tr><th>#</th><th>狀態</th><th>主題</th><th>說明</th><th>依賴</th><th>更新時間</th></tr></thead><tbody>';
      for (const t of sess.tasks) {
        const icon = statusIcon[t.status] || '❓';
        const blocked = t.blockedBy?.length ? 'blocked by: ' + t.blockedBy.join(', ') : '';
        const blocks = t.blocks?.length ? 'blocks: ' + t.blocks.join(', ') : '';
        const deps = [blocked, blocks].filter(Boolean).join(' | ') || '-';
        const updated = new Date(t.updatedAt).toLocaleTimeString();
        html += '<tr><td>' + t.id + '</td><td>' + icon + ' ' + t.status + '</td><td>' + (t.subject||'') + '</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">' + (t.description||'-') + '</td><td style="font-size:0.75rem">' + deps + '</td><td>' + updated + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    el.innerHTML = html;
  } catch (err) { document.getElementById('tasks-list').innerHTML = '<p style="color:#f44">載入失敗: ' + err + '</p>'; }
}

// ── Auth Profiles ────────────────────────────────────────────────────────────
async function loadAuthProfiles() {
  try {
    const d = await authFetch('/api/auth-profiles').then(r => r.json());
    // 憑證列表
    const credsHtml = (d.credentials||[]).map(c =>
      \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px;background:#161827;border-radius:4px">
        <span style="font-weight:bold;color:#a78bfa;min-width:80px">\${c.id}</span>
        <code style="flex:1;font-size:0.75rem;color:#888">\${c.credential}</code>
        <button class="btn btn-red btn-sm" onclick="removeAuthProfile('\${c.id}')">刪除</button>
      </div>\`
    ).join('') || '<p style="color:#888;font-size:0.8rem">無憑證</p>';
    document.getElementById('auth-creds').innerHTML = credsHtml;

    // Provider 狀態
    let statusHtml = '';
    for (const [providerId, profiles] of Object.entries(d.statuses||{})) {
      const rows = (profiles||[]).map(p => {
        const lu = p.lastUsed ? new Date(p.lastUsed).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
        const cd = p.cooldownUntil > Date.now() ? new Date(p.cooldownUntil).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
        const status = p.disabled ? '<span class="badge badge-err">停用</span>'
          : p.cooldownUntil > Date.now() ? \`<span class="badge badge-run">CD: \${p.cooldownReason||'?'}</span>\`
          : '<span class="badge badge-done">可用</span>';
        const clearBtn = (p.disabled || p.cooldownUntil > Date.now())
          ? \`<button class="btn btn-sm" onclick="clearCooldown('\${providerId}','\${p.id}')">解除</button>\` : '';
        return \`<tr><td>\${p.id}</td><td>\${status}</td><td>\${lu}</td><td>\${cd}</td><td>\${clearBtn}</td></tr>\`;
      }).join('');
      statusHtml += \`<h3 style="font-size:0.82rem;color:#a78bfa;margin:12px 0 6px">Provider: \${providerId}</h3>
        <table class="tbl"><thead><tr><th>ID</th><th>狀態</th><th>Last Used</th><th>Cooldown Until</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
    }
    document.getElementById('auth-statuses').innerHTML = statusHtml || '<p style="color:#888;font-size:0.8rem">無 provider 狀態</p>';
    document.getElementById('auth-msg').textContent = '';
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '讀取失敗：' + e; }
}

function onAuthProviderChange() {
  const provider = document.getElementById('auth-new-provider').value;
  const apikeyFields = document.getElementById('auth-apikey-fields');
  const oauthFields = document.getElementById('auth-oauth-fields');
  if (provider === 'openai-codex') {
    apikeyFields.style.display = 'none';
    oauthFields.style.display = 'contents';
  } else {
    apikeyFields.style.display = 'contents';
    oauthFields.style.display = 'none';
  }
}

let _codexOAuthPollTimer = null;
function _codexOAuthCleanup(success) {
  if (_codexOAuthPollTimer) { clearInterval(_codexOAuthPollTimer); _codexOAuthPollTimer = null; }
  if (!success) document.getElementById('codex-oauth-manual').style.display = 'none';
}

async function startCodexOAuth() {
  const statusEl = document.getElementById('codex-oauth-status');
  const manualEl = document.getElementById('codex-oauth-manual');
  const msgEl = document.getElementById('auth-msg');
  statusEl.textContent = '啟動 OAuth 流程...';
  statusEl.style.color = '#facc15';
  manualEl.style.display = 'none';
  try {
    const oauthName = document.getElementById('auth-oauth-id').value.trim() || 'oauth';
    const oauthType = document.getElementById('auth-oauth-type').value;
    const d = await authFetch('/api/codex-oauth-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName: oauthName, credType: oauthType }),
    }).then(r => r.json());
    if (d.error) { statusEl.textContent = d.error; statusEl.style.color = '#f87171'; return; }
    if (d.authUrl) {
      window.open(d.authUrl, '_blank');
      statusEl.textContent = '已開啟瀏覽器，等待登入完成...（5 分鐘內有效）';
      manualEl.style.display = 'block';
      // poll status
      if (_codexOAuthPollTimer) clearInterval(_codexOAuthPollTimer);
      _codexOAuthPollTimer = setInterval(async () => {
        try {
          const s = await authFetch('/api/codex-oauth-status').then(r => r.json());
          if (s.status === 'success') {
            _codexOAuthCleanup(true);
            manualEl.style.display = 'none';
            statusEl.textContent = 'OAuth 登入成功！Token 到期：' + s.expiresAt;
            statusEl.style.color = '#4ade80';
            msgEl.className = 'msg ok'; msgEl.textContent = 'Codex OAuth 登入完成';
            loadAuthProfiles();
          } else if (s.status === 'error') {
            _codexOAuthCleanup(false);
            statusEl.textContent = '失敗：' + s.error;
            statusEl.style.color = '#f87171';
          }
        } catch {}
      }, 2000);
    }
  } catch(e) { statusEl.textContent = '啟動失敗：' + e; statusEl.style.color = '#f87171'; }
}

async function submitCodexCallback() {
  const urlInput = document.getElementById('codex-oauth-url');
  const statusEl = document.getElementById('codex-oauth-status');
  const val = urlInput.value.trim();
  if (!val) return;
  statusEl.textContent = '正在處理 callback...';
  statusEl.style.color = '#facc15';
  try {
    const d = await authFetch('/api/codex-oauth-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackUrl: val }),
    }).then(r => r.json());
    if (d.error) { statusEl.textContent = '失敗：' + d.error; statusEl.style.color = '#f87171'; }
    else { statusEl.textContent = '已送出，等待處理...'; }
  } catch(e) { statusEl.textContent = '送出失敗：' + e; statusEl.style.color = '#f87171'; }
}

async function addAuthProfile() {
  const provider = document.getElementById('auth-new-provider').value;
  const name = document.getElementById('auth-new-id').value.trim() || 'default';
  const type = document.getElementById('auth-new-type').value;
  const cred = document.getElementById('auth-new-cred').value.trim();
  const id = provider + ':' + name;
  if (!cred) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = 'Credential 不能為空'; return; }
  if (cred.length < 10) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = 'Credential 長度不足（至少 10 字元）'; return; }
  try {
    const d = await authFetch('/api/auth-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',id,credential:cred,type})}).then(r=>r.json());
    if (d.success) { document.getElementById('auth-new-id').value = ''; document.getElementById('auth-new-cred').value = ''; document.getElementById('auth-msg').className = 'msg ok'; document.getElementById('auth-msg').textContent = '已新增 ' + id + '，重啟中...'; await authFetch('/api/restart',{method:'POST'}); setTimeout(() => { document.getElementById('auth-msg').textContent = '已新增 ' + id + '（已重啟）'; loadAuthProfiles(); }, 3000); }
    else { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = d.error; }
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

async function removeAuthProfile(id) {
  if (!confirm(\`確定刪除憑證 \${id}？\`)) return;
  try {
    await authFetch('/api/auth-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',id})});
    loadAuthProfiles();
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

async function clearCooldown(providerId, profileId) {
  try {
    await authFetch('/api/auth-profiles/clear-cooldown',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId,profileId})});
    loadAuthProfiles();
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

// ── Traces ──────────────────────────────────────────────────────────────────
function _traceRowHtml(t) {
  const ts = new Date(t.ts).toLocaleTimeString('zh-TW', {hour12:false});
  const dur = t.totalDurationMs ? (t.totalDurationMs/1000).toFixed(1)+'s' : '-';
  const ch = (t.channelId ?? '').slice(-6);
  const isLive = t.status === 'in_progress';
  const statusIcon = isLive ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'aborted' ? '⏹' : '❌';
  const ceData = t.contextEngineering;
  let ce = '-';
  let ceTooltip = '';
  if (ceData?.strategiesApplied?.length > 0) {
    const parts = ceData.strategiesApplied.map(s => {
      const detail = ceData.strategyDetails?.find(d => d.name === s);
      if (detail) {
        const saved = detail.tokensBefore - detail.tokensAfter;
        return s + (saved > 0 ? '(-' + (saved > 1000 ? (saved/1000).toFixed(1)+'K' : saved) + ')' : '');
      }
      return s;
    });
    ce = '📦 ' + parts.join(' ');
    // hover tooltip: per-strategy + per-message level changes
    const tipLines = [];
    for (const s of ceData.strategiesApplied) {
      const detail = ceData.strategyDetails?.find(d => d.name === s);
      if (!detail) continue;
      const saved = detail.tokensBefore - detail.tokensAfter;
      const affected = (detail.messagesDecayed ?? 0) + (detail.messagesRemoved ?? 0);
      tipLines.push(s + ': ' + affected + ' messages, 省 ' + saved.toLocaleString() + ' tokens');
      if (detail.levelChanges?.length) {
        for (const lc of detail.levelChanges.slice(0, 5)) {
          const tb = lc.tokensBefore > 1000 ? (lc.tokensBefore/1000).toFixed(1)+'K' : lc.tokensBefore;
          const ta = lc.tokensAfter > 1000 ? (lc.tokensAfter/1000).toFixed(1)+'K' : lc.tokensAfter;
          tipLines.push('  msg#' + lc.messageIndex + ': L' + lc.fromLevel + '→L' + lc.toLevel + ' (' + tb + '→' + ta + ')');
        }
        if (detail.levelChanges.length > 5) tipLines.push('  …+' + (detail.levelChanges.length - 5) + ' more');
      }
    }
    ceTooltip = tipLines.join('\\n');
  }
  const prev = (t.inbound?.textPreview ?? '').slice(0, 40);
  const cost = t.estimatedCostUsd ? '$' + t.estimatedCostUsd.toFixed(4) : '-';
  const ctxIcon = t.hasContextSnapshot ? '<span title="有 Context Snapshot，點擊查看" style="cursor:pointer">📋</span>' : '';
  const liveStyle = isLive ? 'background:rgba(255,200,0,0.08);' : '';
  let html = '<tr data-trace-id="' + t.traceId + '" style="border-bottom:1px solid var(--border);cursor:pointer;' + liveStyle + '" onclick="showTraceDetail(\\'' + t.traceId + '\\')">';
  html += '<td style="padding:4px;color:var(--fg2)">' + ts + '</td>';
  const agentBadge = t.agentId ? ' <span style="background:#7c3aed;color:#fff;font-size:0.6rem;padding:0 3px;border-radius:3px">' + t.agentId + '</span>' : '';
  html += '<td style="padding:4px">…' + ch + agentBadge + '</td>';
  html += '<td style="padding:4px;text-align:right">' + dur + '</td>';
  html += '<td style="padding:4px;text-align:right">' + (t.effectiveInputTokens ?? t.totalInputTokens ?? 0).toLocaleString() + '</td>';
  html += '<td style="padding:4px;text-align:right">' + (t.totalOutputTokens ?? 0).toLocaleString() + '</td>';
  html += '<td style="padding:4px;text-align:right;color:var(--fg2)">' + (t.totalCacheRead ?? 0).toLocaleString() + '/' + (t.totalCacheWrite ?? 0).toLocaleString() + '</td>';
  html += '<td style="padding:4px;text-align:right">' + (t.totalToolCalls ?? 0) + '</td>';
  html += '<td style="padding:4px;text-align:right">' + (t.llmCalls?.length ?? 0) + '</td>';
  html += '<td style="padding:4px;text-align:center"' + (ceTooltip ? ' title="' + ceTooltip.replace(/"/g, '&quot;') + '"' : '') + '>' + ce + '</td>';
  html += '<td style="padding:4px;text-align:center">' + statusIcon + '</td>';
  html += '<td style="padding:4px;text-align:right;color:var(--warn)">' + cost + '</td>';
  html += '<td style="padding:4px;text-align:center">' + ctxIcon + '</td>';
  html += '<td style="padding:4px;color:var(--fg2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + prev + '</td>';
  html += '</tr>';
  return html;
}

const _traceTableHeader = (() => {
  const tip = (label, desc) => label + ' <span class="th-tip" title="' + desc + '">?</span>';
  let h = '<tr style="border-bottom:1px solid var(--border);color:var(--fg2)">';
  h += '<th style="text-align:left;padding:4px">時間</th>';
  h += '<th style="text-align:left;padding:4px">Channel</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('Duration', '從收到訊息到回覆完成的總耗時') + '</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('↑ Effective', 'LLM 實際處理的 input tokens（新送 + cache read + cache write）') + '</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('↓ Out', 'LLM 產出的 output tokens') + '</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('Cache R/W', 'Cache Read（10%價）/ Cache Write（125%價）的 token 數') + '</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('Tools', '本次 turn 呼叫的工具總次數') + '</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('LLM', 'LLM 來回呼叫次數（含 tool use 迴圈）') + '</th>';
  h += '<th style="text-align:center;padding:4px">' + tip('CE', 'Context Engineering 策略（compaction 等）') + '</th>';
  h += '<th style="text-align:center;padding:4px">Status</th>';
  h += '<th style="text-align:right;padding:4px">' + tip('Cost', '預估 API 費用（USD）') + '</th>';
  h += '<th style="text-align:center;padding:4px">' + tip('Ctx', '有完整 Context Snapshot（system prompt + messages）') + '</th>';
  h += '<th style="text-align:left;padding:4px">Preview</th>';
  h += '</tr>';
  return h;
})();

async function loadTraces() {
  const limit = document.getElementById('trace-limit')?.value ?? 50;
  const el = document.getElementById('trace-list');
  try {
    // 同時 fetch live + completed traces
    const [liveRes, histRes] = await Promise.all([
      authFetch('/api/traces/live').then(r => r.json()),
      authFetch('/api/traces?limit=' + limit).then(r => r.json()),
    ]);
    const liveTraces = liveRes.traces || [];
    const histTraces = histRes.traces || [];
    // 合併：live 在前（按時間倒序），去重
    const seenIds = new Set();
    let merged = [];
    for (const t of liveTraces) { seenIds.add(t.traceId); merged.push(t); }
    for (const t of histTraces) { if (!seenIds.has(t.traceId)) merged.push(t); }
    // Agent ID 篩選
    const agentFilter = (document.getElementById('trace-agent-filter')?.value ?? '').trim();
    if (agentFilter) merged = merged.filter(t => t.agentId && t.agentId.includes(agentFilter));
    const statusFilter = (document.getElementById('trace-status-filter')?.value ?? '').trim();
    if (statusFilter) merged = merged.filter(t => t.status === statusFilter);
    const categoryFilter = (document.getElementById('trace-category-filter')?.value ?? '').trim();
    if (categoryFilter) merged = merged.filter(t => t.category === categoryFilter);
    const ceFilter = (document.getElementById('trace-ce-filter')?.value ?? '').trim();
    if (ceFilter === 'any') merged = merged.filter(t => t.contextEngineering?.strategiesApplied?.length > 0);
    else if (ceFilter) merged = merged.filter(t => t.contextEngineering?.strategiesApplied?.includes(ceFilter));

    if (merged.length === 0) { el.innerHTML = '<div style="color:var(--fg2)">無 trace 記錄</div>'; return; }

    // 差量更新：如果表格已存在，只更新變更的 row
    const existingTable = el.querySelector('table');
    if (existingTable) {
      const tbody = existingTable.querySelector('tbody');
      if (tbody) {
        const existingRows = tbody.querySelectorAll('tr[data-trace-id]');
        const existingIds = new Map();
        existingRows.forEach(r => existingIds.set(r.getAttribute('data-trace-id'), r));
        // 重建 tbody 但保留 detail card 外的展開狀態
        let newTbody = '';
        for (const t of merged) newTbody += _traceRowHtml(t);
        tbody.innerHTML = newTbody;
        return;
      }
    }

    // 首次建立表格
    let html = '<table style="width:100%;border-collapse:collapse;font-size:0.82rem"><thead>' + _traceTableHeader + '</thead><tbody>';
    for (const t of merged) html += _traceRowHtml(t);
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) { if (!el.querySelector('table')) el.innerHTML = '<div style="color:var(--red2)">載入失敗：' + e + '</div>'; }
}

// ── Trace Context Helpers ────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/** 展開/收合 toggle */
function toggleCollapse(btn, targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? 'block' : 'none';
  btn.textContent = btn.textContent.replace(hidden ? '▶' : '▼', hidden ? '▼' : '▶');
}

/** CE 壓縮 Level 標籤 */
function ceLevelBadge(m) {
  const ce = m._ce || (m.compressionLevel != null && m.compressionLevel > 0 ? { compressed: true, compressionLevel: m.compressionLevel, originalTokens: m.originalTokens, currentTokens: m.tokens, compressedBy: m.compressedBy } : null);
  if (!ce?.compressed) return '';
  const lvl = ce.compressionLevel;
  const colors = ['', '#3b82f6', '#f59e0b', '#ef4444'];
  const labels = ['', 'L1 精簡', 'L2 核心', 'L3 stub'];
  const color = colors[lvl] || '#ef4444';
  const label = labels[lvl] || 'L' + lvl;
  const orig = ce.originalTokens ? ce.originalTokens.toLocaleString() : '?';
  const cur = ce.currentTokens ? ce.currentTokens.toLocaleString() : '?';
  const by = ce.compressedBy ? ' by ' + ce.compressedBy : '';
  return ' <span style="background:' + color + ';color:#fff;font-size:0.65rem;padding:1px 4px;border-radius:3px;cursor:help" title="原始 ' + orig + ' tokens → 壓縮後 ' + cur + ' tokens（' + label + by + '）">' + label + '</span>';
}

/** 渲染 messages 陣列為 HTML（truncated per-message） */
function renderMessages(msgs, containerId) {
  if (!msgs || msgs.length === 0) return '<div style="color:var(--fg2)">（空）</div>';
  let html = '<div id="' + containerId + '" style="max-height:400px;overflow-y:auto;font-size:0.78rem">';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const role = m.role ?? '?';
    const roleColor = role === 'assistant' ? 'var(--accent)' : role === 'user' ? 'var(--green2)' : 'var(--fg2)';
    let contentText = '';
    if (typeof m.content === 'string') {
      contentText = m.content;
    } else if (Array.isArray(m.content)) {
      contentText = m.content.map(b => {
        if (b.type === 'text') return b.text ?? '';
        if (b.type === 'tool_use') return '[tool_use: ' + (b.name ?? b.id ?? '?') + ']';
        if (b.type === 'tool_result') return '[tool_result: ' + (b.tool_use_id ?? '?') + ']';
        return '[' + (b.type ?? '?') + ']';
      }).join(' ');
    }
    const preview = contentText.length > 300 ? contentText.slice(0, 300) + '…' : contentText;
    const msgId = containerId + '_msg_' + i;
    const ceInfo = m._ce || (m.compressionLevel != null && m.compressionLevel > 0);
    const bgStyle = ceInfo ? 'background:rgba(59,130,246,0.06);' : '';
    html += '<div style="border-top:1px solid var(--border);padding:4px 0;' + bgStyle + '">';
    html += '<span style="color:' + roleColor + ';font-weight:bold">[' + role + ']</span>' + ceLevelBadge(m) + ' ';
    html += '<span style="color:var(--fg2)" id="' + msgId + '_short">' + esc(preview) + '</span>';
    if (contentText.length > 300) {
      html += '<span id="' + msgId + '_full" style="display:none;color:var(--fg2);white-space:pre-wrap;word-break:break-all">' + esc(contentText) + '</span>';
      html += ' <a href="#" style="color:var(--accent);font-size:0.72rem" onclick="event.preventDefault();var s=document.getElementById(\\'' + msgId + '_short\\'),f=document.getElementById(\\'' + msgId + '_full\\');if(f.style.display===\\'none\\'){f.style.display=\\'inline\\';s.style.display=\\'none\\';this.textContent=\\'收合\\'}else{f.style.display=\\'none\\';s.style.display=\\'inline\\';this.textContent=\\'展開全文\\'}">展開全文</a>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

/** 載入並渲染 context snapshot */
let _ctxCache = {};
async function loadTraceContext(traceId) {
  if (_ctxCache[traceId]) return _ctxCache[traceId];
  const r = await authFetch('/api/traces/' + traceId + '/context');
  if (!r.ok) return null;
  const data = await r.json();
  _ctxCache[traceId] = data;
  return data;
}

async function showTraceDetail(traceId) {
  const card = document.getElementById('trace-detail-card');
  const el = document.getElementById('trace-detail');
  const idEl = document.getElementById('trace-detail-id');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  idEl.textContent = traceId;
  el.innerHTML = '<div style="color:var(--fg2)">載入中…</div>';
  try {
    const t = await authFetch('/api/traces/' + traceId).then(r => r.json());
    let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';

    // Phase 1: Inbound
    html += '<div class="card" style="background:var(--bg4)">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">① Inbound</h3>';
    html += '<div style="font-size:0.82rem">';
    html += '<div>Text: <span style="color:var(--fg2)">' + esc(t.inbound?.textPreview ?? '-') + '</span></div>';
    html += '<div>Chars: ' + (t.inbound?.charCount ?? 0) + ' | Attachments: ' + (t.inbound?.attachments ?? 0) + '</div>';
    if (t.inbound?.debounceMs) html += '<div>Debounce: ' + t.inbound.debounceMs + 'ms</div>';
    if (t.inbound?.interruptedPrevious) html += '<div style="color:var(--warn)">⚠ Interrupted previous turn</div>';
    html += '</div></div>';

    // Phase 2: Context
    html += '<div class="card" style="background:var(--bg4)">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">② Context Assembly</h3>';
    if (t.context) {
      html += '<div style="font-size:0.82rem">';
      html += '<div>Duration: ' + (t.context.endMs - t.context.startMs) + 'ms</div>';
      html += '<div>System Prompt: ~' + t.context.systemPromptTokens + ' tokens</div>';
      if (t.context.historyMessageCount > 0) {
        html += '<div>History: ' + t.context.historyMessageCount + ' msgs (~' + t.context.historyTokens + ' tokens)</div>';
      }
      html += '<div style="color:var(--accent2)">Total Context: ~' + t.context.totalContextTokens + ' tokens</div>';
      if (t.context.memoryRecall) {
        const r = t.context.memoryRecall;
        html += '<div style="margin-top:4px;padding:4px;background:var(--bg3);border-radius:4px">';
        html += '<div>🧠 Memory Recall (' + r.durationMs + 'ms)</div>';
        html += '<div>Fragments: ' + r.fragmentCount + ' | Tokens: ' + r.injectedTokens + '</div>';
        if (r.hits?.length > 0) {
          const badgeColor = { vector: 'var(--accent)', keyword: 'var(--warn)', related: 'var(--accent2)' };
          html += '<div style="margin-top:3px;font-size:0.78rem;display:flex;flex-wrap:wrap;gap:4px">';
          for (const h of r.hits) {
            const c = badgeColor[h.matchedBy] || 'var(--fg2)';
            html += '<span style="border:1px solid ' + c + ';color:' + c + ';border-radius:3px;padding:0 4px">'
              + h.name + ' <small>' + h.matchedBy + ' ' + h.score + '</small></span>';
          }
          html += '</div>';
        } else {
          html += '<div style="color:var(--fg2);font-size:0.78rem">' + r.atomNames.join(', ') + '</div>';
        }
        if (r.degraded) html += '<div style="color:var(--warn)">⚠ Degraded (keyword fallback)</div>';
        html += '</div>';
      }
      if (t.context.inboundHistory) {
        html += '<div style="margin-top:4px">📨 Inbound History: ~' + t.context.inboundHistory.tokens + ' tokens</div>';
      }
      html += '</div>';
    } else { html += '<div style="color:var(--fg2);font-size:0.82rem">N/A</div>'; }
    html += '</div>';

    // Phase 3: LLM Calls (full width)
    html += '</div>'; // close grid
    html += '<div class="card" style="background:var(--bg4);margin-top:12px">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">③ LLM Call Loop (' + (t.llmCalls?.length ?? 0) + ' iterations)</h3>';
    if (t.llmCalls?.length > 0) {
      for (const call of t.llmCalls) {
        html += '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;font-size:0.82rem">';
        const toolNames = (call.toolCalls ?? []).map(tc => tc.name);
        const uniqueTools = [...new Set(toolNames)];
        const toolSummary = uniqueTools.length > 0 ? uniqueTools.slice(0, 3).join(', ') + (uniqueTools.length > 3 ? ' +' + (uniqueTools.length - 3) : '') : '';
        const purpose = call.stopReason === 'end_turn' ? ' → 💬 回覆'
          : call.stopReason === 'tool_use' ? ' → 🔧 ' + (toolSummary || '(tool)')
          : toolSummary ? ' → ' + toolSummary : '';
        html += '<div style="display:flex;justify-content:space-between;align-items:baseline">';
        html += '<span><b>Loop #' + call.iteration + '</b> — ' + (call.model ?? '?') + '<span style="color:var(--fg2)">' + purpose + '</span></span>';
        html += '<span style="color:var(--fg2)">' + (call.durationMs/1000).toFixed(1) + 's</span>';
        html += '</div>';
        const effIn = call.inputTokens + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0);
        html += '<div style="display:flex;gap:12px;margin-top:2px;color:var(--fg2)">';
        html += '<span>↑ ' + effIn.toLocaleString() + ' <span style="font-size:0.75rem">(new:' + call.inputTokens.toLocaleString() + ')</span></span>';
        html += '<span>↓ ' + call.outputTokens.toLocaleString() + '</span>';
        if (call.cacheRead > 0 || call.cacheWrite > 0) {
          html += '<span style="font-size:0.75rem">cache R:' + call.cacheRead.toLocaleString() + ' W:' + call.cacheWrite.toLocaleString() + '</span>';
        }
        if (call.stopReason && call.stopReason !== 'tool_use' && call.stopReason !== 'end_turn') html += '<span style="font-size:0.75rem">stop:' + call.stopReason + '</span>';
        html += '</div>';
        if (call.toolCalls?.length > 0) {
          html += '<div style="margin-top:4px">';
          for (const tc of call.toolCalls) {
            const tcColor = tc.error ? 'var(--red2)' : 'var(--green2)';
            html += '<div style="padding:2px 0;border-top:1px solid var(--border)">';
            html += '<span style="color:' + tcColor + '">🔧 ' + tc.name + '</span>';
            html += ' <span style="color:var(--fg2)">' + tc.durationMs + 'ms</span>';
            if (tc.paramsPreview) html += ' <span style="color:var(--accent2);font-size:0.75rem">' + esc(tc.paramsPreview).slice(0, 80) + '</span>';
            if (tc.error) html += ' <span style="color:var(--red2)">❌ ' + esc(tc.error).slice(0, 60) + '</span>';
            else if (tc.resultPreview) html += ' <span style="color:var(--fg3);font-size:0.75rem">→ ' + esc(tc.resultPreview).slice(0, 60) + '</span>';
            html += '</div>';
          }
          html += '</div>';
        } else if (call.stopReason === 'end_turn') {
          html += '<div style="margin-top:4px;color:var(--fg2);font-size:0.78rem;font-style:italic">💬 最終回覆（無工具呼叫）</div>';
        }
        html += '</div>';
      }
    } else { html += '<div style="color:var(--fg2);font-size:0.82rem">No LLM calls</div>'; }
    html += '</div>';

    // Workflow Events
    if (t.workflowEvents?.length > 0) {
      html += '<div class="card" style="background:var(--bg4);margin-top:12px">';
      html += '<h3 style="color:var(--accent);margin-bottom:6px">⚙ Workflow Events (' + t.workflowEvents.length + ')</h3>';
      for (const we of t.workflowEvents) {
        const weTs = new Date(we.ts).toLocaleTimeString('zh-TW', {hour12:false});
        const typeColor = we.type === 'rut' || we.type === 'oscillation' ? 'var(--warn)' : we.type === 'file_modified' ? 'var(--green2)' : 'var(--accent2)';
        html += '<div style="padding:2px 0;border-top:1px solid var(--border);font-size:0.82rem">';
        html += '<span style="color:var(--fg2)">' + weTs + '</span> ';
        html += '<span style="color:' + typeColor + ';font-weight:bold">' + we.type + '</span> ';
        html += '<span style="color:var(--fg2)">' + esc(we.detail || '') + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Phase 4-7 grid
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">';

    // Phase 4: CE
    html += '<div class="card" style="background:var(--bg4)">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">④ Context Engineering</h3>';
    if (t.contextEngineering) {
      html += '<div style="font-size:0.82rem">';
      html += '<div>Strategies: ' + t.contextEngineering.strategiesApplied.join(', ') + '</div>';
      html += '<div>Before: ' + t.contextEngineering.tokensBeforeCE.toLocaleString() + ' → After: ' + t.contextEngineering.tokensAfterCE.toLocaleString() + '</div>';
      html += '<div style="color:var(--green2)">Saved: ' + t.contextEngineering.tokensSaved.toLocaleString() + ' tokens</div>';
      if (t.contextEngineering.overflowSignaled) html += '<div style="color:var(--red)">⚠ Overflow Hard Stop triggered</div>';
      if (t.contextEngineering.strategyDetails?.length) {
        html += '<table style="font-size:0.78rem;margin-top:4px;width:100%;border-collapse:collapse">';
        html += '<tr style="color:var(--fg2)"><th style="text-align:left;padding:2px 4px">Strategy</th><th style="text-align:right;padding:2px 4px">Before</th><th style="text-align:right;padding:2px 4px">After</th><th style="text-align:right;padding:2px 4px">Saved</th><th style="text-align:right;padding:2px 4px">Removed</th></tr>';
        for (const sd of t.contextEngineering.strategyDetails) {
          const saved = sd.tokensBefore - sd.tokensAfter;
          html += '<tr><td style="padding:2px 4px">' + esc(sd.name) + '</td>';
          html += '<td style="text-align:right;padding:2px 4px">' + sd.tokensBefore.toLocaleString() + '</td>';
          html += '<td style="text-align:right;padding:2px 4px">' + sd.tokensAfter.toLocaleString() + '</td>';
          html += '<td style="text-align:right;padding:2px 4px;color:var(--green2)">' + (saved > 0 ? '-' + saved.toLocaleString() : '0') + '</td>';
          html += '<td style="text-align:right;padding:2px 4px">' + (sd.messagesRemoved || 0) + '</td></tr>';
          if (sd.levelChanges?.length) {
            html += '<tr><td colspan="5" style="padding:2px 4px 6px 16px;color:var(--fg2);font-size:0.72rem">';
            for (const lc of sd.levelChanges.slice(0, 10)) {
              html += 'msg#' + lc.messageIndex + ': L' + lc.fromLevel + '→L' + lc.toLevel + ' (' + lc.tokensBefore.toLocaleString() + '→' + lc.tokensAfter.toLocaleString() + ')&nbsp;&nbsp;';
            }
            if (sd.levelChanges.length > 10) html += '…+' + (sd.levelChanges.length - 10) + ' more';
            html += '</td></tr>';
          }
        }
        html += '</table>';
      }
      html += '</div>';
    } else { html += '<div style="color:var(--fg2);font-size:0.82rem">Not triggered</div>'; }
    html += '</div>';

    // Phase 6: Post-process
    html += '<div class="card" style="background:var(--bg4)">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">⑥ Post-process</h3>';
    if (t.postProcess) {
      html += '<div style="font-size:0.82rem">';
      html += '<div>Extract: ' + (t.postProcess.extractRan ? '✅' : '⏭') + '</div>';
      html += '<div>Snapshot kept: ' + (t.postProcess.sessionSnapshotKept ? '✅' : '❌') + '</div>';
      html += '<div>Session note: ' + (t.postProcess.sessionNoteUpdated ? '✅' : '⏭') + '</div>';
      if (t.postProcess.toolLogPath) html += '<div style="color:var(--fg2)">Log: ' + t.postProcess.toolLogPath + '</div>';
      html += '</div>';
    } else { html += '<div style="color:var(--fg2);font-size:0.82rem">N/A</div>'; }
    html += '</div>';

    // Phase 5: Abort (if any)
    if (t.abort) {
      html += '<div class="card" style="background:var(--bg4)">';
      html += '<h3 style="color:var(--warn);margin-bottom:6px">⑤ Abort</h3>';
      html += '<div style="font-size:0.82rem">';
      html += '<div>Trigger: ' + t.abort.trigger + '</div>';
      html += '<div>Rollback: ' + (t.abort.rollback ? '✅' : '❌') + '</div>';
      html += '</div></div>';
    }

    // Phase 7: Response
    html += '<div class="card" style="background:var(--bg4)">';
    html += '<h3 style="color:var(--accent);margin-bottom:6px">⑦ Response</h3>';
    if (t.response) {
      html += '<div style="font-size:0.82rem">';
      html += '<div>Chars: ' + t.response.charCount + ' | Duration: ' + (t.response.durationMs/1000).toFixed(1) + 's</div>';
      html += '<div style="color:var(--fg2);margin-top:4px">' + esc(t.response.textPreview ?? '') + '</div>';
      html += '</div>';
    } else { html += '<div style="color:var(--fg2);font-size:0.82rem">N/A</div>'; }
    html += '</div>';

    html += '</div>'; // close grid

    // ── Context Snapshot（lazy-load 展開區）────────────────────────────────
    if (t.hasContextSnapshot) {
      html += '<div class="card" style="background:var(--bg4);margin-top:12px;border:1px solid var(--accent)">';
      html += '<h3 style="color:var(--accent);margin-bottom:6px;cursor:pointer" onclick="loadAndShowContext(\\'' + traceId + '\\')">';
      html += '📋 Context Snapshot <span style="font-size:0.78rem;color:var(--fg2)">（點擊載入完整 system prompt + messages）</span></h3>';
      html += '<div id="ctx-snapshot-' + traceId + '" style="display:none"></div>';
      html += '</div>';
    }

    // Summary bar
    html += '<div style="margin-top:12px;padding:8px;background:var(--bg3);border-radius:6px;font-size:0.82rem;display:flex;gap:16px;flex-wrap:wrap">';
    html += '<span>Total: ' + (t.totalDurationMs/1000).toFixed(1) + 's</span>';
    html += '<span>↑ Effective: ' + (t.effectiveInputTokens ?? t.totalInputTokens ?? 0).toLocaleString() + '</span>';
    html += '<span>↑ New: ' + (t.totalInputTokens ?? 0).toLocaleString() + '</span>';
    html += '<span>Cache R: ' + (t.totalCacheRead ?? 0).toLocaleString() + ' W: ' + (t.totalCacheWrite ?? 0).toLocaleString() + '</span>';
    html += '<span>↓ ' + (t.totalOutputTokens ?? 0).toLocaleString() + '</span>';
    html += '<span>Tools: ' + (t.totalToolCalls ?? 0) + '</span>';
    if (t.estimatedCostUsd) html += '<span style="color:var(--warn)">💰 $' + t.estimatedCostUsd.toFixed(4) + '</span>';
    html += '<span>Status: ' + (t.status === 'completed' ? '✅' : t.status === 'aborted' ? '⏹' : '❌') + ' ' + t.status + '</span>';
    if (t.error) html += '<span style="color:var(--red2)">Error: ' + esc(t.error) + '</span>';
    html += '</div>';

    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="color:var(--red2)">載入失敗：' + e + '</div>'; }
}

/** 載入並渲染 context snapshot（lazy） */
async function loadAndShowContext(traceId) {
  const container = document.getElementById('ctx-snapshot-' + traceId);
  if (!container) return;
  if (container.style.display === 'block') { container.style.display = 'none'; return; }
  container.style.display = 'block';
  container.innerHTML = '<div style="color:var(--fg2)">載入 context snapshot…</div>';
  try {
    const ctx = await loadTraceContext(traceId);
    if (!ctx) { container.innerHTML = '<div style="color:var(--fg2)">Context snapshot 不存在或已過期</div>'; return; }
    let html = '';

    // System Prompt（雙模式：原始 / 模組）
    const spLen = (ctx.systemPrompt ?? '').length;
    const spTokens = Math.ceil(spLen / 4);
    const bd = ctx.promptBreakdown;
    const hasSegments = bd?.segments?.length > 0;

    html += '<div style="margin-bottom:12px">';
    // Tab 切換（只在有 segments 時顯示）
    if (hasSegments) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
      html += '<span style="font-size:0.78rem;color:var(--fg2)">System Prompt</span>';
      html += '<span style="font-size:0.72rem;color:var(--fg2)">(' + spLen.toLocaleString() + ' chars, ~' + spTokens.toLocaleString() + ' tokens)</span>';
      html += '<div style="display:flex;gap:2px;margin-left:auto">';
      html += '<button class="btn btn-sm" style="font-size:0.7rem" onclick="document.getElementById(\\'ctx-sp-raw-' + traceId + '\\').style.display=\\'block\\';document.getElementById(\\'ctx-sp-mod-' + traceId + '\\').style.display=\\'none\\';this.style.background=\\'var(--purple)\\';this.nextElementSibling.style.background=\\'var(--bg3)\\'">原始</button>';
      html += '<button class="btn btn-sm" style="font-size:0.7rem;background:var(--bg3)" onclick="document.getElementById(\\'ctx-sp-mod-' + traceId + '\\').style.display=\\'block\\';document.getElementById(\\'ctx-sp-raw-' + traceId + '\\').style.display=\\'none\\';this.style.background=\\'var(--purple)\\';this.previousElementSibling.style.background=\\'var(--bg3)\\'">模組</button>';
      html += '</div></div>';
    } else {
      html += '<h4 style="color:var(--accent2);margin-bottom:4px;cursor:pointer" onclick="var e=document.getElementById(\\'ctx-sp-raw-' + traceId + '\\');e.style.display=e.style.display===\\'none\\'?\\'block\\':\\'none\\'">';
      html += '▶ System Prompt <span style="font-size:0.78rem;color:var(--fg2)">(' + spLen.toLocaleString() + ' chars, ~' + spTokens.toLocaleString() + ' tokens)</span></h4>';
    }

    // 原始模式
    html += '<div id="ctx-sp-raw-' + traceId + '" style="' + (hasSegments ? '' : 'display:none;') + 'max-height:500px;overflow-y:auto;background:var(--bg3);padding:8px;border-radius:4px;font-size:0.75rem;white-space:pre-wrap;word-break:break-all;color:var(--fg2)">';
    html += esc(ctx.systemPrompt ?? '');
    html += '</div>';

    // 模組模式
    if (hasSegments) {
      html += '<div id="ctx-sp-mod-' + traceId + '" style="display:none">';
      var segs = bd.segments;
      var sp = ctx.systemPrompt ?? '';
      // 摘要列表
      html += '<div style="font-size:0.78rem;color:var(--fg2);display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:8px">';
      html += '<span style="color:var(--accent2)">Assembler 模組:</span>';
      html += '<span>' + (bd.assemblerModules?.length ? bd.assemblerModules.map(function(m) { return '<code style="background:var(--bg3);padding:1px 4px;border-radius:3px;margin-right:3px">' + esc(m) + '</code>'; }).join('') : '—') + '</span>';
      html += '<span style="color:var(--accent2)">Agent-Loop 區塊:</span>';
      html += '<span>' + (bd.agentLoopBlocks?.length ? bd.agentLoopBlocks.map(function(b) { return '<code style="background:var(--bg3);padding:1px 4px;border-radius:3px;margin-right:3px">' + esc(b) + '</code>'; }).join('') : '—') + '</span>';
      html += '</div>';
      // 各段落可展開
      for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        var segContent = sp.substring(seg.offset, seg.offset + seg.length);
        var segId = 'ctx-seg-' + traceId + '-' + si;
        html += '<div style="margin-bottom:4px;border-left:3px solid var(--accent);padding-left:8px">';
        html += '<div style="cursor:pointer;font-size:0.78rem;color:var(--accent2)" onclick="var e=document.getElementById(\\'' + segId + '\\');e.style.display=e.style.display===\\'none\\'?\\'block\\':\\'none\\'">';
        html += '▶ <code>' + esc(seg.name) + '</code> <span style="color:var(--fg3)">(' + seg.length + ' chars)</span></div>';
        html += '<div id="' + segId + '" style="display:none;max-height:300px;overflow-y:auto;background:var(--bg3);padding:6px;border-radius:4px;font-size:0.72rem;white-space:pre-wrap;word-break:break-all;color:var(--fg2);margin-top:2px">';
        html += esc(segContent);
        html += '</div></div>';
      }
      // 未被 segments 覆蓋的殘餘區段（agent-loop 追加的區塊）
      if (segs.length > 0) {
        var lastSeg = segs[segs.length - 1];
        var lastEnd = lastSeg.offset + lastSeg.length;
        if (lastEnd < sp.length) {
          var remainder = sp.substring(lastEnd).replace(/^\\n+/, '');
          if (remainder.length > 0) {
            var remId = 'ctx-seg-' + traceId + '-rem';
            html += '<div style="margin-bottom:4px;border-left:3px solid var(--fg3);padding-left:8px">';
            html += '<div style="cursor:pointer;font-size:0.78rem;color:var(--fg3)" onclick="var e=document.getElementById(\\'' + remId + '\\');e.style.display=e.style.display===\\'none\\'?\\'block\\':\\'none\\'">';
            html += '▶ <code>agent-loop 追加</code> <span style="color:var(--fg3)">(' + remainder.length + ' chars)</span></div>';
            html += '<div id="' + remId + '" style="display:none;max-height:300px;overflow-y:auto;background:var(--bg3);padding:6px;border-radius:4px;font-size:0.72rem;white-space:pre-wrap;word-break:break-all;color:var(--fg2);margin-top:2px">';
            html += esc(remainder);
            html += '</div></div>';
          }
        }
      }
      html += '</div>';
    }
    html += '</div>';

    // CE Comparison
    if (ctx.ceApplied && ctx.messagesBeforeCE) {
      html += '<div style="margin-bottom:12px;border:1px solid var(--warn);border-radius:6px;padding:8px">';
      html += '<h4 style="color:var(--warn);margin-bottom:8px">📦 Context Engineering 壓縮對比</h4>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';

      // Before CE
      html += '<div>';
      html += '<div style="font-size:0.78rem;color:var(--fg2);margin-bottom:4px"><b>壓縮前</b> (' + ctx.messagesBeforeCE.length + ' messages)</div>';
      html += renderMessages(ctx.messagesBeforeCE, 'ctx-before-' + traceId);
      html += '</div>';

      // After CE
      html += '<div>';
      html += '<div style="font-size:0.78rem;color:var(--fg2);margin-bottom:4px"><b>壓縮後</b> (' + ctx.messagesAfterCE.length + ' messages)</div>';
      html += renderMessages(ctx.messagesAfterCE, 'ctx-after-' + traceId);
      html += '</div>';

      html += '</div></div>';
    } else {
      // No CE — just show messages
      html += '<div>';
      html += '<h4 style="color:var(--accent2);margin-bottom:4px;cursor:pointer" onclick="var e=document.getElementById(\\'ctx-msgs-' + traceId + '\\');e.style.display=e.style.display===\\'none\\'?\\'block\\':\\'none\\'">';
      html += '▶ Messages <span style="font-size:0.78rem;color:var(--fg2)">(' + (ctx.messagesAfterCE?.length ?? 0) + ' messages)</span></h4>';
      html += '<div id="ctx-msgs-' + traceId + '" style="display:none">';
      html += renderMessages(ctx.messagesAfterCE, 'ctx-msgs-inner-' + traceId);
      html += '</div></div>';
    }

    container.innerHTML = html;
  } catch (e) { container.innerHTML = '<div style="color:var(--red2)">載入失敗：' + e + '</div>'; }
}

// ── Memory ─────────────────────────────────────────────────────────────────
let _memAtoms = [];

async function loadMemory() {
  try {
    const [atoms, stats] = await Promise.all([
      authFetch('/api/memory/atoms').then(r => r.json()),
      authFetch('/api/memory/stats').then(r => r.json()),
    ]);
    _memAtoms = atoms;
    renderMemStats(stats);
    renderMemAtoms(atoms);
  } catch (e) {
    document.getElementById('mem-stats').textContent = '載入失敗: ' + e.message;
  }
}

function renderMemStats(s) {
  const confColors = { '[固]': 'var(--green)', '[觀]': 'var(--accent)', '[臨]': 'var(--warn)' };
  const confHtml = Object.entries(s.byConfidence).map(([k, v]) =>
    '<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:' + (confColors[k]||'var(--fg2)') + ';color:#fff;font-size:0.78rem;margin-right:4px">' + k + ' ' + v + '</span>'
  ).join('');

  const distHtml = s.confirmationDistribution.map(d => {
    const pct = s.totalAtoms ? Math.round(d.count / s.totalAtoms * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span style="width:40px;font-size:0.78rem;text-align:right">' + d.range + '</span><div style="flex:1;height:16px;background:var(--bg2);border-radius:4px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:4px"></div></div><span style="font-size:0.75rem;width:30px">' + d.count + '</span></div>';
  }).join('');

  document.getElementById('mem-stats').innerHTML =
    '<div style="margin-bottom:8px"><strong>' + s.totalAtoms + '</strong> atoms</div>' +
    '<div style="margin-bottom:8px">' + confHtml + '</div>' +
    '<div style="margin-bottom:8px"><div style="font-size:0.78rem;color:var(--fg2);margin-bottom:4px">Confirmations 分布</div>' + distHtml + '</div>' +
    (s.neverRecalled.length ? '<div style="font-size:0.78rem;color:var(--warn)">從未召回: ' + s.neverRecalled.map(a => a.name).join(', ') + '</div>' : '');
}

function renderMemAtoms(atoms) {
  if (!atoms.length) { document.getElementById('mem-atoms').innerHTML = '<div style="color:var(--fg3);padding:12px">無 atom</div>'; return; }
  const confColors = { '[固]': 'var(--green)', '[觀]': 'var(--accent)', '[臨]': 'var(--warn)' };
  const rows = atoms.map(a =>
    '<tr style="cursor:pointer" onclick="showMemDetail(\\'' + a.name.replace(/'/g,"\\\\'") + '\\')">' +
    '<td style="font-weight:500">' + a.name + '</td>' +
    '<td><span style="color:' + (confColors[a.confidence]||'var(--fg2)') + '">' + a.confidence + '</span></td>' +
    '<td>' + a.confirmations + '</td>' +
    '<td>' + (a.lastUsed||'-') + '</td>' +
    '<td style="font-size:0.75rem;color:var(--fg2)">' + (a.triggers||[]).slice(0,4).join(', ') + '</td>' +
    '<td><button class="btn btn-sm btn-red" onclick="event.stopPropagation();deleteMemAtom(\\'' + a.name.replace(/'/g,"\\\\'") + '\\')" title="刪除">🗑</button></td>' +
    '</tr>'
  ).join('');
  document.getElementById('mem-atoms').innerHTML =
    '<table class="tbl"><thead><tr><th>名稱</th><th>信心</th><th>確認</th><th>Last Used</th><th>Triggers</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function filterMemAtoms() {
  const q = document.getElementById('mem-filter').value.toLowerCase();
  const filtered = _memAtoms.filter(a => a.name.includes(q) || (a.triggers||[]).some(t => t.toLowerCase().includes(q)) || (a.description||'').toLowerCase().includes(q));
  renderMemAtoms(filtered);
}

function sortMemAtoms() {
  const key = document.getElementById('mem-sort').value;
  const sorted = [..._memAtoms];
  if (key === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (key === 'confirmations') sorted.sort((a, b) => b.confirmations - a.confirmations);
  else if (key === 'lastUsed') sorted.sort((a, b) => (b.lastUsed||'').localeCompare(a.lastUsed||''));
  else if (key === 'confidence') sorted.sort((a, b) => { const o = {'[固]':0,'[觀]':1,'[臨]':2}; return (o[a.confidence]??3) - (o[b.confidence]??3); });
  renderMemAtoms(sorted);
}

async function showMemDetail(name) {
  try {
    const atom = await authFetch('/api/memory/atoms/' + encodeURIComponent(name)).then(r => r.json());
    document.getElementById('mem-detail-title').textContent = atom.name;
    document.getElementById('mem-detail-content').textContent = atom.content || atom.raw || '(空)';
    document.getElementById('mem-detail-meta').innerHTML =
      '<strong>Confidence:</strong> ' + atom.confidence + ' | <strong>Scope:</strong> ' + atom.scope +
      ' | <strong>Confirmations:</strong> ' + atom.confirmations + ' | <strong>Last Used:</strong> ' + (atom.lastUsed||'-') +
      (atom.triggers?.length ? ' | <strong>Triggers:</strong> ' + atom.triggers.join(', ') : '') +
      (atom.related?.length ? ' | <strong>Related:</strong> ' + atom.related.join(', ') : '');
    const modal = document.getElementById('mem-detail');
    modal.style.display = 'flex';
  } catch (e) { alert('載入失敗: ' + e.message); }
}

function closeMemDetail() {
  document.getElementById('mem-detail').style.display = 'none';
}

async function deleteMemAtom(name) {
  if (!confirm('確定刪除 atom "' + name + '"？')) return;
  try {
    await authFetch('/api/memory/atoms/' + encodeURIComponent(name), { method: 'DELETE' });
    loadMemory();
  } catch (e) { alert('刪除失敗: ' + e.message); }
}

async function testMemRecall() {
  const input = document.getElementById('mem-recall-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  const el = document.getElementById('mem-recall-result');
  el.innerHTML = '<div style="color:var(--fg3)">查詢中...</div>';
  try {
    const r = await authFetch('/api/memory/recall-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }).then(r => r.json());
    if (r.error) { el.innerHTML = '<div style="color:var(--error)">' + r.error + '</div>'; return; }
    if (!r.fragments?.length) {
      el.innerHTML = '<div style="color:var(--warn)">無命中' + (r.degraded ? ' (degraded)' : '') + (r.blindSpot ? ' — Blind Spot' : '') + '</div>';
      return;
    }
    const rows = r.fragments.map((f, i) =>
      '<tr><td>' + (i+1) + '</td><td style="font-weight:500">' + f.name + '</td>' +
      '<td>' + f.score + '</td><td>' + f.matchedBy + '</td><td>' + f.confidence + '</td>' +
      '<td style="font-size:0.75rem;color:var(--fg2);max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (f.contentPreview||'').replace(/</g,'&lt;') + '</td></tr>'
    ).join('');
    el.innerHTML = (r.degraded ? '<div style="color:var(--warn);margin-bottom:4px">⚠ Degraded mode</div>' : '') +
      '<table class="tbl"><thead><tr><th>#</th><th>Atom</th><th>Score</th><th>Source</th><th>Conf</th><th>Preview</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

// ── Memory Pipeline 面板 ─────────────────────────────────────────────────────

async function loadPipeline() {
  // 並行載入所有資料
  const [ollamaStatus, models, pipeline, vectorStats] = await Promise.all([
    authFetch('/api/ollama/status').then(r => r.json()).catch(() => ({ online: false })),
    authFetch('/api/ollama/models').then(r => r.json()).catch(() => ({ models: [] })),
    authFetch('/api/memory/pipeline').then(r => r.json()).catch(() => ({ config: null, activeProvider: null, embeddingDim: 0 })),
    authFetch('/api/memory/vector/stats').then(r => r.json()).catch(() => ({ available: false })),
  ]);

  // Ollama 狀態
  const statusEl = document.getElementById('pl-ollama-status');
  statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
    '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' +
    (ollamaStatus.online ? '#4ade80' : '#f87171') + '"></span>' +
    '<strong>' + (ollamaStatus.online ? '連線中' : '離線') + '</strong>' +
    (ollamaStatus.version ? ' <span style="color:var(--fg2)">v' + ollamaStatus.version + '</span>' : '') +
    '</div>' +
    (ollamaStatus.host ? '<div style="font-size:0.78rem;color:var(--fg2)">Host: ' + ollamaStatus.host + '</div>' : '');

  // Pipeline 設定
  const cfgEl = document.getElementById('pl-pipeline-cfg');
  if (pipeline.config) {
    const e = pipeline.config.embedding || {};
    const x = pipeline.config.extraction || {};
    const r = pipeline.config.reranker || {};
    cfgEl.innerHTML =
      '<table style="font-size:0.82rem;width:100%"><tbody>' +
      '<tr><td style="padding:2px 8px 2px 0;color:var(--fg2)">Embedding</td><td><strong>' + (e.provider||'-') + '</strong> / ' + (e.model||'-') + '</td></tr>' +
      '<tr><td style="padding:2px 8px 2px 0;color:var(--fg2)">Extraction</td><td><strong>' + (x.provider||'-') + '</strong> / ' + (x.model||'-') + '</td></tr>' +
      '<tr><td style="padding:2px 8px 2px 0;color:var(--fg2)">Reranker</td><td><strong>' + (r.provider||'-') + '</strong> / ' + (r.model||'-') + '</td></tr>' +
      '<tr><td style="padding:2px 8px 2px 0;color:var(--fg2)">維度</td><td>' + (pipeline.embeddingDim || '-') + 'd</td></tr>' +
      '</tbody></table>';
    if (pipeline.activeProvider) {
      cfgEl.innerHTML += '<div style="font-size:0.78rem;color:var(--fg2);margin-top:6px">Active: ' + pipeline.activeProvider.name + '/' + pipeline.activeProvider.model + '</div>';
    }
  } else {
    cfgEl.innerHTML = '<div style="color:var(--fg2)">未設定（fallback 至 Ollama）</div>';
  }

  // Vector DB
  const vecEl = document.getElementById('pl-vector-stats');
  if (vectorStats.available && vectorStats.tables) {
    const totalCount = vectorStats.tables.reduce(function(s, t) { return s + t.count; }, 0);
    vecEl.innerHTML = '<div style="margin-bottom:4px"><strong>' + totalCount + '</strong> vectors in <strong>' + vectorStats.tables.length + '</strong> namespaces</div>' +
      vectorStats.tables.map(function(t) { return '<div style="font-size:0.78rem;color:var(--fg2)">• ' + t.name + ': ' + t.count + '</div>'; }).join('');
  } else {
    vecEl.innerHTML = '<div style="color:var(--warn)">Vector DB 不可用</div>';
  }

  // Ollama 模型列表
  renderPipelineModels(models.models || []);

  // Embedding 切換下拉選單（只列出 embedding 模型）
  const select = document.getElementById('pl-embed-select');
  const embeddingModels = (models.models || []).filter(function(m) { return m.name.includes('embed'); });
  const currentModel = pipeline.config?.embedding?.model || '';
  select.innerHTML = embeddingModels.length
    ? embeddingModels.map(function(m) { return '<option value="' + m.name + '"' + (m.name === currentModel ? ' selected' : '') + '>' + m.name + '</option>'; }).join('')
    : '<option value="">（無 embedding 模型）</option>';

  // Extract 切換下拉選單（列出非 embedding 模型）
  const extSelect = document.getElementById('pl-extract-select');
  const extractModels = (models.models || []).filter(function(m) { return !m.name.includes('embed'); });
  const currentExtractModel = pipeline.config?.extraction?.model || '';
  extSelect.innerHTML = extractModels.length
    ? extractModels.map(function(m) { return '<option value="' + m.name + '"' + (m.name === currentExtractModel ? ' selected' : '') + '>' + m.name + '</option>'; }).join('')
    : '<option value="">（無可用模型）</option>';
}

function renderPipelineModels(models) {
  const el = document.getElementById('pl-models-list');
  if (!models.length) { el.innerHTML = '<div style="color:var(--fg2)">無模型</div>'; return; }
  el.innerHTML = '<table class="tbl" style="width:100%"><thead><tr><th>Model</th><th>Size</th><th>Family</th><th></th></tr></thead><tbody>' +
    models.map(function(m) {
      var sizeGB = (m.size / 1073741824).toFixed(1);
      return '<tr><td style="font-weight:500">' + m.name + '</td>' +
        '<td>' + sizeGB + ' GB</td>' +
        '<td style="color:var(--fg2)">' + (m.details?.family || '-') + '</td>' +
        '<td><button class="btn btn-sm" style="color:var(--error);font-size:0.72rem" onclick="pipelineDeleteModel(\\'' + m.name.replace(/'/g, "\\\\'") + '\\')">刪除</button></td></tr>';
    }).join('') + '</tbody></table>';
}

async function pipelineSwitchEmbed() {
  var select = document.getElementById('pl-embed-select');
  var model = select.value;
  if (!model) return;
  var msgEl = document.getElementById('pl-embed-msg');
  msgEl.innerHTML = '<div style="color:var(--fg2)">套用中...</div>';
  try {
    var r = await authFetch('/api/memory/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedding: { provider: 'ollama', model: model } }),
    }).then(function(r) { return r.json(); });
    msgEl.innerHTML = '<div style="color:var(--success)">' + (r.message || '已更新') + '</div>';
  } catch (e) { msgEl.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

async function pipelineSwitchExtract() {
  var select = document.getElementById('pl-extract-select');
  var model = select.value;
  if (!model) return;
  var msgEl = document.getElementById('pl-extract-msg');
  msgEl.innerHTML = '<div style="color:var(--fg2)">套用中...</div>';
  try {
    var r = await authFetch('/api/memory/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraction: { provider: 'ollama', model: model } }),
    }).then(function(r) { return r.json(); });
    msgEl.innerHTML = '<div style="color:var(--success)">' + (r.message || '已更新') + '</div>';
  } catch (e) { msgEl.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

async function pipelineResync() {
  var el = document.getElementById('pl-resync-result');
  el.innerHTML = '<div style="color:var(--fg2)">重建中（可能需要數十秒）...</div>';
  try {
    var r = await authFetch('/api/memory/resync', { method: 'POST' }).then(function(r) { return r.json(); });
    if (r.error) { el.innerHTML = '<div style="color:var(--error)">' + r.error + '</div>'; return; }
    var lines = (r.report || []).map(function(l) {
      return '<div>• ' + l.layer + '：✅ ' + l.seeded + ' embedded, ' + l.skipped + ' skipped, ' + l.errors + ' errors</div>';
    });
    el.innerHTML = '<div style="color:var(--success);font-weight:500;margin-bottom:4px">✅ Resync 完成</div>' + lines.join('');
    // 刷新 vector stats
    loadPipeline();
  } catch (e) { el.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

async function pipelinePullModel() {
  var input = document.getElementById('pl-pull-input');
  var name = input.value.trim();
  if (!name) return;
  var msgEl = document.getElementById('pl-pull-msg');
  msgEl.innerHTML = '<div style="color:var(--fg2)">拉取中（大模型可能需數分鐘）...</div>';
  try {
    var r = await authFetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function(r) { return r.json(); });
    if (r.error) { msgEl.innerHTML = '<div style="color:var(--error)">' + r.error + '</div>'; return; }
    msgEl.innerHTML = '<div style="color:var(--success)">✅ ' + name + ' 拉取完成</div>';
    input.value = '';
    loadPipeline(); // 刷新模型列表
  } catch (e) { msgEl.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

async function pipelineDeleteModel(name) {
  if (!confirm('確定刪除模型 "' + name + '"？')) return;
  try {
    await authFetch('/api/ollama/model/' + encodeURIComponent(name), { method: 'DELETE' });
    loadPipeline();
  } catch (e) { alert('刪除失敗: ' + e.message); }
}

async function pipelineRecallTest() {
  var input = document.getElementById('pl-recall-input');
  var prompt = input.value.trim();
  if (!prompt) return;
  var el = document.getElementById('pl-recall-result');
  el.innerHTML = '<div style="color:var(--fg2)">查詢中...</div>';
  try {
    var r = await authFetch('/api/memory/recall-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt }),
    }).then(function(r) { return r.json(); });
    if (r.error) { el.innerHTML = '<div style="color:var(--error)">' + r.error + '</div>'; return; }
    if (!r.fragments?.length) {
      el.innerHTML = '<div style="color:var(--warn)">無命中' + (r.degraded ? ' (degraded)' : '') + '</div>';
      return;
    }
    var rows = r.fragments.map(function(f, i) {
      return '<tr><td>' + (i+1) + '</td><td style="font-weight:500">' + f.name + '</td>' +
        '<td>' + f.score + '</td><td>' + f.matchedBy + '</td><td>' + f.confidence + '</td>' +
        '<td style="font-size:0.75rem;color:var(--fg2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (f.contentPreview||'').replace(/</g,'&lt;') + '</td></tr>';
    }).join('');
    el.innerHTML = '<table class="tbl"><thead><tr><th>#</th><th>Atom</th><th>Score</th><th>Source</th><th>Conf</th><th>Preview</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div style="color:var(--error)">錯誤: ' + e.message + '</div>'; }
}

// ── Dashboard Chat ──────────────────────────────────────────────────────────
let _chatBusy = false;

function appendChatMsg(role, text) {
  const el = document.getElementById('chat-messages');
  // 移除初始提示
  const placeholder = el.querySelector('div[style*="text-align:center"]');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.style.cssText = 'margin-bottom:12px;padding:8px 12px;border-radius:8px;' +
    (role === 'user'
      ? 'background:var(--accent);color:#fff;margin-left:20%;text-align:right'
      : 'background:var(--bg);border:1px solid var(--border);margin-right:20%');
  div.setAttribute('data-role', role);
  // 簡易 markdown 渲染
  div.innerHTML = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre style="background:var(--bg2);padding:8px;border-radius:4px;overflow-x:auto;text-align:left">$1</pre>')
    .replace(/\`([^\`]+)\`/g, '<code style="background:var(--bg2);padding:1px 4px;border-radius:3px">$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\n/g, '<br>');
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

async function sendChat() {
  if (_chatBusy) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  _chatBusy = true;

  const statusEl = document.getElementById('chat-status');
  statusEl.textContent = '思考中...';
  statusEl.style.color = 'var(--accent)';

  appendChatMsg('user', text);
  const assistantDiv = appendChatMsg('assistant', '');

  const sessionKey = document.getElementById('chat-session').value || '';

  try {
    const resp = await fetch('/api/chat' + (_authToken ? '?token=' + encodeURIComponent(_authToken) : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionKey }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      assistantDiv.innerHTML = '<span style="color:#f44">錯誤: ' + err + '</span>';
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 解析 SSE 格式
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text_delta') {
              fullText += data.text;
              assistantDiv.innerHTML = fullText
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre style="background:var(--bg2);padding:8px;border-radius:4px;overflow-x:auto">$1</pre>')
                .replace(/\`([^\`]+)\`/g, '<code style="background:var(--bg2);padding:1px 4px;border-radius:3px">$1</code>')
                .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\n/g, '<br>');
              document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
            } else if (data.type === 'tool_call') {
              statusEl.textContent = '工具: ' + (data.name || '') + '...';
            } else if (data.type === 'done') {
              statusEl.textContent = '完成 (' + (data.turns || 0) + ' turns)';
            } else if (data.type === 'error') {
              assistantDiv.innerHTML += '<br><span style="color:#f44">⚠ ' + (data.message || 'Unknown error') + '</span>';
            }
          } catch {}
        }
      }
    }
    if (!fullText) assistantDiv.innerHTML = '<span style="color:var(--fg3)">(無文字回應)</span>';
  } catch (err) {
    assistantDiv.innerHTML = '<span style="color:#f44">連線錯誤: ' + err.message + '</span>';
  } finally {
    _chatBusy = false;
    statusEl.style.color = 'var(--fg3)';
    if (statusEl.textContent === '思考中...') statusEl.textContent = '就緒';
  }
}

async function refreshChatSessions() {
  try {
    const data = await authFetch('/api/sessions').then(r => r.json());
    const sel = document.getElementById('chat-session');
    const prev = sel.value;
    sel.innerHTML = '<option value="">(新 Session)</option>';
    if (data && !data.error) {
      const sessions = Array.isArray(data) ? data : (data.sessions || []);
      sessions
        .sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''))
        .forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.sessionKey;
          const label = s.sessionKey.length > 36 ? '...' + s.sessionKey.slice(-32) : s.sessionKey;
          opt.textContent = label + ' (' + s.turns + ' turns)';
          sel.appendChild(opt);
        });
    }
    if (prev) sel.value = prev;
    // 綁定切換事件
    sel.onchange = loadChatHistory;
  } catch {}
}

async function loadChatHistory() {
  const sessionKey = document.getElementById('chat-session').value;
  const msgEl = document.getElementById('chat-messages');
  msgEl.innerHTML = '';
  if (!sessionKey) {
    msgEl.innerHTML = '<div style="color:var(--fg3);text-align:center;padding:40px 0">在下方輸入訊息開始對話</div>';
    return;
  }
  msgEl.innerHTML = '<div style="color:var(--fg3);text-align:center;padding:20px 0">載入歷史...</div>';
  try {
    const history = await authFetch('/api/chat/history?sessionKey=' + encodeURIComponent(sessionKey)).then(r => r.json());
    msgEl.innerHTML = '';
    if (!history.length) {
      msgEl.innerHTML = '<div style="color:var(--fg3);text-align:center;padding:40px 0">此 Session 無對話紀錄</div>';
      return;
    }
    for (const msg of history) {
      appendChatMsg(msg.role, msg.content);
    }
  } catch (err) {
    msgEl.innerHTML = '<div style="color:#f44;text-align:center;padding:20px 0">載入失敗: ' + err.message + '</div>';
  }
}

async function clearChatSession() {
  const sessionKey = document.getElementById('chat-session').value;
  if (!sessionKey) { document.getElementById('chat-status').textContent = '請先選擇 Session'; return; }
  if (!confirm('確定清除 session ' + sessionKey.slice(-24) + '？')) return;
  try {
    await authFetch('/api/sessions/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    });
    document.getElementById('chat-messages').innerHTML = '<div style="color:var(--fg3);text-align:center;padding:40px 0">Session 已清除。輸入訊息開始新對話。</div>';
    document.getElementById('chat-status').textContent = '已清除';
  } catch (err) {
    document.getElementById('chat-status').textContent = '清除失敗: ' + err.message;
  }
}

// ── CLI Bridge Config Editor ─────────────────────────────────────────────

const _cbDefaults = {
  enabled: true,
  label: '',
  claudeBin: 'claude',
  workingDir: '',
  logDir: '~/.catclaw/data/cli-bridge',
  botToken: '',
  keepAliveIntervalMs: 60000,
  turnTimeoutMs: 300000,
  turnTimeoutAction: 'ask',
  showThinking: false,
  editIntervalMs: 800,
  idleSuspendMs: 600000,
  channels: {},
};
const _cbChannelDefaults = {
  label: '',
  sessionId: '',
  dangerouslySkipPermissions: true,
  requireMention: false,
};

let _cbConfigData = [];

function _cbField(id, label, type, value, opts) {
  const sid = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  let inp = '';
  if (type === 'bool') {
    inp = \`<input type="checkbox" id="\${sid}" \${value ? 'checked' : ''} style="margin-left:8px">\`;
  } else if (type === 'select') {
    inp = \`<select id="\${sid}" style="flex:1;padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem">\` +
      (opts || []).map(o => \`<option value="\${o}" \${value === o ? 'selected' : ''}>\${o}</option>\`).join('') + '</select>';
  } else if (type === 'num') {
    inp = \`<input type="number" id="\${sid}" value="\${value ?? ''}" style="flex:1;padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem">\`;
  } else if (type === 'password') {
    inp = \`<input type="password" id="\${sid}" value="\${value || ''}" placeholder="(未設定)" style="flex:1;padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem">\`;
  } else {
    inp = \`<input type="text" id="\${sid}" value="\${value || ''}" style="flex:1;padding:4px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:0.82rem">\`;
  }
  return \`<div style="display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap"><label style="min-width:120px;max-width:180px;font-size:0.78rem;color:var(--fg2)">\${label}</label>\${inp}</div>\`;
}

function _cbRenderBridge(idx, cfg) {
  const p = 'cb_cfg_' + idx + '_';
  let html = \`<details style="border:1px solid var(--border);border-radius:6px;margin-bottom:10px;background:var(--bg2)" data-cb-idx="\${idx}">\`;
  html += \`<summary style="padding:10px;cursor:pointer;list-style:none;font-weight:bold;font-size:0.88rem">\${cfg.label || '(unnamed)'} \${cfg.enabled ? '🟢' : '⚪'}</summary>\`;
  html += '<div style="padding:0 10px 10px 10px">';
  html += '<div style="text-align:right;margin-bottom:6px"><button class="btn btn-sm btn-red" onclick="cbRemoveBridge(' + idx + ')">✕ 移除此 Bridge</button></div>';
  html += _cbField(p+'enabled', '啟用', 'bool', cfg.enabled);
  html += _cbField(p+'label', 'Label（全域唯一）', 'text', cfg.label);
  html += _cbField(p+'claudeBin', 'Claude Binary', 'text', cfg.claudeBin || _cbDefaults.claudeBin);
  html += _cbField(p+'workingDir', 'Working Directory', 'text', cfg.workingDir);
  html += _cbField(p+'logDir', 'Log Directory', 'text', cfg.logDir || _cbDefaults.logDir);
  html += _cbField(p+'botToken', 'Bot Token（獨立 bot）', 'password', cfg.botToken || '');
  html += _cbField(p+'keepAliveIntervalMs', 'Keep-Alive (ms)，預設 60000。0=不送 ping', 'num', cfg.keepAliveIntervalMs ?? _cbDefaults.keepAliveIntervalMs);
  html += _cbField(p+'turnTimeoutMs', 'Turn Timeout (ms)', 'num', cfg.turnTimeoutMs ?? _cbDefaults.turnTimeoutMs);
  html += _cbField(p+'turnTimeoutAction', 'Timeout Action', 'select', cfg.turnTimeoutAction || _cbDefaults.turnTimeoutAction, ['ask','interrupt','warn','restart']);
  html += _cbField(p+'showThinking', 'Show Thinking', 'bool', cfg.showThinking ?? _cbDefaults.showThinking);
  html += _cbField(p+'editIntervalMs', 'Edit Interval (ms)', 'num', cfg.editIntervalMs ?? _cbDefaults.editIntervalMs);
  html += _cbField(p+'idleSuspendMs', 'Idle Suspend (ms)，預設 600000 (10min)。0=常駐不卸載', 'num', cfg.idleSuspendMs ?? _cbDefaults.idleSuspendMs);

  // Channels
  html += \`<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px"><strong style="font-size:0.82rem">Channels</strong> <button class="btn btn-sm" onclick="cbAddChannel(\${idx})" style="margin-left:8px">+ Channel</button></div>\`;
  const chs = cfg.channels || {};
  for (const [chId, chCfg] of Object.entries(chs)) {
    const cp = p + 'ch_' + chId.replace(/[^a-zA-Z0-9]/g, '_') + '_';
    html += \`<div style="margin:6px 0 6px 16px;padding:8px;border:1px dashed var(--border);border-radius:4px" data-ch-id="\${chId}">\`;
    html += \`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-size:0.78rem;color:var(--fg3)">Channel: \${chId}</span><button class="btn btn-sm btn-red" onclick="cbRemoveChannel(\${idx},'\${chId}')" style="font-size:0.7rem">✕</button></div>\`;
    html += _cbField(cp+'chId', 'Channel ID', 'text', chId);
    html += _cbField(cp+'label', 'Label', 'text', chCfg.label || '');
    html += _cbField(cp+'sessionId', 'Session ID（留空=自動）', 'text', chCfg.sessionId || '');
    html += _cbField(cp+'dangerouslySkipPermissions', 'Skip Permissions', 'bool', chCfg.dangerouslySkipPermissions ?? true);
    html += _cbField(cp+'requireMention', 'Require @Mention', 'bool', chCfg.requireMention ?? false);
    html += '</div>';
  }
  html += '</div></details>';
  return html;
}

function _cbCollectForm() {
  const configs = [];
  const forms = document.querySelectorAll('[data-cb-idx]');
  forms.forEach(form => {
    const idx = form.dataset.cbIdx;
    const p = 'cb_cfg_' + idx + '_';
    const g = id => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
    const cfg = {
      enabled: !!g(p+'enabled'),
      label: g(p+'label') || '',
      claudeBin: g(p+'claudeBin') || 'claude',
      workingDir: g(p+'workingDir') || '',
      logDir: g(p+'logDir') || '',
      botToken: g(p+'botToken') || undefined,
      keepAliveIntervalMs: parseInt(g(p+'keepAliveIntervalMs')) || 0,
      turnTimeoutMs: parseInt(g(p+'turnTimeoutMs')) || 300000,
      turnTimeoutAction: g(p+'turnTimeoutAction') || 'ask',
      showThinking: !!g(p+'showThinking'),
      editIntervalMs: parseInt(g(p+'editIntervalMs')) || 800,
      idleSuspendMs: parseInt(g(p+'idleSuspendMs')) ?? 600000,
      channels: {},
    };
    // 不儲存空 botToken
    if (!cfg.botToken) delete cfg.botToken;
    // channels
    const chEls = form.querySelectorAll('[data-ch-id]');
    chEls.forEach(chEl => {
      const origChId = chEl.dataset.chId;
      const cp = p + 'ch_' + origChId.replace(/[^a-zA-Z0-9]/g, '_') + '_';
      const newChId = g(cp+'chId') || origChId;
      cfg.channels[newChId] = {
        label: g(cp+'label') || '',
        sessionId: g(cp+'sessionId') || undefined,
        dangerouslySkipPermissions: !!g(cp+'dangerouslySkipPermissions'),
        requireMention: !!g(cp+'requireMention'),
      };
      if (!cfg.channels[newChId].sessionId) delete cfg.channels[newChId].sessionId;
    });
    configs.push(cfg);
  });
  return configs;
}

async function cbLoadConfig() {
  try {
    _cbConfigData = await authFetch('/api/cli-bridges/config').then(r => r.json());
    if (!Array.isArray(_cbConfigData)) _cbConfigData = [];
    _cbRenderAll();
    _cbMsg('已載入 ' + _cbConfigData.length + ' 個 Bridge', '#6f6');
  } catch (err) {
    _cbMsg('載入失敗: ' + err.message, '#f66');
  }
}

function _cbRenderAll() {
  const container = document.getElementById('cb-config-forms');
  if (!_cbConfigData.length) {
    container.innerHTML = '<div style="color:var(--fg3);font-size:0.82rem;padding:12px">尚無設定。點「+ 新增 Bridge」開始。</div>';
    return;
  }
  container.innerHTML = _cbConfigData.map((cfg, i) => _cbRenderBridge(i, cfg)).join('');
}

function _cbMsg(text, color) {
  const el = document.getElementById('cb-config-msg');
  if (el) { el.innerHTML = '<span style="color:' + (color || 'var(--fg3)') + '">' + text + '</span>'; setTimeout(() => { el.textContent = ''; }, 3000); }
}

function cbAddBridge() {
  _cbConfigData.push({ ..._cbDefaults, label: 'new-bridge-' + (_cbConfigData.length + 1), channels: {} });
  _cbRenderAll();
  _cbMsg('已新增 Bridge（記得按儲存）', '#6cf');
}

function cbRemoveBridge(idx) {
  if (!confirm('確定移除此 Bridge？')) return;
  const name = _cbConfigData[idx]?.label || '(unnamed)';
  _cbConfigData.splice(idx, 1);
  _cbRenderAll();
  _cbMsg('已移除 ' + name + '（記得按儲存）', '#fc6');
}

function cbAddChannel(idx) {
  const chId = prompt('輸入 Channel ID：');
  if (!chId) return;
  if (!_cbConfigData[idx].channels) _cbConfigData[idx].channels = {};
  _cbConfigData[idx].channels[chId] = { ..._cbChannelDefaults, label: _cbConfigData[idx].label + '-ch' };
  _cbRenderAll();
  _cbMsg('已新增 Channel ' + chId + '（記得按儲存）', '#6cf');
}

function cbRemoveChannel(idx, chId) {
  if (!confirm('確定移除此 Channel？')) return;
  delete _cbConfigData[idx].channels[chId];
  _cbRenderAll();
  _cbMsg('已移除 Channel ' + chId + '（記得按儲存）', '#fc6');
}

async function cbSaveConfig() {
  const msgEl = document.getElementById('cb-config-msg');
  try {
    const configs = _cbCollectForm();
    const res = await authFetch('/api/cli-bridges/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configs),
    });
    const d = await res.json();
    if (d.success) {
      _cbConfigData = configs;
      msgEl.innerHTML = '<span style="color:#6f6">已儲存（hot-reload 自動套用）</span>';
      setTimeout(() => { loadCliBridges(); msgEl.textContent = ''; }, 3000);
    } else {
      msgEl.innerHTML = '<span style="color:#f66">儲存失敗: ' + (d.error || '未知錯誤') + '</span>';
    }
  } catch (err) {
    msgEl.innerHTML = '<span style="color:#f66">' + err.message + '</span>';
  }
}

// ── CLI Bridge ──────────────────────────────────────────────────────────────
let _cbSelectedLabel = null;
let _cbEventSource = null;

async function loadCliBridges() {
  try {
    const d = await authFetch('/api/cli-bridge/list').then(r => r.json());
    const bridges = d.bridges || [];
    if (!bridges.length) {
      document.getElementById('cb-list').innerHTML = '<span style="color:var(--fg3)">沒有 CLI Bridge（需在 ~/.catclaw/cli-bridges.json 設定）</span>';
      document.getElementById('cb-detail').style.display = 'none';
      return;
    }
    const statusIcon = s => s === 'idle' ? '🟢' : s === 'busy' ? '🟡' : s === 'restarting' ? '🔄' : s === 'suspended' ? '💤' : '🔴';
    document.getElementById('cb-list').innerHTML = '<table class="tbl"><thead><tr><th>Label</th><th>狀態</th><th>Session</th><th>Channel</th><th></th></tr></thead><tbody>' +
      bridges.map(b => \`<tr><td>\${b.label}</td><td>\${statusIcon(b.status)} \${b.status}</td><td style="font-size:0.72rem;color:var(--fg3)">\${b.sessionId ? b.sessionId.slice(0,8) : '-'}</td><td style="font-size:0.72rem;color:var(--fg3)">\${b.channelId}</td><td><button class="btn btn-sm" onclick="cbSelect('\${b.label}')">開啟</button></td></tr>\`).join('') +
      '</tbody></table>';
  } catch (err) {
    document.getElementById('cb-list').innerHTML = '<span style="color:#f66">載入失敗: ' + err.message + '</span>';
  }
}

async function cbSelect(label) {
  _cbSelectedLabel = label;
  document.getElementById('cb-detail').style.display = 'block';
  document.getElementById('cb-detail-title').textContent = label;
  await cbLoadStatus();
  await cbLoadTurns();
  cbConnectStream();
}

async function cbLoadStatus() {
  if (!_cbSelectedLabel) return;
  try {
    const d = await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/status').then(r => r.json());
    const statusIcon = s => s === 'idle' ? '🟢' : s === 'busy' ? '🟡' : s === 'restarting' ? '🔄' : s === 'suspended' ? '💤' : '🔴';
    document.getElementById('cb-detail-info').innerHTML =
      \`狀態：\${statusIcon(d.status)} \${d.status}<br>Session：\${d.sessionId || '-'}<br>Channel：\${d.channelId}\`;
  } catch {}
}

async function cbLoadTurns() {
  if (!_cbSelectedLabel) return;
  try {
    const d = await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/turns?limit=30').then(r => r.json());
    const turns = d.turns || [];
    if (!turns.length) { document.getElementById('cb-turns').innerHTML = '<span style="color:var(--fg3)">尚無 turn</span>'; return; }
    const deliveryIcon = s => s === 'success' ? '✅' : s === 'failed' ? '❌' : s === 'skipped' ? '⏭' : '⏳';
    document.getElementById('cb-turns').innerHTML = '<table class="tbl"><thead><tr><th>時間</th><th>來源</th><th>輸入</th><th>回覆</th><th>工具</th><th>送達</th><th></th></tr></thead><tbody>' +
      turns.slice().reverse().map(t => {
        const time = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : '-';
        const input = (t.userInput || '').slice(0, 40) + (t.userInput?.length > 40 ? '…' : '');
        const reply = (t.assistantReply || '').slice(0, 40) + (t.assistantReply?.length > 40 ? '…' : '');
        const resendBtn = t.discordDelivery === 'failed' ? \`<button class="btn btn-sm" onclick="cbResend('\${t.turnId}')">重送</button>\` : '';
        return \`<tr><td>\${time}</td><td>\${t.source}</td><td title="\${(t.userInput||'').replace(/"/g,'&quot;')}">\${input}</td><td title="\${(t.assistantReply||'').replace(/"/g,'&quot;')}">\${reply}</td><td>\${t.toolCalls?.length || 0}</td><td>\${deliveryIcon(t.discordDelivery)}</td><td>\${resendBtn}</td></tr>\`;
      }).join('') +
      '</tbody></table>';
  } catch (err) {
    document.getElementById('cb-turns').innerHTML = '<span style="color:#f66">' + err.message + '</span>';
  }
}

function cbConnectStream() {
  cbDisconnectStream();
  if (!_cbSelectedLabel) return;
  const url = '/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/stream' + (_authToken ? '?token=' + encodeURIComponent(_authToken) : '');
  _cbEventSource = new EventSource(url);
  document.getElementById('cb-stream-status').textContent = '連線中…';
  const logEl = document.getElementById('cb-log-stream');
  logEl.textContent = '';

  _cbEventSource.onopen = () => { document.getElementById('cb-stream-status').textContent = '🟢 已連線'; };
  _cbEventSource.onerror = () => { document.getElementById('cb-stream-status').textContent = '🔴 斷線'; };
  _cbEventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'init' && Array.isArray(data.events)) {
        data.events.forEach(ev => appendCbLog(logEl, ev));
      } else {
        appendCbLog(logEl, data);
      }
    } catch {}
  };
}

function appendCbLog(el, entry) {
  const evt = entry.event || entry;
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
  let line = ts + ' ';
  if (evt.type === 'text_delta') line += evt.text;
  else if (evt.type === 'tool_call') line += '🔧 ' + (evt.title || '');
  else if (evt.type === 'tool_result') line += '✅ ' + (evt.title || '');
  else if (evt.type === 'result') line += '--- turn complete ---';
  else if (evt.type === 'error') line += '❌ ' + (evt.message || '');
  else if (evt.type === 'session_init') line += '🔗 session=' + (evt.sessionId || '').slice(0,8);
  else if (evt.type === 'thinking_delta') return; // 不顯示
  else line += JSON.stringify(evt).slice(0, 120);
  el.textContent += line + '\\n';
  el.scrollTop = el.scrollHeight;
}

function cbDisconnectStream() {
  if (_cbEventSource) { _cbEventSource.close(); _cbEventSource = null; }
  document.getElementById('cb-stream-status').textContent = '';
}

async function cbSendConsole() {
  if (!_cbSelectedLabel) return;
  const input = document.getElementById('cb-console-input');
  const text = input.value.trim();
  if (!text) return;
  const msgEl = document.getElementById('cb-console-msg');
  try {
    const d = await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    }).then(r => r.json());
    if (d.success) { msgEl.textContent = '已送出 turn=' + d.turnId.slice(0,8); input.value = ''; }
    else msgEl.textContent = '失敗: ' + (d.error || '');
  } catch (err) { msgEl.textContent = '錯誤: ' + err.message; }
}

async function cbInterrupt() {
  if (!_cbSelectedLabel) return;
  try {
    await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/interrupt', { method: 'POST' });
    await cbLoadStatus();
  } catch {}
}

async function cbRestart() {
  if (!_cbSelectedLabel) return;
  if (!confirm('確定重啟 ' + _cbSelectedLabel + '？')) return;
  try {
    await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/restart', { method: 'POST' });
    setTimeout(() => { cbLoadStatus(); loadCliBridges(); }, 2000);
  } catch {}
}

async function cbResend(turnId) {
  if (!_cbSelectedLabel) return;
  try {
    const d = await authFetch('/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/resend/' + encodeURIComponent(turnId), { method: 'POST' }).then(r => r.json());
    if (d.success) alert('已重送，新 turn=' + d.newTurnId.slice(0,8));
    else alert('重送失敗: ' + (d.error || ''));
  } catch (err) { alert('錯誤: ' + err.message); }
}

function cbExport() {
  if (!_cbSelectedLabel) return;
  const url = '/api/cli-bridge/' + encodeURIComponent(_cbSelectedLabel) + '/export' + (_authToken ? '?token=' + encodeURIComponent(_authToken) : '');
  window.open(url, '_blank');
}

// ── 初始化 ───────────────────────────────────────────────────────────────────
loadOverview();
loadStatus();
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;

// ── DashboardServer ───────────────────────────────────────────────────────────

export class DashboardServer {
  private port: number;
  private token?: string;

  constructor(port = 8088, token?: string) {
    this.port = port;
    this.token = token;
  }

  /** 檢查認證（token 未設定則全通過） */
  private checkAuth(req: IncomingMessage, url: string): boolean {
    if (!this.token) return true;
    // 1. Query param: ?token=xxx
    const paramMatch = url.match(/[?&]token=([^&]+)/);
    if (paramMatch && paramMatch[1] === this.token) return true;
    // 2. Authorization: Bearer xxx
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader === `Bearer ${this.token}`) return true;
    return false;
  }

  start(): void {
    const authToken = this.token;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (!this.checkAuth(req, url)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized. Provide ?token=xxx or Authorization: Bearer xxx" }));
        return;
      }

      if (url === "/" || url === "/index.html" || url.match(/^\/(\?token=[^&]+)?$/)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }

      // GET /api/usage
      if (url.startsWith("/api/usage")) {
        const daysMatch = url.match(/[?&]days=(\d+)/);
        const days = daysMatch ? parseInt(daysMatch[1]!, 10) : 7;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildApiData(days)));
        return;
      }

      // GET /api/sessions
      if (url === "/api/sessions" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildSessionsData()));
        return;
      }

      // GET /api/status
      if (url === "/api/status" && method === "GET") {
        const uptime = Math.floor(process.uptime());
        const mem = process.memoryUsage();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          uptimeSec: uptime,
          uptimeStr: `${Math.floor(uptime/3600)}h ${Math.floor(uptime%3600/60)}m`,
          memoryMB: Math.round(mem.rss/1024/1024),
          heapUsedMB: Math.round(mem.heapUsed/1024/1024),
          nodeVersion: process.version,
          pid: process.pid,
          configDir: process.env.CATCLAW_CONFIG_DIR ?? "(未設定)",
          workspace: process.env.CATCLAW_WORKSPACE ?? "(未設定)",
        }));
        return;
      }

      // GET /api/logs/stream (SSE)
      if (url === "/api/logs/stream" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // 送出初始 log
        const initial = tailLog(200);
        res.write(`data: ${JSON.stringify(initial)}\n\n`);
        _sseClients.add(res);
        startLogWatch();
        req.on("close", () => {
          _sseClients.delete(res);
          if (_sseClients.size === 0) stopLogWatch();
        });
        return;
      }

      // GET /api/logs
      if (url.startsWith("/api/logs") && method === "GET") {
        const linesMatch = url.match(/[?&]lines=(\d+)/);
        const lines = linesMatch ? parseInt(linesMatch[1]!, 10) : 100;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(tailLog(lines));
        return;
      }

      // POST /api/restart
      if (url === "/api/restart" && method === "POST") {
        const ok = touchRestart();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ok ? { success: true } : { success: false, error: "signal/RESTART not found" }));
        // 不依賴 PM2 file watch — 發 SIGTERM 走 graceful shutdown，PM2 autorestart 拉起
        setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 500);
        return;
      }

      // GET /api/cron
      if (url === "/api/cron" && method === "GET") {
        void (async () => {
          try {
            const { getCronStorePath } = await import("../cron.js");
            const p = getCronStorePath();
            const data = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { version: 1, jobs: {} };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jobs: (data.jobs ?? {}) }));
          } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        })();
        return;
      }

      // POST /api/cron, /api/cron/delete, /api/cron/trigger, /api/cron/toggle
      if (url.startsWith("/api/cron") && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
              const { getCronStorePath } = await import("../cron.js");
              const p = getCronStorePath();
              const store = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { version: 1, jobs: {} };
              const jobs = store.jobs as Record<string, Record<string, unknown>>;

              if (url === "/api/cron") {
                // create
                const id = `job-${Date.now()}`;
                jobs[id] = body as Record<string, unknown>;
              } else if (url === "/api/cron/delete") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                delete jobs[id];
              } else if (url === "/api/cron/trigger") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                jobs[id]!["nextRunAtMs"] = Date.now() - 1;
              } else if (url === "/api/cron/toggle") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                jobs[id]!["enabled"] = Boolean(body["enabled"]);
              }

              const tmp = p + ".tmp";
              writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
              renameSync(tmp, p);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ success: false, error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/subagents
      if (url === "/api/subagents" && method === "GET") {
        void (async () => {
          try {
            const { getSubagentRegistry } = await import("./subagent-registry.js");
            const reg = getSubagentRegistry();
            const all = reg ? Array.from(reg["records"].values() as IterableIterator<Record<string, unknown>>) : [];
            const subagents = (all as Record<string, unknown>[]).map(r => ({
              runId: r["runId"], label: r["label"], status: r["status"],
              turns: r["turns"], createdAt: r["createdAt"], endedAt: r["endedAt"],
              task: r["task"], parentSessionKey: r["parentSessionKey"],
              agentId: r["agentId"],
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ subagents }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ subagents: [], error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/subagents/kill
      if (url === "/api/subagents/kill" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { runId } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { runId: string };
              const { getSubagentRegistry } = await import("./subagent-registry.js");
              const reg = getSubagentRegistry();
              const ok = reg ? reg.kill(runId) : false;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(ok ? { success: true } : { success: false, error: "not found or not running" }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ success: false, error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/tasks — 列出所有 session 的 task
      if (url === "/api/tasks" && method === "GET") {
        void (async () => {
          try {
            const { listAllTasks } = await import("./task-store.js");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions: listAllTasks() }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions: [], error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/config — 回傳 runtime config（含 defaults），確保 GUI 顯示正確狀態
      if (url === "/api/config" && method === "GET") {
        void (async () => {
          try {
            const { config: runtimeConfig } = await import("./config.js");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(maskConfig(runtimeConfig), null, 2));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/config
      if (url === "/api/config" && method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => { size += c.length; if (size < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const { resolveConfigPath } = await import("./config.js");
              const cp = resolveConfigPath();
              // 讀取原始 config，將 *** 還原為原始值
              const originalRaw = JSON.parse(readFileSync(cp, "utf-8")) as unknown;
              const restored = restoreMasked(parsed, originalRaw) as Record<string, unknown>;
              const discord = restored?.discord as Record<string, unknown> | undefined;
              if (!discord?.token) throw new Error("缺少必要欄位 discord.token");
              backupConfig(cp);
              const tmp = cp + ".tmp";
              writeFileSync(tmp, JSON.stringify(restored, null, 2), "utf-8");
              renameSync(tmp, cp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/models-json (唯讀：models.json 內容)
      if (url === "/api/models-json" && method === "GET") {
        void (async () => {
          try {
            const { resolveWorkspaceDirSafe } = await import("./config.js");
            const ws = resolveWorkspaceDirSafe();
            const modelsPath = join(ws, "agents", "default", "models.json");
            if (!existsSync(modelsPath)) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ exists: false }));
              return;
            }
            const data = JSON.parse(readFileSync(modelsPath, "utf-8"));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ exists: true, data, path: modelsPath }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/auth-profiles
      if (url === "/api/auth-profiles" && method === "GET") {
        void (async () => {
          try {
            const { resolveWorkspaceDirSafe } = await import("./config.js");
            const ws = resolveWorkspaceDirSafe();
            const credPath = join(ws, "agents", "default", "auth-profile.json");
            let masked: Array<{ id: string; credential: string }> = [];
            const statuses: Record<string, Array<{ id: string; lastUsed?: number; cooldownUntil?: number; cooldownReason?: string; disabled?: boolean }>> = {};

            if (existsSync(credPath)) {
              const raw = JSON.parse(readFileSync(credPath, "utf-8"));
              if (Array.isArray(raw)) {
                // V1 陣列格式
                masked = raw.map((c: { id: string; credential: string }) => ({
                  id: c.id,
                  credential: c.credential ? c.credential.slice(0, 12) + "..." + c.credential.slice(-4) : "",
                }));
              } else if (raw.profiles && typeof raw.profiles === "object") {
                // V2 物件格式
                const profiles = raw.profiles as Record<string, { type: string; provider: string; key?: string; token?: string; access?: string }>;
                const usageStats = (raw.usageStats ?? {}) as Record<string, { lastUsed?: number; cooldownUntil?: number; disabledUntil?: number; disabledReason?: string }>;
                for (const [pid, cred] of Object.entries(profiles)) {
                  const secret = cred.key ?? cred.token ?? cred.access ?? "";
                  masked.push({
                    id: pid,
                    credential: secret ? secret.slice(0, 12) + "..." + secret.slice(-4) : `(${cred.type})`,
                  });
                  // 建立 provider 狀態
                  const provider = cred.provider ?? pid.split(":")[0];
                  if (!statuses[provider]) statuses[provider] = [];
                  const stats = usageStats[pid];
                  statuses[provider].push({
                    id: pid,
                    lastUsed: stats?.lastUsed,
                    cooldownUntil: stats?.cooldownUntil,
                    cooldownReason: stats?.disabledReason,
                    disabled: stats?.disabledUntil === Infinity,
                  });
                }
              }
            }

            // 也讀取舊格式的 per-provider profiles（相容）
            const profilesDir = join(ws, "data", "auth-profiles");
            if (existsSync(profilesDir)) {
              for (const f of readdirSync(profilesDir).filter(f => f.endsWith("-profiles.json"))) {
                try {
                  const data = JSON.parse(readFileSync(join(profilesDir, f), "utf-8"));
                  const providerId = data.providerId ?? f.replace("-profiles.json", "");
                  if (!statuses[providerId]) {
                    statuses[providerId] = (data.profiles ?? []).map((p: Record<string, unknown>) => ({
                      id: p.id, lastUsed: p.lastUsed, cooldownUntil: p.cooldownUntil,
                      cooldownReason: p.cooldownReason, disabled: p.disabled,
                    }));
                  }
                } catch { /* skip */ }
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ credentials: masked, statuses, credentialsPath: credPath }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/auth-profiles (新增/刪除 credential — 支援 V2 格式)
      if (url === "/api/auth-profiles" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { resolveWorkspaceDirSafe } = await import("./config.js");
              const ws = resolveWorkspaceDirSafe();
              const credPath = join(ws, "agents", "default", "auth-profile.json");
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
                action: "add" | "remove";
                id?: string;
                credential?: string;
                provider?: string;
              };

              // 載入現有資料（支援 V1 陣列和 V2 物件）
              let data: { version: number; profiles: Record<string, { type: string; provider: string; key: string }>; order: Record<string, string[]>; usageStats: Record<string, unknown> };
              if (existsSync(credPath)) {
                const raw = JSON.parse(readFileSync(credPath, "utf-8"));
                if (Array.isArray(raw)) {
                  // V1 → V2 就地轉換
                  const profiles: Record<string, { type: string; provider: string; key: string }> = {};
                  for (const c of raw as Array<{ id: string; credential: string }>) {
                    profiles[`anthropic:${c.id}`] = { type: "api_key", provider: "anthropic", key: c.credential };
                  }
                  data = { version: 1, profiles, order: {}, usageStats: {} };
                } else {
                  data = { version: raw.version ?? 1, profiles: raw.profiles ?? {}, order: raw.order ?? {}, usageStats: raw.usageStats ?? {} };
                }
              } else {
                data = { version: 1, profiles: {}, order: {}, usageStats: {} };
              }

              if (body.action === "add" && body.id && body.credential) {
                const credType = (body as Record<string, unknown>).type === "api_key" ? "api_key" : "token";
                data.profiles[body.id] = { type: credType, key: body.credential } as any;
              } else if (body.action === "remove" && body.id) {
                delete data.profiles[body.id];
                if (data.usageStats) delete data.usageStats[body.id];
              } else {
                throw new Error("無效操作（需要 action=add/remove + id）");
              }
              mkdirSync(dirname(credPath), { recursive: true });
              const tmp = credPath + ".tmp";
              writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
              renameSync(tmp, credPath);
              res.writeHead(200); res.end(JSON.stringify({ success: true, count: Object.keys(data.profiles).length }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // POST /api/auth-profiles/clear-cooldown
      if (url === "/api/auth-profiles/clear-cooldown" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { resolveWorkspaceDirSafe } = await import("./config.js");
              const ws = resolveWorkspaceDirSafe();
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { providerId: string; profileId: string };
              const fp = join(ws, "data", "auth-profiles", `${body.providerId}-profiles.json`);
              if (!existsSync(fp)) throw new Error("Profile 不存在");
              const data = JSON.parse(readFileSync(fp, "utf-8"));
              const profile = (data.profiles ?? []).find((p: Record<string, unknown>) => p.id === body.profileId);
              if (!profile) throw new Error("Profile ID 不存在");
              profile.cooldownUntil = 0;
              profile.cooldownReason = undefined;
              profile.disabled = false;
              const tmp = fp + ".tmp";
              writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
              renameSync(tmp, fp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // POST /api/codex-oauth-start — 啟動 Codex OAuth 登入流程
      if (url === "/api/codex-oauth-start" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
        void (async () => {
          try {
            const reqBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, string> : {};
            const profileName = reqBody.profileName || "oauth";
            const credType = reqBody.credType || "oauth";

            if (_codexOAuthState?.status === "pending") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ authUrl: _codexOAuthState.authUrl }));
              return;
            }

            _codexOAuthState = { status: "pending" };

            const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");

            // 用 Promise + 手動 resolve 拿到 authUrl 後立即回傳給前端
            let resolveAuthUrl: (url: string) => void;
            const authUrlPromise = new Promise<string>(r => { resolveAuthUrl = r; });

            // 手動 callback 的 Promise（使用者從前端貼 URL 時 resolve）
            const manualCodePromise = new Promise<string>((r) => { _codexManualResolve = r; });

            // 背景執行 OAuth 流程（browser callback 和手動貼 URL 賽跑）
            const oauthPromise = loginOpenAICodex({
              onAuth: ({ url: authUrl }) => {
                _codexOAuthState!.authUrl = authUrl;
                resolveAuthUrl!(authUrl);
              },
              onPrompt: async (prompt) => {
                // 等待使用者從 dashboard 手動貼 callback URL（5 分鐘逾時）
                log.info(`[dashboard:codex-oauth] 等待手動 callback 輸入...`);
                return Promise.race([
                  manualCodePromise,
                  new Promise<string>((_, reject) => setTimeout(() => {
                    _codexOAuthState = { status: "error", error: "OAuth 逾時（5 分鐘），請重新登入" };
                    reject(new Error("OAuth 等待逾時（5 分鐘）"));
                  }, 5 * 60_000)),
                ]);
              },
              onManualCodeInput: () => {
                // 與 browser callback 賽跑 — 使用者貼 URL 時 resolve
                return manualCodePromise;
              },
              onProgress: (msg) => {
                log.debug(`[dashboard:codex-oauth] ${msg}`);
              },
            });

            // 等 authUrl 回來（通常幾百 ms）
            const authUrl = await Promise.race([
              authUrlPromise,
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error("OAuth 啟動逾時")), 15_000)),
            ]);

            // 回傳 authUrl 給前端
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ authUrl }));

            // 背景等待 OAuth 完成
            oauthPromise.then(async (creds) => {
              // 1. 存入 ~/.codex/auth.json（codex-oauth provider 直接讀此檔）
              const codexAuthPath = resolve(homedir(), ".codex/auth.json");
              const authJson = {
                access_token: creds.access,
                refresh_token: creds.refresh,
                expires_at: Math.floor(creds.expires / 1000),
                token_type: "Bearer",
              };
              mkdirSync(dirname(codexAuthPath), { recursive: true });
              writeFileSync(codexAuthPath, JSON.stringify(authJson, null, 2), "utf-8");

              // 2. 同步寫入 auth-profile.json（讓 Dashboard 顯示 + round-robin 管理）
              try {
                const { resolveWorkspaceDirSafe } = await import("./config.js");
                const ws = resolveWorkspaceDirSafe();
                const credPath = join(ws, "agents", "default", "auth-profile.json");
                let apData: { version: number; profiles: Record<string, unknown>; order: Record<string, string[]>; usageStats: Record<string, unknown> };
                if (existsSync(credPath)) {
                  const raw = JSON.parse(readFileSync(credPath, "utf-8"));
                  apData = { version: raw.version ?? 1, profiles: raw.profiles ?? {}, order: raw.order ?? {}, usageStats: raw.usageStats ?? {} };
                } else {
                  apData = { version: 1, profiles: {}, order: {}, usageStats: {} };
                }
                const apProfileId = `openai-codex:${profileName}`;
                apData.profiles[apProfileId] = {
                  type: credType,
                  provider: "openai-codex",
                  key: creds.access,
                  oauthTokenPath: codexAuthPath,
                };
                mkdirSync(dirname(credPath), { recursive: true });
                const tmp = credPath + ".tmp";
                writeFileSync(tmp, JSON.stringify(apData, null, 2), "utf-8");
                renameSync(tmp, credPath);
                log.info(`[dashboard:codex-oauth] auth-profile.json 已更新 ${apProfileId}`);
              } catch (apErr) {
                log.warn(`[dashboard:codex-oauth] auth-profile.json 寫入失敗：${apErr instanceof Error ? apErr.message : String(apErr)}`);
              }

              _codexOAuthState = {
                status: "success",
                expiresAt: new Date(creds.expires).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
              };
              log.info(`[dashboard:codex-oauth] OAuth 登入成功，token 存入 ${codexAuthPath}`);
            }).catch((err) => {
              _codexOAuthState = { status: "error", error: err instanceof Error ? err.message : String(err) };
              log.error(`[dashboard:codex-oauth] OAuth 失敗：${_codexOAuthState.error}`);
            });
          } catch (err) {
            _codexOAuthState = { status: "error", error: err instanceof Error ? err.message : String(err) };
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: _codexOAuthState.error }));
          }
        })();
        });
        return;
      }

      // GET /api/codex-oauth-status — 查詢 OAuth 流程狀態
      if (url === "/api/codex-oauth-status" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!_codexOAuthState) {
          res.end(JSON.stringify({ status: "idle" }));
        } else {
          res.end(JSON.stringify(_codexOAuthState));
        }
        return;
      }

      // POST /api/codex-oauth-callback — 手動貼 callback URL
      if (url === "/api/codex-oauth-callback" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { callbackUrl: string };
            if (!body.callbackUrl) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "缺少 callbackUrl" }));
              return;
            }
            if (!_codexManualResolve) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "目前沒有進行中的 OAuth 流程" }));
              return;
            }
            log.info(`[dashboard:codex-oauth] 收到手動 callback URL`);
            _codexManualResolve(body.callbackUrl);
            _codexManualResolve = null;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }

      // GET /api/models-config — 讀取 models-config.json
      if (url === "/api/models-config" && method === "GET") {
        void (async () => {
          try {
            const { resolveCatclawDir } = await import("./config.js");
            const p = join(resolveCatclawDir(), "models-config.json");
            if (!existsSync(p)) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ exists: false }));
              return;
            }
            const data = JSON.parse(readFileSync(p, "utf-8"));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ exists: true, data, path: p }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/models-config — 修改 models-config.json（切換模型等）
      if (url === "/api/models-config" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { resolveCatclawDir } = await import("./config.js");
              const p = join(resolveCatclawDir(), "models-config.json");
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
              const data = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};

              if (body.action === "set-primary" && body.primary) {
                const aliases = data.aliases as Record<string, string> | undefined;
                if (aliases && !Object.keys(aliases).includes(body.primary as string) && !Object.values(aliases).includes(body.primary as string)) {
                  throw new Error(`模型 '${body.primary}' 不存在。可用：${Object.keys(aliases).join(", ")}`);
                }
                data.primary = body.primary;
              } else if (body.action === "set-routing" && body.mapKey && body.key) {
                const validMaps = ["channels", "roles", "projects"];
                if (!validMaps.includes(body.mapKey as string)) throw new Error(`無效的路由類型：${body.mapKey}`);
                if (!data.routing) data.routing = {};
                if (!data.routing[body.mapKey as string]) data.routing[body.mapKey as string] = {};
                data.routing[body.mapKey as string][body.key as string] = body.value;
              } else if (body.action === "remove-routing" && body.mapKey && body.key) {
                if (data.routing?.[body.mapKey as string]) {
                  delete data.routing[body.mapKey as string][body.key as string];
                  if (Object.keys(data.routing[body.mapKey as string]).length === 0) delete data.routing[body.mapKey as string];
                  if (Object.keys(data.routing).length === 0) delete data.routing;
                }
              } else {
                throw new Error("不支援的操作");
              }

              const tmp = p + ".tmp";
              writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
              renameSync(tmp, p);
              res.writeHead(200); res.end(JSON.stringify({ success: true, primary: data.primary }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/traces/live — 活躍中的 trace（即時）
      if (url === "/api/traces/live" && method === "GET") {
        const live = MessageTrace.getLiveTraces();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ traces: live }));
        return;
      }

      // GET /api/traces — 最近 N 筆 trace（預設 50）
      if (url.startsWith("/api/traces") && method === "GET") {
        const traceStore = getTraceStore();
        if (!traceStore) { res.writeHead(500); res.end(JSON.stringify({ error: "TraceStore not initialized" })); return; }

        // /api/traces/:traceId/context — context snapshot（lazy load）
        const ctxMatch = url.match(/^\/api\/traces\/([a-f0-9-]+)\/context/);
        if (ctxMatch) {
          const ctxStore = getTraceContextStore();
          if (!ctxStore) { res.writeHead(404); res.end(JSON.stringify({ error: "TraceContextStore not initialized" })); return; }
          const snapshot = ctxStore.get(ctxMatch[1]!);
          if (!snapshot) { res.writeHead(404); res.end(JSON.stringify({ error: "Context snapshot not found" })); return; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(snapshot));
          return;
        }

        // /api/traces/:traceId — 單筆查詢（先查 store，再查 live）
        const idMatch = url.match(/^\/api\/traces\/([a-f0-9-]+)/);
        if (idMatch) {
          const entry = traceStore.getById(idMatch[1]!) ?? MessageTrace.getLiveTraces().find(t => t.traceId === idMatch[1]!);
          if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: "Trace not found" })); return; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(entry));
          return;
        }

        // /api/traces?limit=N&sessionKey=xxx — 列表（可選 sessionKey 過濾）
        const limitMatch = url.match(/[?&]limit=(\d+)/);
        const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : 50;
        const skMatch = url.match(/[?&]sessionKey=([^&]+)/);
        const sessionKeyFilter = skMatch ? decodeURIComponent(skMatch[1]!) : undefined;
        const entries = sessionKeyFilter
          ? traceStore.bySession(sessionKeyFilter, limit)
          : traceStore.recent(limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ traces: entries }));
        return;
      }

      // GET /api/inbound-history — 列出各頻道 pending inbound entries
      if (url.startsWith("/api/inbound-history") && method === "GET") {
        const store = getInboundHistoryStore();
        if (!store) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ channels: [] })); return; }
        const chMatch = url.match(/[?&]channelId=([^&]+)/);
        if (chMatch) {
          const channelId = decodeURIComponent(chMatch[1]!);
          const entries = store.readEntries(channelId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channelId, entries }));
        } else {
          const channels = store.listChannels();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channels }));
        }
        return;
      }

      // POST /api/inbound-history/clear — 清除 inbound entries（單 channel 或全部）
      if (url === "/api/inbound-history/clear" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 8192) chunks.push(c); });
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { channelId?: string };
            const store = getInboundHistoryStore();
            if (!store) { res.writeHead(500); res.end(JSON.stringify({ error: "InboundHistoryStore not initialized" })); return; }
            const count = body.channelId ? store.clearChannelAllScopes(body.channelId) : store.clearAll();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, cleared: count }));
          } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        });
        return;
      }

      // ── Session Management API ─────────────────────────────────────────────

      // POST /api/sessions/clear — 清空指定 session 訊息 + traces
      if (url === "/api/sessions/clear" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 8192) chunks.push(c); });
        req.on("end", () => {
          try {
            const { sessionKey } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { sessionKey?: string };
            if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: "missing sessionKey" })); return; }
            const sm = getSessionManager();
            const count = sm.clearMessages(sessionKey);
            const traceStore = getTraceStore();
            const tracesDeleted = traceStore?.deleteBySession(sessionKey) ?? 0;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, clearedMessages: count, tracesDeleted }));
          } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        });
        return;
      }

      // POST /api/sessions/delete — 刪除指定 session + traces
      if (url === "/api/sessions/delete" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 8192) chunks.push(c); });
        req.on("end", () => {
          try {
            const { sessionKey } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { sessionKey?: string };
            if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: "missing sessionKey" })); return; }
            const sm = getSessionManager();
            sm.delete(sessionKey);
            const traceStore = getTraceStore();
            const tracesDeleted = traceStore?.deleteBySession(sessionKey) ?? 0;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, tracesDeleted }));
          } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        });
        return;
      }

      // POST /api/sessions/compact — 強制觸發 CE 壓縮
      if (url === "/api/sessions/compact" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 8192) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const { sessionKey } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { sessionKey?: string };
              if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: "missing sessionKey" })); return; }
              const sm = getSessionManager();
              const session = sm.get(sessionKey);
              if (!session) { res.writeHead(404); res.end(JSON.stringify({ error: "session not found" })); return; }
              const ce = getContextEngine();
              if (!ce) { res.writeHead(500); res.end(JSON.stringify({ error: "ContextEngine not initialized" })); return; }
              const before = session.messages.length;
              const processed = await ce.build(session.messages, { sessionKey, turnIndex: session.turnCount });
              if (ce.lastBuildBreakdown.strategiesApplied.length > 0) {
                sm.replaceMessages(sessionKey, processed);
              }
              const after = sm.get(sessionKey)?.messages.length ?? 0;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                success: true,
                messagesBefore: before,
                messagesAfter: after,
                strategies: ce.lastBuildBreakdown.strategiesApplied,
              }));
            } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
          })();
        });
        return;
      }

      // POST /api/sessions/purge-expired — 批次清除過期 session
      if (url === "/api/sessions/purge-expired" && method === "POST") {
        try {
          const sm = getSessionManager();
          const count = sm.purgeExpired();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, purgedCount: count }));
        } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        return;
      }

      // POST /api/trigger — 從外部觸發 CatClaw agent 任務（Remote Dispatch）
      if (url === "/api/trigger" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
              const task = String(body["task"] ?? "").trim();
              if (!task) { res.writeHead(400); res.end(JSON.stringify({ error: "task is required" })); return; }

              const channelId = String(body["channelId"] ?? body["channel_id"] ?? "trigger-api");
              const accountId = String(body["accountId"] ?? body["account_id"] ?? "api-trigger");
              const providerId = body["provider"] ? String(body["provider"]) : undefined;
              const runtime = String(body["runtime"] ?? "default");
              const maxTurns = typeof body["maxTurns"] === "number" ? body["maxTurns"] : 10;
              const timeoutMs = typeof body["timeoutMs"] === "number" ? body["timeoutMs"] : 120_000;
              const isAsync = body["async"] !== false; // 預設非同步

              const { getSubagentRegistry } = await import("./subagent-registry.js");
              const registry = getSubagentRegistry();
              if (!registry) { res.writeHead(500); res.end(JSON.stringify({ error: "SubagentRegistry not initialized" })); return; }

              // 建立 subagent record
              const record = registry.create({
                parentSessionKey: `trigger:${channelId}`,
                task,
                label: body["label"] ? String(body["label"]) : `API trigger: ${task.slice(0, 40)}`,
                mode: "run",
                runtime,
                async: true,
                keepSession: false,
                discordChannelId: channelId,
                accountId,
              });

              // 延遲 import 避免循環依賴
              const { agentLoop } = await import("./agent-loop.js");
              const { getPlatformSessionManager, getPlatformPermissionGate, getPlatformToolRegistry, getPlatformSafetyGuard } = await import("./platform.js");
              const { eventBus } = await import("./event-bus.js");
              const { getProviderRegistry } = await import("../providers/registry.js");
              const { getAgentType } = await import("./agent-types.js");

              const providerRegistry = getProviderRegistry();
              const provider = providerId
                ? (providerRegistry.get(providerId) ?? providerRegistry.resolve())
                : providerRegistry.resolve();
              if (!provider) { res.writeHead(500); res.end(JSON.stringify({ error: "No provider available" })); return; }

              const agentType = getAgentType(runtime);

              // 背景執行
              const runFn = async () => {
                let fullText = "";
                let turnCount = 0;
                const loopGen = agentLoop(task, {
                  platform: "api-trigger",
                  channelId: record.childSessionKey,
                  accountId,
                  provider,
                  systemPrompt: agentType.systemPrompt,
                  signal: record.abortController.signal,
                  turnTimeoutMs: timeoutMs as number,
                  allowSpawn: false,
                  _sessionKeyOverride: record.childSessionKey,
                }, {
                  sessionManager: getPlatformSessionManager(),
                  permissionGate: getPlatformPermissionGate(),
                  toolRegistry: getPlatformToolRegistry(),
                  safetyGuard: getPlatformSafetyGuard(),
                  eventBus,
                });
                for await (const event of loopGen) {
                  if (event.type === "text_delta") fullText += event.text;
                  if (event.type === "done") { turnCount = event.turnCount; break; }
                  if (event.type === "error") throw new Error(event.message);
                }
                registry.complete(record.runId, fullText, turnCount);
                log.info(`[trigger-api] completed runId=${record.runId} turns=${turnCount}`);
              };

              if (isAsync) {
                // 非同步：立即回傳 runId
                runFn().catch(err => {
                  const msg = err instanceof Error ? err.message : String(err);
                  registry.fail(record.runId, msg);
                  log.warn(`[trigger-api] failed runId=${record.runId}: ${msg}`);
                });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, runId: record.runId, sessionKey: record.childSessionKey }));
              } else {
                // 同步：等待完成
                try {
                  await runFn();
                  const rec = registry.get(record.runId);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true, runId: record.runId, result: rec?.result ?? "", turns: rec?.turns ?? 0 }));
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  res.writeHead(500, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: false, runId: record.runId, error: msg }));
                }
              }
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/trigger/:runId — 查詢 trigger 任務狀態
      if (url.startsWith("/api/trigger/") && method === "GET") {
        void (async () => {
          try {
            const runId = url.split("/api/trigger/")[1]?.split("?")[0] ?? "";
            const { getSubagentRegistry } = await import("./subagent-registry.js");
            const registry = getSubagentRegistry();
            const rec = registry?.get(runId);
            if (!rec) { res.writeHead(404); res.end(JSON.stringify({ error: "runId not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              runId: rec.runId,
              status: rec.status,
              result: rec.result,
              turns: rec.turns,
              createdAt: rec.createdAt,
              endedAt: rec.endedAt,
              label: rec.label,
            }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/chat/history?sessionKey=xxx — 取得 session 對話歷史
      if (url?.startsWith("/api/chat/history") && method === "GET") {
        const skMatch = url.match(/[?&]sessionKey=([^&]+)/);
        const sessionKey = skMatch ? decodeURIComponent(skMatch[1]!) : "";
        if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: "missing sessionKey" })); return; }
        const sm = getSessionManager();
        const messages = sm.getHistory(sessionKey);
        // 回傳 role + 純文字 content + _ce 壓縮標記
        const simplified = messages
          .filter(m => m.role === "user" || m.role === "assistant")
          .map(m => {
            const content = typeof m.content === "string"
              ? m.content
              : (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
            const entry: Record<string, unknown> = { role: m.role, content };
            if ((m as any).compressionLevel != null && (m as any).compressionLevel > 0) {
              const msg = m as any;
              entry._ce = {
                compressed: true,
                compressionLevel: msg.compressionLevel,
                originalTokens: msg.originalTokens ?? null,
                currentTokens: msg.tokens ?? Math.ceil((content?.length ?? 0) / 4),
                compressedBy: msg.compressedBy ?? null,
              };
            }
            return entry;
          })
          .filter(m => m.content);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(simplified));
        return;
      }

      // POST /api/chat — Dashboard 互動式 Chat（SSE streaming）
      if (url === "/api/chat" && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
              const message = String(body["message"] ?? "").trim();
              if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message is required" })); return; }

              const rawSessionKey = String(body["sessionKey"] ?? "").trim();

              const { agentLoop } = await import("./agent-loop.js");
              const { getPlatformSessionManager, getPlatformPermissionGate, getPlatformToolRegistry, getPlatformSafetyGuard } = await import("./platform.js");
              const { eventBus } = await import("./event-bus.js");
              const { getProviderRegistry } = await import("../providers/registry.js");
              const { runMessagePipeline } = await import("./message-pipeline.js");

              const providerRegistry = getProviderRegistry();
              const provider = providerRegistry.resolve();
              if (!provider) { res.writeHead(500); res.end(JSON.stringify({ error: "No provider available" })); return; }

              const sm = getPlatformSessionManager();
              const pg = getPlatformPermissionGate();
              const tr = getPlatformToolRegistry();
              const sg = getPlatformSafetyGuard();
              if (!sm || !pg || !tr || !sg) {
                res.writeHead(500); res.end(JSON.stringify({ error: "Platform not initialized" })); return;
              }

              // SSE headers
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });

              // Session key：有選則沿用（跨平台共用），無則建立新 web session
              const sessionKey = rawSessionKey || `web:ch:dashboard-${Date.now()}`;
              // 從 session key 推導 channelId（discord:ch:XXX → XXX，否則用 session key 本身）
              const channelId = sessionKey.replace(/^[^:]+:ch:/, "");
              const accountId = "dashboard-user";

              // 確保 dashboard-user 帳號存在（首次自動建立）
              const { getAccountRegistry } = await import("./platform.js");
              const ar = getAccountRegistry();
              if (!ar.get(accountId)) {
                try {
                  ar.create({ accountId, displayName: "Dashboard", role: "platform-owner", identities: [{ platform: "web", platformId: "dashboard", linkedAt: new Date().toISOString() }] });
                } catch { /* 已存在或建立失敗，忽略 */ }
              }

              // ── 統一管線 ────────────────────────────────────────────────────
              const pipeline = await runMessagePipeline({
                prompt: message,
                platform: "api",
                channelId,
                accountId,
                provider,
                role: "platform-owner",
                memoryRecall: true,
                sessionMemory: true,
                modeExtras: true,
                inboundHistory: true,
                conversationLabel: `dashboard channel id:${channelId}`,
              });

              const loopGen = agentLoop(message, {
                platform: "web",
                channelId,
                accountId,
                provider,
                systemPrompt: pipeline.systemPrompt || undefined,
                allowSpawn: true,
                _sessionKeyOverride: sessionKey,
                ...(pipeline.sessionMemoryOpts ? { sessionMemory: pipeline.sessionMemoryOpts } : {}),
                trace: pipeline.trace,
                promptBreakdownHints: pipeline.promptBreakdownHints,
              }, {
                sessionManager: sm,
                permissionGate: pg,
                toolRegistry: tr,
                safetyGuard: sg,
                eventBus,
              });

              let turnCount = 0;
              for await (const event of loopGen) {
                if (event.type === "text_delta") {
                  res.write(`data: ${JSON.stringify({ type: "text_delta", text: event.text })}\n\n`);
                } else if (event.type === "tool_result") {
                  res.write(`data: ${JSON.stringify({ type: "tool_call", name: event.name })}\n\n`);
                } else if (event.type === "done") {
                  turnCount = event.turnCount;
                } else if (event.type === "error") {
                  res.write(`data: ${JSON.stringify({ type: "error", message: event.message })}\n\n`);
                }
              }
              res.write(`data: ${JSON.stringify({ type: "done", turns: turnCount })}\n\n`);
              res.end();
            } catch (err) {
              try {
                if (!res.headersSent) {
                  res.writeHead(500, { "Content-Type": "application/json" });
                }
                res.end(JSON.stringify({ error: String(err) }));
              } catch { /* ignore */ }
            }
          })();
        });
        return;
      }

      // ══════════════════════════════════════════════════════════════════════
      // Memory API
      // ══════════════════════════════════════════════════════════════════════

      // GET /api/memory/atoms — 列出所有 atom
      if (url === "/api/memory/atoms" && method === "GET") {
        void (async () => {
          try {
            const { listAtoms } = await import("../memory/memory-api.js");
            const { config } = await import("./config.js");
            const memRoot = config.memory?.root?.replace("~", homedir()) ?? join(homedir(), ".catclaw", "memory");
            const dirs = [memRoot];
            // 加入 accounts 子目錄
            const accountsDir = join(memRoot, "accounts");
            if (existsSync(accountsDir)) {
              for (const d of readdirSync(accountsDir)) {
                const p = join(accountsDir, d);
                if (existsSync(p)) dirs.push(p);
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(listAtoms(dirs)));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/memory/stats — 統計
      if (url === "/api/memory/stats" && method === "GET") {
        void (async () => {
          try {
            const { getStats } = await import("../memory/memory-api.js");
            const { config } = await import("./config.js");
            const memRoot = config.memory?.root?.replace("~", homedir()) ?? join(homedir(), ".catclaw", "memory");
            const dirs = [memRoot];
            const accountsDir = join(memRoot, "accounts");
            if (existsSync(accountsDir)) {
              for (const d of readdirSync(accountsDir)) {
                const p = join(accountsDir, d);
                if (existsSync(p)) dirs.push(p);
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(getStats(dirs)));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/memory/atoms/:name — 單一 atom
      if (url?.startsWith("/api/memory/atoms/") && method === "GET") {
        void (async () => {
          try {
            const name = decodeURIComponent(url!.split("/api/memory/atoms/")[1]);
            const { getAtom } = await import("../memory/memory-api.js");
            const { config } = await import("./config.js");
            const memRoot = config.memory?.root?.replace("~", homedir()) ?? join(homedir(), ".catclaw", "memory");
            const dirs = [memRoot];
            const accountsDir = join(memRoot, "accounts");
            if (existsSync(accountsDir)) {
              for (const d of readdirSync(accountsDir)) dirs.push(join(accountsDir, d));
            }
            const atom = getAtom(dirs, name);
            if (!atom) { res.writeHead(404); res.end(JSON.stringify({ error: "atom not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(atom));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // DELETE /api/memory/atoms/:name — 刪除 atom
      if (url?.startsWith("/api/memory/atoms/") && method === "DELETE") {
        void (async () => {
          try {
            const name = decodeURIComponent(url!.split("/api/memory/atoms/")[1]);
            const { deleteAtom } = await import("../memory/memory-api.js");
            const { config } = await import("./config.js");
            const memRoot = config.memory?.root?.replace("~", homedir()) ?? join(homedir(), ".catclaw", "memory");
            const dirs = [memRoot];
            const ok = deleteAtom(dirs, name);
            res.writeHead(ok ? 200 : 404);
            res.end(JSON.stringify({ success: ok }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/memory/recall-test — 測試 recall
      if (url === "/api/memory/recall-test" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { prompt: string; accountId?: string };
              const { testRecall } = await import("../memory/memory-api.js");
              const { config } = await import("./config.js");
              const memRoot = config.memory?.root?.replace("~", homedir()) ?? join(homedir(), ".catclaw", "memory");
              const accountId = body.accountId ?? "test";
              const result = await testRecall(
                body.prompt,
                { accountId, skipCache: true },
                {
                  globalDir: memRoot,
                  accountDir: join(memRoot, "accounts", accountId),
                },
              );
              // 轉換為 JSON-safe 格式（去掉 atom.raw 減少 payload）
              const safeFragments = result.fragments.map(f => ({
                name: f.id,
                layer: f.layer,
                score: Math.round(f.score * 10000) / 10000,
                matchedBy: f.matchedBy,
                confidence: f.atom.confidence,
                description: f.atom.description,
                contentPreview: f.atom.content.slice(0, 200),
              }));
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ...result, fragments: safeFragments }));
            } catch (err) {
              res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/memory/vector/stats — LanceDB 統計
      if (url === "/api/memory/vector/stats" && method === "GET") {
        void (async () => {
          try {
            const { getVectorService } = await import("../vector/lancedb.js");
            const vs = getVectorService();
            const stats = await vs.stats();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ available: vs.isAvailable(), ...stats }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ available: false, error: String(err) }));
          }
        })();
        return;
      }

      // ══════════════════════════════════════════════════════════════════════════
      // Memory Pipeline API 端點
      // ══════════════════════════════════════════════════════════════════════════

      // GET /api/ollama/status — Ollama 連線狀態
      if (url === "/api/ollama/status" && method === "GET") {
        void (async () => {
          try {
            const { config } = await import("./config.js");
            const host = config.ollama?.primary?.host ?? "http://localhost:11434";
            const resp = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(5000) });
            if (resp.ok) {
              const data = await resp.json() as { version?: string };
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ online: true, host, version: data.version ?? "unknown" }));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ online: false, host, error: `HTTP ${resp.status}` }));
            }
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ online: false, error: err instanceof Error ? err.message : String(err) }));
          }
        })();
        return;
      }

      // GET /api/ollama/models — 已安裝模型列表
      if (url === "/api/ollama/models" && method === "GET") {
        void (async () => {
          try {
            const { config } = await import("./config.js");
            const host = config.ollama?.primary?.host ?? "http://localhost:11434";
            const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json() as { models: Array<{ name: string; size: number; modified_at: string; details?: { parameter_size?: string; family?: string } }> };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ models: data.models ?? [] }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ models: [], error: err instanceof Error ? err.message : String(err) }));
          }
        })();
        return;
      }

      // POST /api/ollama/pull — 拉取模型
      if (url === "/api/ollama/pull" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { name: string };
              if (!body.name) { res.writeHead(400); res.end(JSON.stringify({ error: "name required" })); return; }
              const { config } = await import("./config.js");
              const host = config.ollama?.primary?.host ?? "http://localhost:11434";
              const pullResp = await fetch(`${host}/api/pull`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: body.name, stream: false }),
                signal: AbortSignal.timeout(600000),
              });
              if (!pullResp.ok) throw new Error(`HTTP ${pullResp.status}`);
              const result = await pullResp.json();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, status: (result as { status?: string }).status ?? "success" }));
            } catch (err) {
              res.writeHead(500); res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          })();
        });
        return;
      }

      // DELETE /api/ollama/model/:name — 刪除模型
      if (url.startsWith("/api/ollama/model/") && method === "DELETE") {
        void (async () => {
          try {
            const modelName = decodeURIComponent(url.slice("/api/ollama/model/".length).split("?")[0]);
            if (!modelName) { res.writeHead(400); res.end(JSON.stringify({ error: "model name required" })); return; }
            const { config } = await import("./config.js");
            const host = config.ollama?.primary?.host ?? "http://localhost:11434";
            const delResp = await fetch(`${host}/api/delete`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: modelName }),
            });
            if (!delResp.ok) throw new Error(`HTTP ${delResp.status}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })();
        return;
      }

      // GET /api/memory/pipeline — 目前管線設定
      if (url === "/api/memory/pipeline" && method === "GET") {
        void (async () => {
          try {
            const { config } = await import("./config.js");
            const { hasEmbeddingProvider, getEmbeddingProvider } = await import("../vector/embedding-provider.js");
            const { getCachedDim } = await import("../vector/embedding.js");
            const pipeline = config.memoryPipeline;
            const provider = hasEmbeddingProvider() ? {
              name: getEmbeddingProvider().providerName,
              model: getEmbeddingProvider().modelName,
            } : null;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              config: pipeline ?? null,
              activeProvider: provider,
              embeddingDim: getCachedDim(),
            }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // PUT /api/memory/pipeline — 更新管線設定（寫回 catclaw.json）
      if (url === "/api/memory/pipeline" && method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
                embedding?: { provider: string; model: string; host?: string; apiKey?: string; dimensions?: number };
                extraction?: { provider: string; model: string; host?: string; apiKey?: string };
              };
              const { resolveConfigPath } = await import("./config.js");
              const configPath = resolveConfigPath();
              const rawText = readFileSync(configPath, "utf-8");
              const rawJson = JSON.parse(rawText);
              if (body.embedding) {
                rawJson.memoryPipeline = rawJson.memoryPipeline ?? {};
                rawJson.memoryPipeline.embedding = body.embedding;
              }
              if (body.extraction) {
                rawJson.memoryPipeline = rawJson.memoryPipeline ?? {};
                rawJson.memoryPipeline.extraction = body.extraction;
              }
              writeFileSync(configPath, JSON.stringify(rawJson, null, 2), "utf-8");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, message: "已更新 catclaw.json（需 resync 才生效）" }));
            } catch (err) {
              res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // POST /api/memory/resync — 觸發 vector resync
      if (url === "/api/memory/resync" && method === "POST") {
        void (async () => {
          try {
            const { getPlatformMemoryEngine } = await import("./platform.js");
            const engine = getPlatformMemoryEngine();
            if (!engine) { res.writeHead(500); res.end(JSON.stringify({ error: "MemoryEngine 未啟動" })); return; }

            const status = engine.getStatus();
            const memRoot = join(homedir(), ".catclaw", "memory");
            const layers: Array<{ label: string; dir: string; namespace: string }> = [];
            layers.push({ label: "global", dir: status.globalDir, namespace: "global" });

            const projectsDir = join(memRoot, "projects");
            if (existsSync(projectsDir)) {
              for (const sub of readdirSync(projectsDir)) {
                layers.push({ label: `project/${sub}`, dir: join(projectsDir, sub), namespace: `project/${sub}` });
              }
            }
            const accountsDir = join(memRoot, "accounts");
            if (existsSync(accountsDir)) {
              for (const sub of readdirSync(accountsDir)) {
                layers.push({ label: `account/${sub}`, dir: join(accountsDir, sub), namespace: `account/${sub}` });
              }
            }

            const report: Array<{ layer: string; seeded: number; skipped: number; errors: number }> = [];
            for (const l of layers) {
              if (!existsSync(l.dir)) continue;
              try {
                const result = await engine.seedFromDir(l.dir, l.namespace);
                report.push({ layer: l.label, ...result });
              } catch (err) {
                report.push({ layer: l.label, seeded: 0, skipped: 0, errors: 1 });
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, report }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // ── CLI Bridges Config API（讀寫 cli-bridges.json）──────────────────

      // GET /api/cli-bridges/config
      if (url === "/api/cli-bridges/config" && method === "GET") {
        void (async () => {
          try {
            const { loadAllCliBridgeConfigs } = await import("../cli-bridge/index.js");
            const configs = loadAllCliBridgeConfigs();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(configs, null, 2));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/cli-bridges/config
      if (url === "/api/cli-bridges/config" && method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => { size += c.length; if (size < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = JSON.parse(body);
              if (!Array.isArray(parsed)) throw new Error("格式錯誤：需要陣列");
              const { saveCliBridgeConfigs } = await import("../cli-bridge/index.js");
              saveCliBridgeConfigs(parsed);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // ── CLI Bridge API ──────────────────────────────────────────────────

      // GET /api/cli-bridge/list
      if (url === "/api/cli-bridge/list" && method === "GET") {
        void (async () => {
          try {
            const { getAllBridges } = await import("../cli-bridge/index.js");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ bridges: getAllBridges() }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ bridges: [], error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/cli-bridge/:label/stream (SSE)
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/stream/) && method === "GET") {
        const label = decodeURIComponent(url.split("/")[3]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }

            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            });

            // 送出最近 50 筆作為初始資料
            const recent = bridge.getRecentLogs(50);
            res.write(`data: ${JSON.stringify({ type: "init", events: recent })}\n\n`);

            const unsub = bridge.getStdoutLogger().onEvent((entry) => {
              try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { /* 靜默 */ }
            });

            req.on("close", () => { unsub(); });
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/cli-bridge/:label/status
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/status$/) && method === "GET") {
        const label = decodeURIComponent(url.split("/")[3]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              label: bridge.label,
              channelId: bridge.channelId,
              status: bridge.status,
              sessionId: bridge.currentSessionId,
            }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/cli-bridge/:label/turns?limit=50
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/turns/) && method === "GET") {
        const label = decodeURIComponent(url.split("/")[3]!);
        const limitMatch = url.match(/[?&]limit=(\d+)/);
        const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : 50;
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ turns: bridge.getTurnHistory(limit) }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/cli-bridge/:label/logs?limit=100
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/logs/) && method === "GET") {
        const label = decodeURIComponent(url.split("/")[3]!);
        const limitMatch = url.match(/[?&]limit=(\d+)/);
        const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : 100;
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ logs: bridge.getRecentLogs(limit) }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/cli-bridge/:label/send  body: { text }
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/send$/) && method === "POST") {
        const label = decodeURIComponent(url.split("/")[3]!);
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { text } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { text: string };
              if (!text?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: "text is required" })); return; }
              const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
              const bridge = getCliBridgeByLabel(label);
              if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
              const handle = bridge.send(text, "dashboard");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, turnId: handle.turnId }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ success: false, error: String(err) }));
            }
          })();
        });
        return;
      }

      // POST /api/cli-bridge/:label/interrupt
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/interrupt$/) && method === "POST") {
        const label = decodeURIComponent(url.split("/")[3]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            await bridge.interrupt();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/cli-bridge/:label/restart
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/restart$/) && method === "POST") {
        const label = decodeURIComponent(url.split("/")[3]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            await bridge.restart();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/cli-bridge/:label/resend/:turnId
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/resend\/[^/]+$/) && method === "POST") {
        const parts = url.split("/");
        const label = decodeURIComponent(parts[3]!);
        const turnId = decodeURIComponent(parts[5]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            const turn = bridge.getStdoutLogger().getTurn(turnId);
            if (!turn) { res.writeHead(404); res.end(JSON.stringify({ error: "turn not found" })); return; }
            // 用原始 userInput 重新送出
            const handle = bridge.send(turn.userInput, "dashboard");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, newTurnId: handle.turnId, originalTurnId: turnId }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, error: String(err) }));
          }
        })();
        return;
      }

      // GET /api/cli-bridge/:label/export — 匯出 turn 歷程為 Markdown
      if (url.match(/^\/api\/cli-bridge\/[^/]+\/export/) && method === "GET") {
        const label = decodeURIComponent(url.split("/")[3]!);
        void (async () => {
          try {
            const { getCliBridgeByLabel } = await import("../cli-bridge/index.js");
            const bridge = getCliBridgeByLabel(label);
            if (!bridge) { res.writeHead(404); res.end(JSON.stringify({ error: "bridge not found" })); return; }
            const turns = bridge.getTurnHistory(200);
            let md = `# CLI Bridge: ${label} — Turn 歷程\n\n`;
            md += `匯出時間：${new Date().toISOString()}\n\n`;
            for (const t of turns) {
              md += `---\n\n`;
              md += `## Turn ${t.turnId.slice(0, 8)} (${t.source})\n\n`;
              md += `**時間**：${t.startedAt}${t.completedAt ? ` → ${t.completedAt}` : ""}\n`;
              md += `**送達**：${t.discordDelivery}${t.failedReason ? ` (${t.failedReason})` : ""}\n\n`;
              md += `### User\n\n${t.userInput}\n\n`;
              if (t.toolCalls.length) {
                md += `### Tools (${t.toolCalls.length})\n\n`;
                for (const tc of t.toolCalls) {
                  md += `- \`${tc.name}\`${tc.durationMs ? ` (${Math.round(tc.durationMs / 1000)}s)` : ""}\n`;
                }
                md += `\n`;
              }
              md += `### Assistant\n\n${t.assistantReply || "(empty)"}\n\n`;
            }
            res.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": `attachment; filename="cli-bridge-${label}-export.md"`,
            });
            res.end(md);
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      res.writeHead(404); res.end("Not found");
    });

    server.listen(this.port, "0.0.0.0", () => {
      log.info(`[dashboard] 啟動 http://127.0.0.1:${this.port}`);
    });

    server.on("error", (err) => {
      log.warn(`[dashboard] HTTP 錯誤：${err.message}`);
    });
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _dashboard: DashboardServer | null = null;

export function initDashboard(port = 8088, token?: string): DashboardServer {
  _dashboard = new DashboardServer(port, token);
  if (token) log.info(`[dashboard] 認證已啟用（token 長度 ${token.length}）`);
  _dashboard.start();
  return _dashboard;
}

export function getDashboard(): DashboardServer | null {
  return _dashboard;
}
