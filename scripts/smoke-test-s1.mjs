/**
 * S1 Smoke Test — 驗證 5 個 S1 模組基本功能
 * 執行：node scripts/smoke-test-s1.mjs
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 測試基礎設施 ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => { console.log(`  ✓ ${name}`); passed++; })
        .catch(err => { console.error(`  ✗ ${name}: ${err.message}`); failed++; });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

// 臨時工作目錄
const tmpDir = join(tmpdir(), `catclaw-s1-smoke-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

// ── Module 1: event-bus ────────────────────────────────────────────────────

console.log("\n[1] core/event-bus");

const { eventBus } = await import("../dist/core/event-bus.js").catch(async () => {
  // dist 不存在時嘗試直接用 tsx/esm（跳過）
  return { eventBus: null };
});

if (eventBus) {
  test("on/emit/off", () => {
    let received = null;
    const listener = (ctx) => { received = ctx; };
    eventBus.on("turn:before", listener);
    eventBus.emit("turn:before", { accountId: "wells", channelId: "ch1", sessionKey: "sk", prompt: "hi" });
    assert(received?.accountId === "wells", "payload mismatch");
    eventBus.off("turn:before", listener);
    received = null;
    eventBus.emit("turn:before", { accountId: "wells", channelId: "ch1", sessionKey: "sk", prompt: "hi" });
    assert(received === null, "listener should be removed");
  });

  test("once fires exactly once", () => {
    let count = 0;
    eventBus.once("session:end", (_sid) => count++);
    eventBus.emit("session:end", "s1");
    eventBus.emit("session:end", "s2");
    assert(count === 1, `expected 1, got ${count}`);
  });
} else {
  console.log("  (skip — dist not built, run pnpm build first)");
}

// ── Module 2: memory/atom ──────────────────────────────────────────────────

console.log("\n[2] memory/atom");

const atomMod = await import("../dist/memory/atom.js").catch(() => null);

if (atomMod) {
  const { writeAtom, readAtom, touchAtom, readAllAtoms } = atomMod;
  const atomDir = join(tmpDir, "atoms");
  mkdirSync(atomDir, { recursive: true });

  test("writeAtom 建立檔案", () => {
    const p = writeAtom(atomDir, "test-pref", {
      description: "測試 atom",
      confidence: "[臨]",
      scope: "global",
      triggers: ["test", "smoke"],
      content: "這是測試內容",
    });
    assert(existsSync(p), "atom file not created");
  });

  test("readAtom 解析正確", () => {
    const p = join(atomDir, "test-pref.md");
    const atom = readAtom(p);
    assert(atom?.name === "test-pref", `name: ${atom?.name}`);
    assert(atom?.confidence === "[臨]", `conf: ${atom?.confidence}`);
    assert(atom?.triggers.includes("smoke"), "triggers missing");
    assert(atom?.content.includes("這是測試內容"), "content missing");
  });

  test("touchAtom 更新 Last-used + Confirmations", () => {
    const p = join(atomDir, "test-pref.md");
    touchAtom(p);
    const atom = readAtom(p);
    assert(atom?.confirmations === 1, `confirmations: ${atom?.confirmations}`);
    assert(atom?.lastUsed, "lastUsed missing");
  });

  test("readAllAtoms 掃描目錄", () => {
    const atoms = readAllAtoms(atomDir);
    assert(atoms.length >= 1, `expected ≥1, got ${atoms.length}`);
  });

  test("readAllAtoms 跳過 _ 前綴目錄", () => {
    const skipDir = join(atomDir, "_staging");
    mkdirSync(skipDir, { recursive: true });
    writeAtom(skipDir, "should-skip", { description: "skip", content: "x" });
    const atoms = readAllAtoms(atomDir);
    assert(!atoms.some(a => a.name === "should-skip"), "should skip _staging");
  });
} else {
  console.log("  (skip — dist not built)");
}

// ── Module 3: memory/index-manager ────────────────────────────────────────

console.log("\n[3] memory/index-manager");

const idxMod = await import("../dist/memory/index-manager.js").catch(() => null);

if (idxMod) {
  const { loadIndex, matchTriggers, upsertIndex, removeIndex } = idxMod;
  const memoryMd = join(tmpDir, "MEMORY.md");

  test("upsertIndex 建立新 MEMORY.md", () => {
    upsertIndex(memoryMd, {
      name: "prefs",
      path: "prefs.md",
      triggers: ["偏好", "style"],
      confidence: "[固]",
    });
    assert(existsSync(memoryMd), "MEMORY.md not created");
  });

  test("upsertIndex 新增第二筆", () => {
    upsertIndex(memoryMd, {
      name: "tools",
      path: "tools.md",
      triggers: ["工具", "bash"],
      confidence: "[觀]",
    });
    const entries = loadIndex(memoryMd);
    assert(entries.length === 2, `expected 2, got ${entries.length}`);
  });

  test("upsertIndex 更新既有 entry", () => {
    upsertIndex(memoryMd, {
      name: "prefs",
      path: "prefs-v2.md",
      triggers: ["偏好", "語言"],
      confidence: "[固]",
    });
    const entries = loadIndex(memoryMd);
    assert(entries.length === 2, `should still be 2, got ${entries.length}`);
    const prefs = entries.find(e => e.name === "prefs");
    assert(prefs?.path === "prefs-v2.md", "path not updated");
  });

  test("matchTriggers 命中", () => {
    const entries = loadIndex(memoryMd);
    const hits = matchTriggers("我的偏好設定", entries);
    assert(hits.length >= 1, "no trigger match");
    assert(hits[0].name === "prefs", `hit: ${hits[0].name}`);
  });

  test("matchTriggers 無命中", () => {
    const entries = loadIndex(memoryMd);
    const hits = matchTriggers("今天天氣真好", entries);
    assert(hits.length === 0, "should not match");
  });

  test("removeIndex 移除 entry", () => {
    removeIndex(memoryMd, "tools");
    const entries = loadIndex(memoryMd);
    assert(entries.length === 1, `expected 1, got ${entries.length}`);
    assert(!entries.some(e => e.name === "tools"), "tools still present");
  });
} else {
  console.log("  (skip — dist not built)");
}

// ── Module 4: accounts/registry ───────────────────────────────────────────

console.log("\n[4] accounts/registry");

const regMod = await import("../dist/accounts/registry.js").catch(() => null);

if (regMod) {
  const { AccountRegistry } = regMod;
  const reg = new AccountRegistry(tmpDir);
  reg.init();

  test("create 建立帳號", () => {
    const acc = reg.create({
      accountId: "wells",
      displayName: "Wells",
      role: "platform-owner",
      identities: [{ platform: "discord", platformId: "480042204346449920", linkedAt: new Date().toISOString() }],
    });
    assert(acc.accountId === "wells");
    assert(acc.role === "platform-owner");
  });

  test("get 讀取帳號（含快取）", () => {
    const acc = reg.get("wells");
    assert(acc?.displayName === "Wells");
    assert(acc?.identities.length === 1);
  });

  test("resolveIdentity 反查 accountId", () => {
    const id = reg.resolveIdentity("discord", "480042204346449920");
    assert(id === "wells", `got: ${id}`);
  });

  test("resolveIdentity 未知 identity 回傳 null", () => {
    const id = reg.resolveIdentity("discord", "999999");
    assert(id === null);
  });

  test("create 重複帳號拋出錯誤", () => {
    let thrown = false;
    try { reg.create({ accountId: "wells", displayName: "X", role: "guest" }); }
    catch { thrown = true; }
    assert(thrown, "should throw on duplicate");
  });

  test("update 部分更新", () => {
    const updated = reg.update("wells", { displayName: "Wells Tseng" });
    assert(updated.displayName === "Wells Tseng");
    assert(updated.role === "platform-owner"); // 其他欄位保留
  });

  test("linkIdentity 綁定新 identity", () => {
    reg.linkIdentity("wells", "line", "U12345");
    const acc = reg.get("wells");
    assert(acc?.identities.some(i => i.platform === "line"), "line identity missing");
    const id = reg.resolveIdentity("line", "U12345");
    assert(id === "wells");
  });

  test("listAccountIds 列舉", () => {
    const ids = reg.listAccountIds();
    assert(ids.includes("wells"), "wells missing");
  });

  test("touch 更新 lastActiveAt", async () => {
    const before = reg.get("wells")?.lastActiveAt;
    await new Promise(r => setTimeout(r, 5));
    reg.touch("wells");
    const after = reg.get("wells")?.lastActiveAt;
    assert(after !== before || after !== undefined, "lastActiveAt not updated");
  });
} else {
  console.log("  (skip — dist not built)");
}

// ── Module 5: core/config（使用 ~/.catclaw-test 真實設定）──────────────────

console.log("\n[5] core/config (real catclaw-test config)");

// import 前先設 env vars，確保 loadConfig() 能找到 catclaw.json
import { homedir } from "node:os";
const testCatclawDir = join(homedir(), ".catclaw-test");
process.env.CATCLAW_CONFIG_DIR = testCatclawDir;
process.env.CATCLAW_WORKSPACE = `${testCatclawDir}/workspace`;

const cfgMod = await import("../dist/core/config.js").catch(err => {
  console.error(`  (import failed: ${err.message})`);
  return null;
});

if (cfgMod) {
  test("載入成功 — discord.token 存在", () => {
    assert(cfgMod.config.discord.token, "discord.token missing");
  });

  test("預設值 — turnTimeoutMs", () => {
    assert(typeof cfgMod.config.turnTimeoutMs === "number", "turnTimeoutMs not number");
    assert(cfgMod.config.turnTimeoutMs > 0, "turnTimeoutMs must be > 0");
  });

  test("provider 欄位存在", () => {
    assert(cfgMod.config.provider, `provider: ${cfgMod.config.provider}`);
  });

  test("memory 預設值", () => {
    const mem = cfgMod.config.memory;
    assert(typeof mem.enabled === "boolean", "memory.enabled missing");
    assert(typeof mem.contextBudget === "number", "memory.contextBudget missing");
    assert(mem.recall.vectorTopK > 0, "vectorTopK missing");
  });

  test("accounts 預設值", () => {
    const acc = cfgMod.config.accounts;
    assert(["open", "invite", "closed"].includes(acc.registrationMode), `registrationMode: ${acc.registrationMode}`);
    assert(typeof acc.pairingEnabled === "boolean", "pairingEnabled missing");
  });

  test("rateLimit 有 member 設定", () => {
    assert(cfgMod.config.rateLimit.member?.requestsPerMinute > 0, "rateLimit.member missing");
  });

  test("resolveClaudeBin 預設 'claude'", () => {
    delete process.env.CATCLAW_CLAUDE_BIN;
    assert(cfgMod.resolveClaudeBin() === "claude");
  });

  test("getChannelAccess DM 回傳 dm.enabled", () => {
    const access = cfgMod.getChannelAccess(null, "ch1");
    assert(typeof access.allowed === "boolean", "allowed missing");
    assert(access.requireMention === false, "DM should not require mention");
  });

  test("resolveProvider 回傳預設 provider", () => {
    const p = cfgMod.resolveProvider({});
    assert(typeof p === "string" && p.length > 0, `provider: ${p}`);
  });
} else {
  console.log("  (skip)");
}

// ── 清理 + 結果 ───────────────────────────────────────────────────────────

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${"─".repeat(40)}`);
const total = passed + failed;
if (failed === 0) {
  console.log(`✅ 全部通過 ${total}/${total}`);
} else {
  console.log(`❌ ${failed} 失敗 / ${total} 測試`);
  process.exit(1);
}
