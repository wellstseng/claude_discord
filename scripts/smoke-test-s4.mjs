/**
 * S4 Smoke Test — Provider Layer + Session Manager
 * 執行：node scripts/smoke-test-s4.mjs
 *
 * claude-api 端到端測試需要 ANTHROPIC_TOKEN 環境變數
 * 若未設定則 skip（不 fail）
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

let passed = 0, failed = 0, skipped = 0;
const _queue = [];

function test(name, fn) { _queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      const r = await fn();
      if (r === "skip") { console.log(`  ⊘ ${name} (skip)`); skipped++; }
      else { console.log(`  ✓ ${name}`); passed++; }
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

const tmpDir = join(tmpdir(), `catclaw-s4-smoke-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

const testCatclawDir = join(homedir(), ".catclaw-test");
process.env.CATCLAW_CONFIG_DIR = testCatclawDir;
process.env.CATCLAW_WORKSPACE  = join(testCatclawDir, "workspace");

const { config: testConfig } = await import("../dist/core/config.js");

const apiKey = process.env.ANTHROPIC_TOKEN ?? testConfig.providers?.["claude-api"]?.token;
const hasApiKey = Boolean(apiKey);
console.log(`   ANTHROPIC_TOKEN: ${hasApiKey ? "✓ 設定" : "✗ 未設定（E2E 測試將 skip）"}`);

// ── Module 1: providers/base ──────────────────────────────────────────────────

console.log("\n[1] providers/base");

const { extractText, makeToolResultMessage } = await import("../dist/providers/base.js");

test("extractText 純字串", () => {
  const text = extractText("hello world");
  assert(text === "hello world");
});

test("extractText content blocks", () => {
  const blocks = [
    { type: "text", text: "hello " },
    { type: "tool_use", id: "t1", name: "bash", input: {} },
    { type: "text", text: "world" },
  ];
  const text = extractText(blocks);
  assert(text === "hello world", `got: ${text}`);
});

test("makeToolResultMessage 格式正確", () => {
  const msg = makeToolResultMessage([
    { tool_use_id: "t1", content: "result text", is_error: false },
  ]);
  assert(msg.role === "user");
  assert(Array.isArray(msg.content));
  assert(msg.content[0].type === "tool_result");
  assert(msg.content[0].tool_use_id === "t1");
});

// ── Module 2: providers/registry ─────────────────────────────────────────────

console.log("\n[2] providers/registry");

const {
  ProviderRegistry,
  buildProviderRegistry,
  initProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
} = await import("../dist/providers/registry.js");

test("ProviderRegistry 基本 register + get", () => {
  const registry = new ProviderRegistry("mock-provider", {});
  const mockProvider = {
    id: "mock-provider",
    name: "Mock",
    supportsToolUse: true,
    maxContextTokens: 100000,
    async stream() { return { events: (async function*(){})(), stopReason: "end_turn", toolCalls: [], text: "" }; },
  };
  registry.register(mockProvider);
  assert(registry.get("mock-provider") === mockProvider);
  assert(registry.list().length === 1);
});

test("ProviderRegistry resolve 路由優先序", () => {
  const registry = new ProviderRegistry("default-p", {
    channels: { "ch-001": "channel-p" },
    projects: { "proj-001": "project-p" },
    roles: { "admin": "admin-p" },
  });

  // 建立 mock providers
  for (const id of ["default-p", "channel-p", "project-p", "admin-p"]) {
    registry.register({
      id, name: id, supportsToolUse: true, maxContextTokens: 100000,
      async stream() { return { events: (async function*(){})(), stopReason: "end_turn", toolCalls: [], text: "" }; },
    });
  }

  // 頻道 > 專案 > 角色 > 全域
  assert(registry.resolve({ channelId: "ch-001", projectId: "proj-001" }).id === "channel-p");
  assert(registry.resolve({ projectId: "proj-001", role: "admin" }).id === "project-p");
  assert(registry.resolve({ role: "admin" }).id === "admin-p");
  assert(registry.resolve({}).id === "default-p");
});

test("ProviderRegistry resolve 找不到 provider 拋出", () => {
  const registry = new ProviderRegistry("nonexistent", {});
  let thrown = false;
  try { registry.resolve({}); } catch { thrown = true; }
  assert(thrown, "應拋出錯誤");
});

test("buildProviderRegistry 從 config 建立（claude-api）", async () => {
  resetProviderRegistry();
  const entries = {
    "claude-api": {
      apiKey: apiKey ?? "sk-test-placeholder",
      model: "claude-haiku-4-5-20251001",
    },
  };
  const registry = await buildProviderRegistry("claude-api", entries, {});
  assert(registry.get("claude-api") !== undefined, "應有 claude-api provider");
  const p = registry.get("claude-api");
  assert(p.id === "claude-api");
  assert(p.supportsToolUse === true);
});

test("initProviderRegistry / getProviderRegistry singleton", async () => {
  resetProviderRegistry();
  const registry = new ProviderRegistry("test", {});
  registry.register({
    id: "test", name: "Test", supportsToolUse: false, maxContextTokens: 1000,
    async stream() { return { events: (async function*(){})(), stopReason: "end_turn", toolCalls: [], text: "" }; },
  });
  initProviderRegistry(registry);
  assert(getProviderRegistry() === registry);
  resetProviderRegistry();
  let thrown = false;
  try { getProviderRegistry(); } catch { thrown = true; }
  assert(thrown, "reset 後應拋出");
});

// ── Module 3: providers/claude-api ───────────────────────────────────────────

console.log("\n[3] providers/claude-api");

const { ClaudeApiProvider, collectStreamText } = await import("../dist/providers/claude-api.js");

test("ClaudeApiProvider 建構（無 apiKey → 警告但不拋出）", () => {
  const p = new ClaudeApiProvider("test-api", {});
  assert(p.id === "test-api");
  assert(p.supportsToolUse === true);
  assert(p.maxContextTokens === 200000);
});

test("ClaudeApiProvider stream 無 apiKey 拋出", async () => {
  const p = new ClaudeApiProvider("no-auth", {});
  let thrown = false;
  try {
    await p.stream([{ role: "user", content: "test" }]);
  } catch (err) {
    thrown = true;
    assert(err.message.includes("apiKey"), `錯誤訊息應提及 apiKey，got: ${err.message}`);
  }
  assert(thrown, "應拋出認證錯誤");
});

test("ClaudeApiProvider E2E（需 ANTHROPIC_TOKEN）", async () => {
  if (!hasApiKey) return "skip";
  const p = new ClaudeApiProvider("claude-api", { apiKey, model: "claude-haiku-4-5-20251001" });
  const result = await p.stream(
    [{ role: "user", content: "Say exactly: PONG" }],
    { maxTokens: 50, systemPrompt: "Reply with one word only." }
  );
  assert(result.stopReason === "end_turn", `expected end_turn, got ${result.stopReason}`);
  const text = await collectStreamText(result);
  assert(text.length > 0, "應有回應文字");
  console.log(`      → "${text.trim()}"`);
});

test("collectStreamText 從 events 收集文字", async () => {
  async function* fakeEvents() {
    yield { type: "text_delta", text: "hello " };
    yield { type: "text_delta", text: "world" };
    yield { type: "done", stopReason: "end_turn", text: "hello world" };
  }
  const fakeResult = {
    events: fakeEvents(),
    stopReason: "end_turn",
    toolCalls: [],
    text: "hello world",
  };
  const text = await collectStreamText(fakeResult);
  assert(text === "hello world", `got: "${text}"`);
});

// ── Module 4: core/session ────────────────────────────────────────────────────

console.log("\n[4] core/session");

const {
  SessionManager,
  makeSessionKey,
  initSessionManager,
  getSessionManager,
  resetSessionManager,
} = await import("../dist/core/session.js");

const sessionPersistDir = join(tmpDir, "sessions");
const sessionCfg = {
  ttlHours: 168,
  maxHistoryTurns: 50,
  compactAfterTurns: 30,
  persistPath: sessionPersistDir,
};

test("makeSessionKey 格式", () => {
  assert(makeSessionKey("ch-123", "acc-456", false) === "ch:ch-123", "群組頻道");
  assert(makeSessionKey("dm-123", "acc-456", true) === "dm:acc-456:dm-123", "DM");
});

test("SessionManager init() + getOrCreate", async () => {
  resetSessionManager();
  const mgr = initSessionManager(sessionCfg);
  await mgr.init();
  const session = mgr.getOrCreate("ch:ch-001", "acc-001", "ch-001", "claude-api");
  assert(session.sessionKey === "ch:ch-001");
  assert(session.accountId === "acc-001");
  assert(session.messages.length === 0);
});

test("SessionManager addMessages + getHistory", async () => {
  const mgr = getSessionManager();
  mgr.addMessages("ch:ch-001", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  const history = mgr.getHistory("ch:ch-001");
  assert(history.length === 2);
  assert(history[0].role === "user");
  assert(history[1].role === "assistant");
});

test("SessionManager addMessages compact（超過 maxHistoryTurns）", async () => {
  const compactCfg = { ...sessionCfg, maxHistoryTurns: 3 };
  const mgr = new SessionManager(compactCfg);
  await mgr.init();
  const session = mgr.getOrCreate("ch:compact-test", "acc-001", "compact-test", "claude-api");

  // 加入 10 對話（超過 3 turns = 6 messages）
  for (let i = 0; i < 10; i++) {
    mgr.addMessages("ch:compact-test", [
      { role: "user", content: `msg ${i}` },
      { role: "assistant", content: `reply ${i}` },
    ]);
  }
  const history = mgr.getHistory("ch:compact-test");
  assert(history.length <= 6, `compact 後應 ≤ 6 messages，got ${history.length}`);
});

test("SessionManager turn queue FIFO + depth limit", async () => {
  const mgr = getSessionManager();
  const sk = "ch:queue-test";

  // 建立 session
  mgr.getOrCreate(sk, "acc-001", "queue-test", "claude-api");

  // 第一個 turn 立即 resolve
  const p1 = mgr.enqueueTurn({ sessionKey: sk, accountId: "acc-001", prompt: "msg1" });
  await p1;  // 應立即解決

  // dequeue（模擬 turn 完成）
  mgr.dequeueTurn(sk);

  // 超過 depth 拋出
  let rejectedCount = 0;
  const promises = [];
  // 塞滿佇列（加入 5 個，depth=5，第 6 個應被拒）
  // 先佔一個（不 dequeue）
  promises.push(mgr.enqueueTurn({ sessionKey: sk, accountId: "acc-001", prompt: "q0" }));
  for (let i = 1; i <= 5; i++) {
    promises.push(
      mgr.enqueueTurn({ sessionKey: sk, accountId: "acc-001", prompt: `q${i}` })
        .catch(() => { rejectedCount++; })
    );
  }

  // 等所有 promise settled（有些可能 timeout，但第 6 個應立即 reject）
  // 只等 reject 的
  await Promise.race([
    Promise.resolve(rejectedCount > 0),
    new Promise(r => setTimeout(r, 500)), // 500ms 內應看到 reject
  ]);

  assert(rejectedCount >= 1, `至少一個應因超過 depth 被 reject，got ${rejectedCount}`);

  // 清理 queue（dequeue 所有）
  for (let i = 0; i < 6; i++) mgr.dequeueTurn(sk);
});

test("SessionManager persist + reload", async () => {
  const mgr = getSessionManager();
  const sk = "ch:persist-test";
  const session = mgr.getOrCreate(sk, "acc-persist", "persist-test", "claude-api");
  mgr.addMessages(sk, [{ role: "user", content: "persisted message" }]);

  // 建立新 manager 重新載入
  const mgr2 = new SessionManager(sessionCfg);
  await mgr2.init();
  const reloaded = mgr2.get(sk);
  assert(reloaded !== undefined, "session 應被重新載入");
  assert(reloaded.accountId === "acc-persist");
  assert(reloaded.messages.some(m => typeof m.content === "string" && m.content.includes("persisted")));
});

test("SessionManager delete", async () => {
  const mgr = getSessionManager();
  mgr.getOrCreate("ch:delete-test", "acc-001", "delete-test", "claude-api");
  mgr.delete("ch:delete-test");
  assert(mgr.get("ch:delete-test") === undefined, "刪除後應找不到");
});

test("initSessionManager / getSessionManager singleton", async () => {
  resetSessionManager();
  let thrown = false;
  try { getSessionManager(); } catch { thrown = true; }
  assert(thrown, "reset 後應拋出");

  const mgr = initSessionManager(sessionCfg);
  await mgr.init();
  assert(getSessionManager() === mgr);
});

// ── 整合：provider + session 協同 ────────────────────────────────────────────

console.log("\n[5] 整合（provider + session + API call）");

test("Provider + Session E2E（需 ANTHROPIC_TOKEN）", async () => {
  if (!hasApiKey) return "skip";

  // 1. 建立 session
  const mgr = getSessionManager();
  const sk = makeSessionKey("e2e-ch", "e2e-acc", false);
  const session = mgr.getOrCreate(sk, "e2e-acc", "e2e-ch", "claude-api");

  // 2. 準備 provider
  const p = new ClaudeApiProvider("claude-api", { apiKey, model: "claude-haiku-4-5-20251001" });

  // 3. 排入 turn queue
  await mgr.enqueueTurn({ sessionKey: sk, accountId: "e2e-acc", prompt: "Say: HELLO" });

  try {
    // 4. 取得 history + 送出
    const history = mgr.getHistory(sk);
    const messages = [
      ...history,
      { role: "user", content: "Say exactly: HELLO" },
    ];
    const result = await p.stream(messages, { maxTokens: 20 });
    const text = await collectStreamText(result);
    assert(text.length > 0, "應有回覆");
    console.log(`      → "${text.trim()}"`);

    // 5. 記錄對話
    mgr.addMessages(sk, [
      { role: "user", content: "Say exactly: HELLO" },
      { role: "assistant", content: text },
    ]);
    assert(mgr.getHistory(sk).length === 2, "history 應有 2 條");
  } finally {
    mgr.dequeueTurn(sk);
  }
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

await runAll();

resetSessionManager();
resetProviderRegistry();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${"─".repeat(40)}`);
const total = passed + failed + skipped;
if (failed === 0) {
  console.log(`✅ ${passed} 通過，${skipped} skip（無 API Key），共 ${total} 測試`);
} else {
  console.log(`❌ ${failed} 失敗 / ${total} 測試`);
  process.exit(1);
}
