/**
 * Agent Persona System — E2E 測試腳本
 *
 * 執行：CATCLAW_CONFIG_DIR=~/.catclaw CATCLAW_WORKSPACE=~/.catclaw/workspace node tests/agent-persona-e2e.mjs
 */

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// ── ENV setup ─────────────────────────────────────────────────────────────────
process.env.CATCLAW_CONFIG_DIR ??= resolve(homedir(), ".catclaw");
process.env.CATCLAW_WORKSPACE ??= resolve(homedir(), ".catclaw", "workspace");

const CATCLAW_DIR = process.env.CATCLAW_CONFIG_DIR;
const AGENT_ID = "stock-analyst";
const AGENT_DIR = join(CATCLAW_DIR, "agents", AGENT_ID);

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  ⏭️  ${name} — ${reason}`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── T1: Persona 核心 ─────────────────────────────────────────────────────────

console.log("\n═══ T1: Persona 核心（config + spawn + session + 權限）═══");

// T1.1 Config 載入
const { loadAgentConfig, loadAgentPrompt, resolveAgentDataDir } = await import("../dist/core/agent-loader.js");

test("T1.1.1 resolveAgentDataDir 回傳正確路徑", () => {
  const dir = resolveAgentDataDir(AGENT_ID);
  assert(dir.endsWith(`/agents/${AGENT_ID}`), `路徑不對：${dir}`);
});

test("T1.1.2 loadAgentConfig 載入 stock-analyst config.json", () => {
  const cfg = loadAgentConfig(AGENT_ID);
  assert(cfg, "config 不應為 undefined");
  assertEqual(cfg.label, "股票分析師", "label");
  assertEqual(cfg.model, "sonnet", "model");
  assertEqual(cfg.admin, false, "admin");
  assertEqual(cfg.maxTurns, 10, "maxTurns");
});

test("T1.1.3 loadAgentPrompt 載入 CATCLAW.md", () => {
  const prompt = loadAgentPrompt(AGENT_ID);
  assert(prompt, "prompt 不應為 undefined");
  assert(prompt.includes("買/賣/觀望"), "CATCLAW.md 內容不對");
});

test("T1.1.4 不存在的 agent → loadAgentConfig 回傳 undefined", () => {
  const cfg = loadAgentConfig("nonexistent-agent-xyz");
  assertEqual(cfg, undefined, "應回傳 undefined");
});

test("T1.1.5 不存在的 agent → loadAgentPrompt 回傳 undefined", () => {
  const prompt = loadAgentPrompt("nonexistent-agent-xyz");
  assertEqual(prompt, undefined, "應回傳 undefined");
});

// T1.3 安全邊界
console.log("\n═══ T1.3: 安全邊界（agent write path）═══");

const { SafetyGuard } = await import("../dist/safety/guard.js");
const guard = new SafetyGuard({ patterns: [] });

test("T1.3.1 agent 寫入自己的 memory/ → 允許", () => {
  const result = guard.checkAgentWritePath(
    join(AGENT_DIR, "memory", "test.md"),
    AGENT_ID
  );
  assertEqual(result.blocked, false, "不應被擋");
});

test("T1.3.2 agent 寫入自己的 skills/ → 允許", () => {
  const result = guard.checkAgentWritePath(
    join(AGENT_DIR, "skills", "new-skill.md"),
    AGENT_ID
  );
  assertEqual(result.blocked, false, "不應被擋");
});

test("T1.3.3 agent 寫入 catclaw.json → 擋下", () => {
  const result = guard.checkAgentWritePath(
    join(CATCLAW_DIR, "catclaw.json"),
    AGENT_ID
  );
  assertEqual(result.blocked, true, "應被擋下");
});

test("T1.3.4 agent 寫入其他 agent 目錄 → 擋下", () => {
  const result = guard.checkAgentWritePath(
    join(CATCLAW_DIR, "agents", "default", "config.json"),
    AGENT_ID
  );
  assertEqual(result.blocked, true, "應被擋下");
});

test("T1.3.5 agent 寫入 workspace → 擋下", () => {
  const result = guard.checkAgentWritePath(
    resolve(homedir(), ".catclaw", "workspace", "test.txt"),
    AGENT_ID
  );
  assertEqual(result.blocked, true, "應被擋下");
});

// ── T3: 目錄自動建立 ─────────────────────────────────────────────────────────

console.log("\n═══ T3: 目錄自動建立 ═══");

test("T3.1 刪除後 mkdirSync 可重建 memory/", () => {
  const testMemDir = join(AGENT_DIR, "memory", "_test_probe");
  mkdirSync(testMemDir, { recursive: true });
  assert(existsSync(testMemDir), "目錄應存在");
  rmSync(testMemDir, { recursive: true });
  assert(!existsSync(testMemDir), "目錄應已刪除");
  // 模擬 spawn-subagent.ts 的行為
  mkdirSync(testMemDir, { recursive: true });
  assert(existsSync(testMemDir), "重建後應存在");
  rmSync(testMemDir, { recursive: true });
});

test("T3.2 skills/ 目錄存在", () => {
  assert(existsSync(join(AGENT_DIR, "skills")), "skills/ 應存在");
});

// ── T4: Persona Skills ───────────────────────────────────────────────────────

console.log("\n═══ T4: Persona Skills ═══");

const { loadAgentSkills, buildSkillsPrompt, buildSkillCreationHint } = await import("../dist/core/agent-skill-loader.js");

test("T4.1 loadAgentSkills 載入 stock-analysis skill", () => {
  const skills = loadAgentSkills(AGENT_ID);
  assertEqual(skills.length, 1, "應有 1 個 skill");
  assertEqual(skills[0].name, "stock-analysis", "skill name");
  assertEqual(skills[0].description, "台股技術分析", "skill description");
  assertEqual(skills[0].userInvocable, true, "userInvocable");
  assert(skills[0].body.includes("搜尋該股票基本資料"), "skill body 內容");
});

test("T4.2 buildSkillsPrompt 產生正確 prompt", () => {
  const skills = loadAgentSkills(AGENT_ID);
  const prompt = buildSkillsPrompt(skills);
  assert(prompt.includes("# Agent Skills"), "應有 Agent Skills 標題");
  assert(prompt.includes("stock-analysis"), "應包含 skill name");
  assert(prompt.includes("台股技術分析"), "應包含 description");
});

test("T4.3 空 skills → buildSkillsPrompt 回傳空字串", () => {
  const prompt = buildSkillsPrompt([]);
  assertEqual(prompt, "", "應為空字串");
});

test("T4.4 config.json skills filter 只載入指定的", () => {
  // 建立第二個 skill
  const skillPath = join(AGENT_DIR, "skills", "risk-assessment.md");
  writeFileSync(skillPath, "---\nname: risk-assessment\ndescription: 風險評估\n---\n\n# 風險評估\n\n評估投資風險。\n");

  const all = loadAgentSkills(AGENT_ID);
  assertEqual(all.length, 2, "應有 2 個 skill");

  const filtered = loadAgentSkills(AGENT_ID, ["stock-analysis"]);
  assertEqual(filtered.length, 1, "filter 後應只有 1 個");
  assertEqual(filtered[0].name, "stock-analysis", "應為 stock-analysis");

  // 清理
  rmSync(skillPath);
});

// ── T5: AI 自建 Skill ────────────────────────────────────────────────────────

console.log("\n═══ T5: AI 自建 Skill ═══");

test("T5.1 buildSkillCreationHint 包含正確路徑", () => {
  const hint = buildSkillCreationHint(AGENT_ID);
  assert(hint.includes("Skill 自建能力"), "應有標題");
  assert(hint.includes(`agents/${AGENT_ID}/skills/`), "應包含 skills 路徑");
  assert(hint.includes("write_file"), "應提到 write_file");
});

test("T5.2 AI 自建 skill → 下次 loadAgentSkills 可載入", () => {
  const skillPath = join(AGENT_DIR, "skills", "dividend-tracker.md");
  // 模擬 AI 用 write_file 建立
  writeFileSync(skillPath, "---\nname: dividend-tracker\ndescription: 股息追蹤\nuserInvocable: true\n---\n\n# 股息追蹤\n\n追蹤股息發放日期和殖利率。\n");

  const skills = loadAgentSkills(AGENT_ID);
  const found = skills.find(s => s.name === "dividend-tracker");
  assert(found, "應能找到新建的 skill");
  assertEqual(found.description, "股息追蹤", "description");
  assert(found.body.includes("殖利率"), "body 內容");

  // 清理
  rmSync(skillPath);
});

// ── T6: Dashboard Trace agentId ──────────────────────────────────────────────

console.log("\n═══ T6: MessageTrace agentId ═══");

const { MessageTrace } = await import("../dist/core/message-trace.js");

test("T6.1 MessageTrace.create → setAgentId → entry 有 agentId", () => {
  const trace = MessageTrace.create("test-turn-id", "test-channel", "test-account");
  trace.setAgentId(AGENT_ID);
  trace.recordInbound({ text: "test", attachments: 0 });
  trace.recordResponse("ok", 100);
  const entry = trace.finalize();
  assertEqual(entry.agentId, AGENT_ID, "agentId");
});

test("T6.2 不設 agentId → entry.agentId 為 undefined", () => {
  const trace = MessageTrace.create("test-turn-id-2", "test-channel", "test-account");
  trace.recordInbound({ text: "test", attachments: 0 });
  trace.recordResponse("ok", 100);
  const entry = trace.finalize();
  assertEqual(entry.agentId, undefined, "agentId 應為 undefined");
});

// ── T6: Dashboard API（需 CatClaw 在線）──────────────────────────────────────

console.log("\n═══ T6: Dashboard API（需 CatClaw 在線）═══");

async function fetchJSON(path) {
  try {
    const res = await fetch(`http://localhost:8088${path}`);
    return await res.json();
  } catch { return null; }
}

const apiStatus = await fetchJSON("/api/status");
if (apiStatus) {
  test("T6.3 /api/subagents 回傳格式正確", async () => {
    const data = await fetchJSON("/api/subagents");
    assert(Array.isArray(data), "應回傳 array");
    // 檢查 schema（可能為空，但格式正確就好）
  });

  test("T6.4 /api/traces 回傳格式正確", async () => {
    const data = await fetchJSON("/api/traces?limit=5");
    assert(Array.isArray(data), "應回傳 array");
  });
} else {
  skip("T6.3 /api/subagents", "Dashboard 未啟動");
  skip("T6.4 /api/traces", "Dashboard 未啟動");
}

// ── T8: 邊界與異常 ───────────────────────────────────────────────────────────

console.log("\n═══ T8: 邊界與異常 ═══");

test("T8.1 不存在的 agent → loadAgentConfig 優雅回傳 undefined", () => {
  const cfg = loadAgentConfig("__totally_fake_agent__");
  assertEqual(cfg, undefined, "應為 undefined");
});

test("T8.2 不存在的 agent → loadAgentSkills 回傳空陣列", () => {
  const skills = loadAgentSkills("__totally_fake_agent__");
  assertEqual(skills.length, 0, "應為空陣列");
});

test("T8.3 壞 JSON config → loadAgentConfig 回傳 undefined", () => {
  const fakeDir = join(CATCLAW_DIR, "agents", "__bad_json_test__");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "config.json"), "{ this is not json }}}");

  const cfg = loadAgentConfig("__bad_json_test__");
  assertEqual(cfg, undefined, "壞 JSON 應回傳 undefined");

  rmSync(fakeDir, { recursive: true });
});

test("T8.4 skills/ 下非 .md 檔案 → 被忽略", () => {
  writeFileSync(join(AGENT_DIR, "skills", "notes.txt"), "not a skill");
  writeFileSync(join(AGENT_DIR, "skills", "data.json"), "{}");

  const skills = loadAgentSkills(AGENT_ID);
  assert(skills.every(s => s.filePath.endsWith(".md")), "應只載入 .md 檔案");

  rmSync(join(AGENT_DIR, "skills", "notes.txt"));
  rmSync(join(AGENT_DIR, "skills", "data.json"));
});

test("T8.5 skill .md 無 frontmatter → 用檔名當 name", () => {
  const skillPath = join(AGENT_DIR, "skills", "plain-skill.md");
  writeFileSync(skillPath, "# 純文字 Skill\n\n沒有 frontmatter 的 skill。\n");

  const skills = loadAgentSkills(AGENT_ID);
  const found = skills.find(s => s.name === "plain-skill");
  assert(found, "應能載入，name = 檔名");

  rmSync(skillPath);
});

test("T8.6 guard 對 path traversal 攻擊擋下", () => {
  const result = guard.checkAgentWritePath(
    join(AGENT_DIR, "..", "default", "config.json"),
    AGENT_ID
  );
  assertEqual(result.blocked, true, "path traversal 應被擋");
});

// ── T7: 向後相容 ─────────────────────────────────────────────────────────────

console.log("\n═══ T7: 向後相容 ═══");

test("T7.1 loadAgentConfig(undefined ID) 不 crash", () => {
  // 模擬不帶 agent 的 spawn
  const cfg = loadAgentConfig("__no_persona__");
  assertEqual(cfg, undefined, "不帶 persona → undefined");
});

test("T7.2 loadAgentSkills 空 filter → 載入全部", () => {
  const skills = loadAgentSkills(AGENT_ID, null);
  assert(skills.length >= 1, "null filter → 全部載入");
});

test("T7.3 loadAgentSkills 空陣列 filter → 載入全部", () => {
  const skills = loadAgentSkills(AGENT_ID, []);
  assert(skills.length >= 1, "空陣列 filter → 全部載入");
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`結果：✅ ${passed} passed / ❌ ${failed} failed / ⏭️  ${skipped} skipped`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
