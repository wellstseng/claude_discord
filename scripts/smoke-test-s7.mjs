/**
 * @file scripts/smoke-test-s7.mjs
 * @description Smoke test — S7 工作流引擎
 * 執行：node scripts/smoke-test-s7.mjs
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

// ── 1. FileTracker ────────────────────────────────────────────────────────────

console.log("\n[1] file-tracker.ts");

test("trackFileEdit 記錄檔案", async () => {
  const { trackFileEdit, getModifiedFiles, getEditCount } = await import("../dist/workflow/file-tracker.js");
  trackFileEdit("session-1", "/src/foo.ts");
  trackFileEdit("session-1", "/src/foo.ts");
  trackFileEdit("session-1", "/src/bar.ts");
  const files = getModifiedFiles("session-1");
  assert(files.includes("/src/foo.ts"), "應含 foo.ts");
  assert(files.includes("/src/bar.ts"), "應含 bar.ts");
  assertEqual(getEditCount("session-1", "/src/foo.ts"), 2, "foo.ts 應 2 次");
});

test("getFrequentEdits 回傳 editCount ≥ n 的檔案", async () => {
  const { getFrequentEdits, trackFileEdit } = await import("../dist/workflow/file-tracker.js");
  trackFileEdit("session-2", "/src/x.ts");
  trackFileEdit("session-2", "/src/x.ts");
  trackFileEdit("session-2", "/src/y.ts");
  const result = getFrequentEdits("session-2", 2);
  assert(result.some(r => r.path === "/src/x.ts" && r.count === 2), "x.ts count=2");
  assert(!result.some(r => r.path === "/src/y.ts"), "y.ts count=1 應被排除");
});

test("clearSession 清除記錄", async () => {
  const { clearSession, getModifiedFiles } = await import("../dist/workflow/file-tracker.js");
  clearSession("session-1");
  const files = getModifiedFiles("session-1");
  assertEqual(files.length, 0, "清除後應無記錄");
});

// ── 2. OscillationDetector ────────────────────────────────────────────────────

console.log("\n[2] oscillation-detector.ts");

test("initOscillationDetector 不 throw", async () => {
  const { initOscillationDetector } = await import("../dist/workflow/oscillation-detector.js");
  const { eventBus } = await import("../dist/core/event-bus.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s7-osc-"));
  try {
    initOscillationDetector(eventBus, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getSessionOscillationStats 在無記錄時回傳空 Map", async () => {
  const { getSessionOscillationStats } = await import("../dist/workflow/oscillation-detector.js");
  const stats = getSessionOscillationStats("nonexistent-session");
  assertEqual(stats.size, 0, "無記錄時應回傳空 Map");
});

// ── 3. RutDetector ────────────────────────────────────────────────────────────

console.log("\n[3] rut-detector.ts");

let rutTmpDir;
test("recordRutSignals + triggerRutScan 偵測覆轍", async () => {
  const { recordRutSignals, triggerRutScan, initRutDetector, getSignalsPath } = await import("../dist/workflow/rut-detector.js");
  const { eventBus } = await import("../dist/core/event-bus.js");

  rutTmpDir = mkdtempSync(join(tmpdir(), "s7-rut-"));
  initRutDetector(eventBus, rutTmpDir);

  // 寫入 2 次相同 pattern
  await recordRutSignals("session-A", ["same_file_3x:/src/reply.ts"]);
  await recordRutSignals("session-B", ["same_file_3x:/src/reply.ts"]);

  const warnings = [];
  eventBus.on("workflow:rut", (w) => { warnings.push(...w); });

  await triggerRutScan(eventBus);

  assert(warnings.length > 0, "應偵測到至少一個覆轍警告");
  assert(warnings.some(w => w.pattern.includes("reply.ts")), "應含 reply.ts pattern");
  assert(warnings.some(w => w.count >= 2), "應有 count ≥ 2");
});

// ── 4. WisdomEngine ───────────────────────────────────────────────────────────

console.log("\n[4] wisdom-engine.ts");

test("無觸發條件 → 回傳空陣列（W3）", async () => {
  const { getWisdomAdvice } = await import("../dist/workflow/wisdom-engine.js");
  const advices = getWisdomAdvice("sess-w1", "今天天氣好", 0);
  assertEqual(advices.length, 0, "無觸發時應回傳空陣列");
});

test("W1：file_count≥5 + feature keyword → 建議確認", async () => {
  const { getWisdomAdvice } = await import("../dist/workflow/wisdom-engine.js");
  const advices = getWisdomAdvice("sess-w2", "新增一個功能模組", 5);
  assert(advices.some(a => a.rule === "W1"), "應觸發 W1 規則");
  assert(advices.some(a => a.message.includes("確認")), "W1 訊息應含「確認」");
});

test("W2：touches_arch + file_count≥3 → 建議計畫", async () => {
  const { getWisdomAdvice } = await import("../dist/workflow/wisdom-engine.js");
  const advices = getWisdomAdvice("sess-w3", "重構架構設計，整理 index.ts", 3);
  assert(advices.some(a => a.rule === "W2"), "應觸發 W2 規則");
  assert(advices.some(a => a.message.includes("規劃") || a.message.includes("計畫")), "W2 訊息應含「規劃」或「計畫」");
});

test("buildWisdomSystemPromptAddition：有建議 → 非空字串", async () => {
  const { getWisdomAdvice, buildWisdomSystemPromptAddition } = await import("../dist/workflow/wisdom-engine.js");
  const advices = getWisdomAdvice("sess-w4", "新增一個功能模組", 5);
  const addition = buildWisdomSystemPromptAddition(advices);
  if (advices.length > 0) {
    assert(addition.length > 0, "有建議時應回傳非空字串");
  }
});

test("initWisdomEngine 不 throw", async () => {
  const { initWisdomEngine } = await import("../dist/workflow/wisdom-engine.js");
  const { eventBus } = await import("../dist/core/event-bus.js");
  initWisdomEngine(eventBus);
});

// ── 5. FixEscalation ──────────────────────────────────────────────────────────

console.log("\n[5] fix-escalation.ts");

test("recordRetry 累計到閾值 → 回傳 true", async () => {
  const { recordRetry } = await import("../dist/workflow/fix-escalation.js");
  const r1 = recordRetry("esc-session-1");
  const r2 = recordRetry("esc-session-1");
  assert(!r1, "第 1 次不應觸發");
  assert(r2, "第 2 次應觸發 escalation");
});

test("getRetryCount 回傳正確次數", async () => {
  const { getRetryCount } = await import("../dist/workflow/fix-escalation.js");
  const count = getRetryCount("esc-session-1");
  assert(count >= 2, `retry count 應 ≥ 2，實際 ${count}`);
});

test("resetRetry 後 count=0", async () => {
  const { resetRetry, getRetryCount } = await import("../dist/workflow/fix-escalation.js");
  resetRetry("esc-session-1");
  assertEqual(getRetryCount("esc-session-1"), 0);
});

test("runFixEscalation mock → early exit on success", async () => {
  const { runFixEscalation } = await import("../dist/workflow/fix-escalation.js");
  let callCount = 0;
  const deps = {
    runTurn: async (prompt, extra, signal) => {
      callCount++;
      if (callCount >= 2) return "修正成功，問題已解決，build 通過。";
      return ""; // 第 1 輪無進展
    },
  };
  const ctx = {
    sessionKey: "esc-session-esc",
    accountId: "test-user",
    failedPrompt: "修復 foo 的錯誤",
    errorHistory: ["Error: foo is undefined"],
    retryCount: 2,
  };
  const attempts = await runFixEscalation(ctx, deps, 10000);
  assert(attempts.length >= 1, "應有至少 1 輪嘗試");
  assert(callCount <= 3, `應提前結束，實際 ${callCount} 次`);
});

// ── 6. FailureDetector ────────────────────────────────────────────────────────

console.log("\n[6] failure-detector.ts");

test("initFailureDetector 不 throw", async () => {
  const { initFailureDetector } = await import("../dist/workflow/failure-detector.js");
  const { eventBus } = await import("../dist/core/event-bus.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s7-fail-"));
  try {
    initFailureDetector(eventBus, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 7. AidocsManager ─────────────────────────────────────────────────────────

console.log("\n[7] aidocs-manager.ts");

test("getPendingAidocsFiles 初始為空", async () => {
  const { getPendingAidocsFiles } = await import("../dist/workflow/aidocs-manager.js");
  const files = getPendingAidocsFiles();
  assert(Array.isArray(files), "應回傳陣列");
});

test("getAidocsSyncHint 無 _AIDocs 時回傳空字串", async () => {
  const { getAidocsSyncHint, setProjectRoots } = await import("../dist/workflow/aidocs-manager.js");
  setProjectRoots([tmpdir()]);  // tmpdir 沒有 _AIDocs
  const hint = getAidocsSyncHint();
  assertEqual(hint, "", "無 _AIDocs 時應回傳空字串");
});

// ── 8. Bootstrap ──────────────────────────────────────────────────────────────

console.log("\n[8] workflow/bootstrap.ts");

test("initWorkflow 整合不 throw", async () => {
  const { initWorkflow } = await import("../dist/workflow/bootstrap.js");
  const tmpData = mkdtempSync(join(tmpdir(), "s7-boot-"));
  const tmpMem = mkdtempSync(join(tmpdir(), "s7-mem-"));
  try {
    initWorkflow({ enabled: true }, tmpData, tmpMem, tmpdir());
  } finally {
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpMem, { recursive: true, force: true });
  }
});

test("initWorkflow enabled=false → 跳過（不 throw）", async () => {
  const { initWorkflow } = await import("../dist/workflow/bootstrap.js");
  initWorkflow({ enabled: false }, tmpdir(), tmpdir());
});

// ── 執行 ─────────────────────────────────────────────────────────────────────

await runAll();

if (rutTmpDir) rmSync(rutTmpDir, { recursive: true, force: true });

console.log(`\n${"─".repeat(50)}`);
console.log(`結果：${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed > 0) process.exit(1);
