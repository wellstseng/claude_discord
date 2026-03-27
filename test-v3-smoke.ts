/**
 * V3 Subagent Smoke Test
 * 執行：npx tsx test-v3-smoke.ts
 */

import assert from "node:assert/strict";
import { SubagentRegistry, initSubagentRegistry, getSubagentRegistry } from "./src/core/subagent-registry.js";

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}

function testAsync(name: string, fn: () => Promise<void>) {
  return fn().then(() => {
    console.log(`  ✓ ${name}`);
    pass++;
  }).catch(err => {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  });
}

console.log("\n[1] SubagentRegistry");

test("initSubagentRegistry + getSubagentRegistry 單例", () => {
  const r = initSubagentRegistry(3);
  assert.ok(r instanceof SubagentRegistry);
  assert.equal(getSubagentRegistry(), r);
});

test("create + get", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({
    parentSessionKey: "discord:ch:test-parent",
    task: "測試任務",
    label: "test-label",
    accountId: "test-account",
  });
  assert.ok(rec.runId);
  assert.equal(rec.status, "running");
  assert.equal(rec.parentSessionKey, "discord:ch:test-parent");
  assert.ok(rec.childSessionKey.startsWith("discord:ch:test-parent:sub:"));
  assert.equal(r.get(rec.runId), rec);
});

test("complete", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({ parentSessionKey: "discord:ch:p2", task: "t", accountId: "a" });
  r.complete(rec.runId, "done result", 3);
  const updated = r.get(rec.runId)!;
  assert.equal(updated.status, "completed");
  assert.equal(updated.result, "done result");
  assert.equal(updated.turns, 3);
  assert.ok(updated.endedAt);
});

test("fail", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({ parentSessionKey: "discord:ch:p3", task: "t", accountId: "a" });
  r.fail(rec.runId, "some error");
  assert.equal(r.get(rec.runId)!.status, "failed");
  assert.equal(r.get(rec.runId)!.error, "some error");
});

test("kill（中斷 AbortController）", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({ parentSessionKey: "discord:ch:p4", task: "t", accountId: "a" });
  let aborted = false;
  rec.abortController.signal.addEventListener("abort", () => { aborted = true; });
  const ok = r.kill(rec.runId);
  assert.ok(ok);
  assert.ok(aborted, "AbortController 應觸發");
  assert.equal(r.get(rec.runId)!.status, "killed");
});

test("kill 已結束的 runId 回傳 false", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({ parentSessionKey: "discord:ch:p5", task: "t", accountId: "a" });
  r.complete(rec.runId, "ok");
  assert.equal(r.kill(rec.runId), false);
});

test("killAll 只 kill 指定 parent 的 running", () => {
  const r = getSubagentRegistry()!;
  const pKey = "discord:ch:p-kill-all";
  const r1 = r.create({ parentSessionKey: pKey, task: "t1", accountId: "a" });
  const r2 = r.create({ parentSessionKey: pKey, task: "t2", accountId: "a" });
  const r3 = r.create({ parentSessionKey: "discord:ch:other", task: "t3", accountId: "a" });
  const count = r.killAll(pKey);
  assert.equal(count, 2);
  assert.equal(r.get(r1.runId)!.status, "killed");
  assert.equal(r.get(r2.runId)!.status, "killed");
  assert.equal(r.get(r3.runId)!.status, "running", "其他 parent 不受影響");
});

test("isOverConcurrentLimit（maxConcurrent=3）", () => {
  const r = new SubagentRegistry(3);
  const pKey = "discord:ch:limit-test";
  assert.equal(r.isOverConcurrentLimit(pKey), false);
  r.create({ parentSessionKey: pKey, task: "t1", accountId: "a" });
  r.create({ parentSessionKey: pKey, task: "t2", accountId: "a" });
  r.create({ parentSessionKey: pKey, task: "t3", accountId: "a" });
  assert.equal(r.isOverConcurrentLimit(pKey), true, "3 個同時執行應超限");
});

test("listByParent 正確篩選", () => {
  const r = getSubagentRegistry()!;
  const pKey = "discord:ch:list-test";
  r.create({ parentSessionKey: pKey, task: "t1", accountId: "a" });
  r.create({ parentSessionKey: pKey, task: "t2", accountId: "a" });
  r.create({ parentSessionKey: "discord:ch:other2", task: "t3", accountId: "a" });
  const list = r.listByParent(pKey);
  assert.ok(list.length >= 2);
  assert.ok(list.every(rec => rec.parentSessionKey === pKey));
});

test("timeout", () => {
  const r = getSubagentRegistry()!;
  const rec = r.create({ parentSessionKey: "discord:ch:t-timeout", task: "t", accountId: "a" });
  r.timeout(rec.runId);
  assert.equal(r.get(rec.runId)!.status, "timeout");
});

console.log("\n[2] subagent-discord-bridge");

test("setDiscordClient + getDiscordClient", async () => {
  const { setDiscordClient, getDiscordClient } = await import("./src/core/subagent-discord-bridge.js");
  assert.equal(getDiscordClient(), null);
  const fakeClient = {} as never;
  setDiscordClient(fakeClient);
  assert.equal(getDiscordClient(), fakeClient);
  // 清回 null
  setDiscordClient(null as never);
});

test("bindSubagentThread + getSubagentThreadBinding", async () => {
  const { bindSubagentThread, getSubagentThreadBinding, unbindSubagentThread } = await import("./src/core/subagent-discord-bridge.js");
  bindSubagentThread("thread-123", "discord:ch:parent:sub:abc");
  assert.equal(getSubagentThreadBinding("thread-123"), "discord:ch:parent:sub:abc");
  assert.equal(getSubagentThreadBinding("unknown"), undefined);
  unbindSubagentThread("thread-123");
  assert.equal(getSubagentThreadBinding("thread-123"), undefined);
});

// 最終報告
await Promise.resolve(); // 等非同步 test 完成
setTimeout(() => {
  console.log(`\n${"─".repeat(40)}`);
  console.log(`✅ ${pass} 通過，❌ ${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
}, 100);
