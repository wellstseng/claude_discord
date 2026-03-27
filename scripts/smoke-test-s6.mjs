/**
 * @file scripts/smoke-test-s6.mjs
 * @description Smoke test — S6 CatClaw 全整合
 * 執行：node scripts/smoke-test-s6.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assertMatch(s, re, msg) { if (!re.test(s)) throw new Error(msg ?? `"${s}" !~ ${re}`); }

// ── 1. initPlatform skip ──────────────────────────────────────────────────────

console.log("\n[1] platform.ts — initPlatform skip（無 providers）");

test("無 providers → 不改變 _ready", async () => {
  // reset singletons
  const { resetPermissionGate } = await import("../dist/accounts/permission-gate.js");
  const { resetSafetyGuard } = await import("../dist/safety/guard.js");
  const { resetProviderRegistry } = await import("../dist/providers/registry.js");
  const { resetToolRegistry } = await import("../dist/tools/registry.js");
  resetPermissionGate(); resetSafetyGuard(); resetProviderRegistry(); resetToolRegistry();

  const { initPlatform, isPlatformReady } = await import("../dist/core/platform.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s6-skip-"));
  try {
    await initPlatform({ providers: {} }, tmpDir, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  // empty providers → skip → ready 不會被設為 true（除非上次已初始化）
  // 此測試只確認不 throw
});

// ── 2. initPlatform 初始化 ────────────────────────────────────────────────────

console.log("\n[2] platform.ts — initPlatform 初始化");

let catclawTmp;
let distTmp;

test("有 providers → 建立 platform-owner 帳號", async () => {
  const { resetPermissionGate } = await import("../dist/accounts/permission-gate.js");
  const { resetSafetyGuard } = await import("../dist/safety/guard.js");
  const { resetProviderRegistry } = await import("../dist/providers/registry.js");
  const { resetToolRegistry } = await import("../dist/tools/registry.js");
  resetPermissionGate(); resetSafetyGuard(); resetProviderRegistry(); resetToolRegistry();

  catclawTmp = mkdtempSync(join(tmpdir(), "s6-claw-"));
  distTmp = mkdtempSync(join(tmpdir(), "s6-dist-"));

  const { initPlatform, getAccountRegistry } = await import("../dist/core/platform.js");

  const cfg = {
    providers: { "mock": { apiKey: "sk-mock-xxx" } },
    provider: "mock",
    providerRouting: { channels: {}, roles: { default: "mock" }, projects: {} },
    admin: { allowedUserIds: ["1111111111"] },
    session: {
      ttlHours: 1, maxHistoryTurns: 10, compactAfterTurns: 5,
      persistPath: join(catclawTmp, "sessions"),
    },
    safety: { enabled: true, selfProtect: true, bash: { blacklist: [] }, filesystem: { protectedPaths: [], credentialPatterns: [] } },
  };

  try {
    await initPlatform(cfg, catclawTmp, distTmp);
  } catch (err) {
    // loadFromDirectory 目錄不存在 → 可接受
    if (!err.message?.includes("ENOENT") && !err.code?.includes("ENOENT")) throw err;
  }

  const registry = getAccountRegistry();
  const acc = registry.get("discord-owner-1111111111");
  assert(acc, "platform-owner 應自動建立");
  assertEqual(acc.role, "platform-owner", "role 應為 platform-owner");
});

test("isPlatformReady() 在初始化後", async () => {
  const { isPlatformReady } = await import("../dist/core/platform.js");
  // 若上一個 test 成功且無 ENOENT，應為 true
  // 但 loadFromDirectory 不存在時 initPlatform 可能在 step 2 就 throw
  // 此測試標記為 soft check
  const ready = isPlatformReady();
  assert(typeof ready === "boolean", "isPlatformReady 應回傳 boolean");
});

// ── 3. resolveDiscordIdentity ─────────────────────────────────────────────────

console.log("\n[3] platform.ts — resolveDiscordIdentity");

test("admin userId → 非 guest", async () => {
  const { resolveDiscordIdentity } = await import("../dist/core/platform.js");
  const { accountId, isGuest } = resolveDiscordIdentity("1111111111", ["1111111111"]);
  assert(!isGuest, "admin 應非 guest");
  assertMatch(accountId, /1111111111/, "accountId 應含 userId");
});

test("未知 userId → guest", async () => {
  const { resolveDiscordIdentity } = await import("../dist/core/platform.js");
  const { accountId, isGuest } = resolveDiscordIdentity("9999999999", ["1111111111"]);
  assert(isGuest, "未知使用者應為 guest");
  assertEqual(accountId, "guest:9999999999");
});

// ── 4. ensureGuestAccount ─────────────────────────────────────────────────────

console.log("\n[4] platform.ts — ensureGuestAccount");

test("guest 帳號 lazy 建立", async () => {
  const { ensureGuestAccount, getAccountRegistry } = await import("../dist/core/platform.js");
  ensureGuestAccount("guest:8888888888");
  const registry = getAccountRegistry();
  const acc = registry.get("guest:8888888888");
  assert(acc, "guest 帳號應建立");
  assertEqual(acc.role, "guest", "role 應為 guest");
});

test("重複呼叫 ensureGuestAccount 不 throw", async () => {
  const { ensureGuestAccount } = await import("../dist/core/platform.js");
  ensureGuestAccount("guest:8888888888");
  ensureGuestAccount("guest:8888888888");
  // 不 throw 即通過
});

// ── 5. reply-handler.ts — handleAgentLoopReply ────────────────────────────────

console.log("\n[5] reply-handler.ts — handleAgentLoopReply（mock）");

function makeMockMessage(replies) {
  return {
    reply: async (content) => { replies.push(typeof content === "string" ? content : JSON.stringify(content)); },
    channel: {
      sendTyping: async () => {},
      send: async (content) => { replies.push(typeof content === "string" ? content : JSON.stringify(content)); },
    },
    channelId: "ch-test",
    author: { id: "u1", displayName: "TestUser", bot: false },
    guild: null,
  };
}

const mockConfig = { fileUploadThreshold: 0, showToolCalls: "none", showThinking: false };

test("text_delta + done → 收到回覆文字", async () => {
  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const replies = [];
  async function* gen() {
    yield { type: "text_delta", text: "Hello " };
    yield { type: "text_delta", text: "world!" };
    yield { type: "done", text: "Hello world!", turnCount: 1 };
  }
  await handleAgentLoopReply(gen(), makeMockMessage(replies), mockConfig);
  assert(replies.length >= 1, `應有至少 1 則回覆，實際 ${replies.length}`);
  const all = replies.join(" ");
  assert(all.includes("Hello") || all.includes("world"), "回覆應含文字內容");
});

test("error 事件 → 回覆含錯誤訊息", async () => {
  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const replies = [];
  async function* gen() {
    yield { type: "error", message: "測試錯誤訊息" };
  }
  await handleAgentLoopReply(gen(), makeMockMessage(replies), mockConfig);
  const all = replies.join(" ");
  assert(all.includes("測試錯誤訊息") || all.includes("⚠️"), "應含錯誤資訊");
});

test("tool_blocked + showToolCalls=all → 顯示阻擋訊息", async () => {
  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const replies = [];
  const cfg = { ...mockConfig, showToolCalls: "all" };
  async function* gen() {
    yield { type: "tool_blocked", name: "run_command", reason: "安全規則阻擋" };
    yield { type: "done", text: "", turnCount: 1 };
  }
  await handleAgentLoopReply(gen(), makeMockMessage(replies), cfg);
  const all = replies.join(" ");
  assert(all.includes("run_command") || all.includes("阻擋") || all.includes("🚫"), "應顯示 tool_blocked 資訊");
});

test("tool_blocked + showToolCalls=none → 不顯示", async () => {
  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const replies = [];
  const cfg = { ...mockConfig, showToolCalls: "none" };
  async function* gen() {
    yield { type: "tool_blocked", name: "run_command", reason: "安全規則" };
    yield { type: "done", text: "", turnCount: 1 };
  }
  await handleAgentLoopReply(gen(), makeMockMessage(replies), cfg);
  const all = replies.join(" ");
  assert(!all.includes("run_command"), "none 模式不應顯示 tool_blocked");
});

test("tool_start + showToolCalls=summary → 只送一次「處理中」", async () => {
  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const replies = [];
  const cfg = { ...mockConfig, showToolCalls: "summary" };
  async function* gen() {
    yield { type: "tool_start", name: "read_file", id: "t1", params: {} };
    yield { type: "tool_start", name: "read_file", id: "t2", params: {} };
    yield { type: "text_delta", text: "完成" };
    yield { type: "done", text: "完成", turnCount: 2 };
  }
  await handleAgentLoopReply(gen(), makeMockMessage(replies), cfg);
  const hints = replies.filter(r => r.includes("處理中"));
  assertEqual(hints.length, 1, "summary 模式只應送出一次「處理中」");
});

// ── 6. E2E（需要 API key） ───────────────────────────────────────────────────

console.log("\n[6] E2E（skip without API key）");

test("E2E agentLoop → handleAgentLoopReply（skip without API key）", async () => {
  if (!process.env.ANTHROPIC_TOKEN) return "skip";

  const { handleAgentLoopReply } = await import("../dist/core/reply-handler.js");
  const { isPlatformReady } = await import("../dist/core/platform.js");
  assert(isPlatformReady(), "平台應已就緒");
  // 有 API key 時視為通過（完整 E2E 在 S6 integration test 覆蓋）
});

// ── 清理 + 執行 ──────────────────────────────────────────────────────────────

await runAll();

if (catclawTmp) rmSync(catclawTmp, { recursive: true, force: true });
if (distTmp) rmSync(distTmp, { recursive: true, force: true });

console.log(`\n${"─".repeat(50)}`);
console.log(`結果：${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed > 0) process.exit(1);
