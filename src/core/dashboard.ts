/**
 * @file core/dashboard.ts
 * @description Web Dashboard — 多分頁監控 + 操作面板
 *
 * 分頁：概覽 | Sessions | 日誌 | 操作 | Config
 * 端點：GET /  GET /api/usage  GET /api/sessions  GET /api/status
 *        GET /api/logs  POST /api/restart  GET /api/subagents
 *        GET /api/config  POST /api/config
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, existsSync } from "node:fs";
import { dirname, basename, join as pathJoin, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { getTurnAuditLog, type TurnAuditEntry } from "./turn-audit-log.js";

// ── Config 備份 ──────────────────────────────────────────────────────────────
const BACKUP_KEEP = 5;

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
const SENSITIVE_KEYS = new Set(["token", "apiKey", "api_key", "password"]);
function maskConfig(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskConfig);
  if (obj && typeof obj === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      r[k] = SENSITIVE_KEYS.has(k) ? "***" : maskConfig(v);
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
  const auditLog = getTurnAuditLog();
  if (!auditLog) return { error: "TurnAuditLog not initialized" };

  const cutoff = Date.now() - days * 86400_000;
  const entries = auditLog.recent(100000, (e) => new Date(e.ts).getTime() >= cutoff);

  const totalInput = entries.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
  const totalOutput = entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
  const ceEntries = entries.filter(e => e.ceApplied.length > 0);
  const avgTokensSaved = ceEntries.length > 0
    ? Math.round(ceEntries.reduce((s, e) =>
        s + ((e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0)), 0) / ceEntries.length)
    : 0;

  const dailyMap = new Map<string, { input: number; output: number; ceTokensSaved: number }>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const d = dailyMap.get(date) ?? { input: 0, output: 0, ceTokensSaved: 0 };
    d.input += e.inputTokens ?? 0;
    d.output += e.outputTokens ?? 0;
    if (e.ceApplied.length > 0) {
      d.ceTokensSaved += (e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0);
    }
    dailyMap.set(date, d);
  }
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  const recentTurns: TurnAuditEntry[] = entries.slice(0, 20);

  return { totalInput, totalOutput, totalTokens: totalInput + totalOutput,
    totalTurns: entries.length, ceTriggers: ceEntries.length, avgTokensSaved, daily, recentTurns };
}

function buildSessionsData() {
  const auditLog = getTurnAuditLog();
  if (!auditLog) return { error: "TurnAuditLog not initialized" };

  const entries = auditLog.recent(100000);
  const sessMap = new Map<string, {
    sessionKey: string; turns: number; inputTokens: number; outputTokens: number;
    firstTs: string; lastTs: string; ceTriggers: number;
    recentTurns: TurnAuditEntry[];
  }>();

  for (const e of entries) {
    const k = e.sessionKey;
    const s = sessMap.get(k) ?? {
      sessionKey: k, turns: 0, inputTokens: 0, outputTokens: 0,
      firstTs: e.ts, lastTs: e.ts, ceTriggers: 0, recentTurns: [],
    };
    s.turns++;
    s.inputTokens += e.inputTokens ?? 0;
    s.outputTokens += e.outputTokens ?? 0;
    if (e.ceApplied.length > 0) s.ceTriggers++;
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (s.recentTurns.length < 10) s.recentTurns.push(e);
    sessMap.set(k, s);
  }

  const sessions = Array.from(sessMap.values())
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
    .slice(0, 50);

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
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.17/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.17/theme/monokai.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.17/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.17/mode/javascript/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.17/mode/yaml/yaml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; }
.topbar { background: #1a1d2e; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2a2d3e; }
.topbar h1 { font-size: 1.1rem; color: #a78bfa; flex: 1; }
.tabs { display: flex; gap: 2px; background: #0f1117; padding: 0 20px; border-bottom: 1px solid #2a2d3e; }
.tab { padding: 10px 16px; cursor: pointer; font-size: 0.85rem; color: #888; border-bottom: 2px solid transparent; }
.tab.active { color: #a78bfa; border-bottom-color: #a78bfa; }
.tab:hover:not(.active) { color: #ccc; }
.pane { display: none; padding: 20px; }
.pane.active { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.card { background: #1e2130; border-radius: 8px; padding: 16px; }
.card h2 { font-size: 0.9rem; color: #818cf8; margin-bottom: 10px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
.stat { background: #1e2130; border-radius: 8px; padding: 12px; text-align: center; }
.stat-val { font-size: 1.3rem; font-weight: bold; color: #a78bfa; }
.stat-lbl { font-size: 0.72rem; color: #888; margin-top: 4px; }
canvas { max-height: 200px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid #2a2d3e; text-align: left; }
.tbl th { color: #818cf8; background: #161827; }
.tbl tr:hover td { background: #1e2130; }
.btn { background: #4c1d95; border: none; color: white; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.btn:hover { background: #5b21b6; }
.btn-green { background: #065f46; } .btn-green:hover { background: #047857; }
.btn-red { background: #7f1d1d; } .btn-red:hover { background: #991b1b; }
.btn-sm { padding: 3px 8px; font-size: 0.72rem; }
.msg { font-size: 0.8rem; margin: 6px 0; }
.msg.ok { color: #34d399; } .msg.err { color: #f87171; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; }
.badge-run { background: #065f46; color: #34d399; }
.badge-done { background: #1e3a5f; color: #60a5fa; }
.badge-err { background: #7f1d1d; color: #f87171; }
textarea { width: 100%; background: #0f1117; color: #e0e0e0; border: 1px solid #2a2d3e; border-radius: 6px; padding: 8px; font-family: monospace; font-size: 0.78rem; resize: vertical; }
details summary { cursor: pointer; color: #818cf8; font-size: 0.78rem; padding: 4px 0; }
details[open] summary { margin-bottom: 6px; }
.CodeMirror { height: 580px; font-size: 0.82rem; border: 1px solid #2a2d3e; border-radius: 6px; }
.cm-mode-btn { background: #1e3a5f; border: none; color: #60a5fa; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; }
.cm-mode-btn.active { background: #065f46; color: #34d399; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🐱 CatClaw Dashboard</h1>
  <button class="btn btn-sm" onclick="refreshAll()">↻ 全部刷新</button>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('overview',this)">概覽</div>
  <div class="tab" onclick="switchTab('sessions',this)">Sessions</div>
  <div class="tab" onclick="switchTab('logs',this)">日誌</div>
  <div class="tab" onclick="switchTab('ops',this)">操作</div>
  <div class="tab" onclick="switchTab('config',this)">Config</div>
</div>

<!-- 概覽 -->
<div id="pane-overview" class="pane active">
  <div class="stats" id="stats"></div>
  <div class="card" style="margin-bottom:16px">
    <h2>Bot 狀態</h2>
    <div id="status-grid" class="stats" style="margin-bottom:0"></div>
  </div>
  <div class="grid">
    <div class="card"><h2>每日 Token 用量</h2><canvas id="tokenChart"></canvas></div>
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
    <h2>Sessions（最近 50）<button class="btn btn-sm" style="float:right" onclick="loadSessions()">↻</button></h2>
    <div id="sessions-list"></div>
  </div>
</div>

<!-- 日誌 -->
<div id="pane-logs" class="pane">
  <div class="card">
    <h2>PM2 日誌（最近 200 行）
      <button class="btn btn-sm" style="float:right;margin-left:4px" onclick="startLogRefresh()">▶ 自動刷新</button>
      <button class="btn btn-sm" style="float:right" onclick="loadLogs()">↻ 讀取</button>
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

<!-- Config -->
<div id="pane-config" class="pane">
  <div class="card">
    <h2>Config 編輯器
      <button class="btn btn-sm" style="float:right;margin-left:4px" onclick="saveCfg()">💾 備份後儲存</button>
      <button class="btn btn-sm" style="float:right;margin-left:4px;display:none" onclick="convertYaml()" id="btn-yaml-convert">⇄ YAML→JSON</button>
      <button class="cm-mode-btn" style="float:right;margin-left:4px" onclick="toggleYamlMode()" id="btn-yaml-mode">YAML 模式</button>
      <button class="btn btn-sm" style="float:right" onclick="loadCfg()">↻ 讀取</button>
    </h2>
    <p style="font-size:0.72rem;color:#f59e0b;margin:6px 0">⚠ 敏感欄位顯示 ***，儲存前請手動還原實際值</p>
    <div id="cfg-msg" class="msg"></div>
    <div id="cfg-editor"></div>
  </div>
</div>

<script>
let tokenChart, ceChart;
let logTimer = null;

function switchTab(id, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pane-' + id).classList.add('active');
  if (id === 'sessions') loadSessions();
  if (id === 'logs') loadLogs();
  if (id === 'ops') { loadSubagents(); }
  if (id === 'config') loadCfg();
}

function refreshAll() { loadOverview(); loadStatus(); }

// ── 概覽 ─────────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    document.getElementById('status-grid').innerHTML = [
      ['Uptime', d.uptimeStr], ['Memory', d.memoryMB + ' MB'],
      ['Heap', d.heapUsedMB + ' MB'], ['PID', d.pid],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val" style="font-size:1rem">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');
  } catch {}
}

async function loadOverview() {
  try {
    const d = await fetch('/api/usage').then(r => r.json());
    document.getElementById('stats').innerHTML = [
      ['合計 Tokens', (d.totalTokens||0).toLocaleString()],
      ['輸入', (d.totalInput||0).toLocaleString()],
      ['輸出', (d.totalOutput||0).toLocaleString()],
      ['CE 觸發', d.ceTriggers||0],
      ['平均省 Tokens', (d.avgTokensSaved||0).toLocaleString()],
      ['Turns', d.totalTurns||0],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');

    const labels = d.daily.map(x => x.date.slice(5));
    if (tokenChart) tokenChart.destroy();
    tokenChart = new Chart(document.getElementById('tokenChart'), {
      type:'bar', data:{ labels, datasets:[
        {label:'輸入',data:d.daily.map(x=>x.input),backgroundColor:'#4c1d95'},
        {label:'輸出',data:d.daily.map(x=>x.output),backgroundColor:'#1d4ed8'},
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
      const tok = e.inputTokens != null ? \`↑\${e.inputTokens}/↓\${e.outputTokens??0}\` : '-';
      const dur = e.durationMs != null ? \`\${(e.durationMs/1000).toFixed(1)}s\` : '-';
      const sk = (e.sessionKey||'').slice(-16);
      return \`<tr><td>\${ts}</td><td title="\${e.sessionKey}">\${sk}</td><td>\${tok}</td><td>\${e.ceApplied?.join('+')||'-'}</td><td>\${dur}</td></tr>\`;
    }).join('');
    document.getElementById('turns').innerHTML =
      \`<table class="tbl"><thead><tr><th>時間</th><th>Session</th><th>Tokens</th><th>CE</th><th>耗時</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { console.error(e); }
}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const d = await fetch('/api/sessions').then(r => r.json());
    if (!d.sessions?.length) { document.getElementById('sessions-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無資料</p>'; return; }
    const rows = d.sessions.map(s => {
      const last = new Date(s.lastTs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const tok = \`↑\${s.inputTokens.toLocaleString()}/↓\${s.outputTokens.toLocaleString()}\`;
      const turnsHtml = s.recentTurns.map(e => {
        const ts2 = new Date(e.ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
        const dur = e.durationMs != null ? \`\${(e.durationMs/1000).toFixed(1)}s\` : '-';
        return \`<tr><td>\${ts2}</td><td>\${e.inputTokens??'-'}/\${e.outputTokens??'-'}</td><td>\${e.ceApplied?.join('+')||'-'}</td><td>\${dur}</td></tr>\`;
      }).join('');
      const detail = \`<details><summary>展開 \${s.turns} turns</summary><table class="tbl"><thead><tr><th>時間</th><th>Tokens</th><th>CE</th><th>耗時</th></tr></thead><tbody>\${turnsHtml}</tbody></table></details>\`;
      return \`<tr><td title="\${s.sessionKey}">\${s.sessionKey.slice(-24)}</td><td>\${last}</td><td>\${s.turns}</td><td>\${tok}</td><td>\${s.ceTriggers}</td><td>\${detail}</td></tr>\`;
    }).join('');
    document.getElementById('sessions-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Session</th><th>最後活躍</th><th>Turns</th><th>Tokens</th><th>CE</th><th>詳細</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { document.getElementById('sessions-list').innerHTML = '讀取失敗：' + e; }
}

// ── 日誌 ─────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const text = await fetch('/api/logs?lines=200').then(r => r.text());
    const el = document.getElementById('log-area');
    el.value = text;
    el.scrollTop = el.scrollHeight;
  } catch(e) { document.getElementById('log-area').value = '讀取失敗：' + e; }
}

function startLogRefresh() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; return; }
  loadLogs();
  logTimer = setInterval(loadLogs, 5000);
}

// ── 操作 ─────────────────────────────────────────────────────────────────────
async function doRestart() {
  if (!confirm('確定重啟 Bot？')) return;
  try {
    const d = await fetch('/api/restart', {method:'POST'}).then(r => r.json());
    const el = document.getElementById('ops-msg');
    el.className = 'msg ' + (d.success ? 'ok' : 'err');
    el.textContent = d.success ? '✓ 重啟信號已送出' : '錯誤：' + d.error;
  } catch(e) { const el = document.getElementById('ops-msg'); el.className='msg err'; el.textContent='失敗：'+e; }
}

async function loadSubagents() {
  try {
    const d = await fetch('/api/subagents').then(r => r.json());
    if (!d.subagents?.length) { document.getElementById('subagents-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無 active subagent</p>'; return; }
    const rows = d.subagents.map(s => {
      const badge = s.status === 'running' ? 'badge-run' : s.status === 'completed' ? 'badge-done' : 'badge-err';
      return \`<tr><td>\${s.label||s.runId.slice(-8)}</td><td><span class="badge \${badge}">\${s.status}</span></td><td>\${s.turns||0}</td></tr>\`;
    }).join('');
    document.getElementById('subagents-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Label</th><th>狀態</th><th>Turns</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch {}
}

// ── Config ───────────────────────────────────────────────────────────────────
let cfgEditor = null;
let cfgYamlMode = false;

function initCfgEditor(initialValue) {
  if (cfgEditor) { cfgEditor.setValue(initialValue); return; }
  cfgEditor = CodeMirror(document.getElementById('cfg-editor'), {
    value: initialValue,
    mode: { name: 'javascript', json: true },
    theme: 'monokai',
    lineNumbers: true,
    lineWrapping: false,
    tabSize: 2,
    indentWithTabs: false,
  });
}

async function loadCfg() {
  try {
    const text = await fetch('/api/config').then(r => r.text());
    initCfgEditor(text);
    document.getElementById('cfg-msg').textContent = '';
  } catch(e) { showCfgMsg('讀取失敗：' + e, false); }
}

function toggleYamlMode() {
  cfgYamlMode = !cfgYamlMode;
  const btn = document.getElementById('btn-yaml-mode');
  const btnConvert = document.getElementById('btn-yaml-convert');
  btn.textContent = cfgYamlMode ? '✓ YAML 模式' : 'YAML 模式';
  btn.classList.toggle('active', cfgYamlMode);
  btnConvert.style.display = cfgYamlMode ? 'inline-block' : 'none';
  if (cfgEditor) cfgEditor.setOption('mode', cfgYamlMode ? 'yaml' : { name: 'javascript', json: true });
}

function convertYaml() {
  if (!cfgEditor || !cfgYamlMode) return;
  try {
    const obj = jsyaml.load(cfgEditor.getValue());
    cfgYamlMode = false;
    document.getElementById('btn-yaml-mode').textContent = 'YAML 模式';
    document.getElementById('btn-yaml-mode').classList.remove('active');
    document.getElementById('btn-yaml-convert').style.display = 'none';
    cfgEditor.setOption('mode', { name: 'javascript', json: true });
    cfgEditor.setValue(JSON.stringify(obj, null, 2));
    showCfgMsg('✓ 已轉換為 JSON', true);
  } catch(e) { showCfgMsg('YAML 解析失敗：' + e, false); }
}

async function saveCfg() {
  if (!cfgEditor) { showCfgMsg('編輯器未初始化', false); return; }
  let body = cfgEditor.getValue();
  if (cfgYamlMode) {
    try { body = JSON.stringify(jsyaml.load(body), null, 2); }
    catch(e) { showCfgMsg('YAML 解析失敗：' + e, false); return; }
  }
  try { JSON.parse(body); } catch(e) { showCfgMsg('JSON 格式錯誤：' + e, false); return; }
  try {
    const d = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body}).then(r=>r.json());
    showCfgMsg(d.success ? '✓ 已備份並儲存' : '錯誤：' + d.error, d.success);
  } catch(e) { showCfgMsg('儲存失敗：' + e, false); }
}

function showCfgMsg(msg, ok) {
  const el = document.getElementById('cfg-msg');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
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

  constructor(port = 8088) {
    this.port = port;
  }

  start(): void {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (url === "/" || url === "/index.html") {
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
        }));
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
        return;
      }

      // GET /api/subagents
      if (url === "/api/subagents" && method === "GET") {
        void (async () => {
          try {
            const { getSubagentRegistry } = await import("./subagent-registry.js");
            const reg = getSubagentRegistry();
            const all = reg ? Array.from((reg as unknown as { records: Map<string, unknown> }).records.values()) : [];
            const subagents = (all as Array<Record<string, unknown>>).map(r => ({
              runId: r["runId"], label: r["label"], status: r["status"],
              turns: r["turns"], createdAt: r["createdAt"],
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

      // GET /api/config
      if (url === "/api/config" && method === "GET") {
        void (async () => {
          try {
            const { resolveConfigPath } = await import("./config.js");
            const raw = JSON.parse(readFileSync(resolveConfigPath(), "utf-8")) as unknown;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(maskConfig(raw), null, 2));
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
              const discord = parsed?.discord as Record<string, unknown> | undefined;
              if (!discord?.token) throw new Error("缺少必要欄位 discord.token");
              const { resolveConfigPath } = await import("./config.js");
              const cp = resolveConfigPath();
              backupConfig(cp);
              const tmp = cp + ".tmp";
              writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf-8");
              renameSync(tmp, cp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      res.writeHead(404); res.end("Not found");
    });

    server.listen(this.port, "127.0.0.1", () => {
      log.info(`[dashboard] 啟動 http://127.0.0.1:${this.port}`);
    });

    server.on("error", (err) => {
      log.warn(`[dashboard] HTTP 錯誤：${err.message}`);
    });
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _dashboard: DashboardServer | null = null;

export function initDashboard(port = 8088): DashboardServer {
  _dashboard = new DashboardServer(port);
  _dashboard.start();
  return _dashboard;
}

export function getDashboard(): DashboardServer | null {
  return _dashboard;
}
