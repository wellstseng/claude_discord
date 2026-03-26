/**
 * S2 Smoke Test — Ollama Client + Vector Service + Embedding
 * 執行：node scripts/smoke-test-s2.mjs
 *
 * 注意：Ollama 相關測試在 Ollama offline 時會 graceful skip（不 fail）
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

let passed = 0;
let failed = 0;
let skipped = 0;

// 收集所有 test，最後統一按序 await
const _queue = [];

function test(name, fn) {
  _queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      const result = await fn();
      if (result === "skip") { console.log(`  ⊘ ${name} (skip)`); skipped++; }
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

const tmpDir = join(tmpdir(), `catclaw-s2-smoke-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

// ── 設定 env vars（使用 .catclaw-test）────────────────────────────────────

const testCatclawDir = join(homedir(), ".catclaw-test");
process.env.CATCLAW_CONFIG_DIR = testCatclawDir;
process.env.CATCLAW_WORKSPACE  = join(testCatclawDir, "workspace");

// ── 從 catclaw-test config 讀取 ollama 設定（含 model 名稱）─────────────────

const { config: testConfig } = await import("../dist/core/config.js");
const ollamaCfg = testConfig.ollama ?? {
  enabled: true,
  primary: { host: "http://localhost:11434", model: "qwen3:14b", embeddingModel: "nomic-embed-text:latest" },
  failover: false, thinkMode: false, numPredict: 256, timeout: 10000,
};

// ── Module 1: ollama/client ────────────────────────────────────────────────

console.log("\n[1] ollama/client");
console.log(`   config: primary=${ollamaCfg.primary.host} model=${ollamaCfg.primary.model} embed=${ollamaCfg.primary.embeddingModel ?? "(none)"}`);

const { OllamaClient, buildBackendsFromConfig, initOllamaClient, getOllamaClient, resetOllamaClient } =
  await import("../dist/ollama/client.js");

test("buildBackendsFromConfig 解析 primary+fallback", () => {
  const cfg = {
    enabled: true,
    primary: { host: "http://localhost:11434", model: "qwen3:8b", embeddingModel: "nomic-embed-text:latest" },
    fallback: { host: "http://fallback:11434", model: "qwen3:1.7b" },
    failover: true,
    thinkMode: false,
    numPredict: 8192,
    timeout: 120000,
  };
  const backends = buildBackendsFromConfig(cfg);
  assert(backends.length === 2, `expected 2, got ${backends.length}`);
  assert(backends[0].name === "primary");
  assert(backends[0].embeddingModel === "nomic-embed-text:latest");
  assert(backends[1].name === "fallback");
  assert(backends[1].priority > backends[0].priority, "fallback priority should be higher number");
});

test("buildBackendsFromConfig 無 fallback 時只有 primary", () => {
  const cfg = {
    enabled: true,
    primary: { host: "http://localhost:11434", model: "qwen3:8b" },
    failover: false,
    thinkMode: false,
    numPredict: 2048,
    timeout: 60000,
  };
  const backends = buildBackendsFromConfig(cfg);
  assert(backends.length === 1, `expected 1, got ${backends.length}`);
});

test("initOllamaClient / getOllamaClient 正常", () => {
  resetOllamaClient();
  const cfg = {
    enabled: true,
    primary: { host: "http://localhost:99999", model: "qwen3:8b" },
    failover: false,
    thinkMode: false,
    numPredict: 2048,
    timeout: 5000,
  };
  const client = initOllamaClient(cfg);
  assert(client instanceof OllamaClient);
  const got = getOllamaClient();
  assert(got === client, "singleton mismatch");
  resetOllamaClient();
});

test("getOllamaClient 未初始化時拋出", () => {
  resetOllamaClient();
  let thrown = false;
  try { getOllamaClient(); } catch { thrown = true; }
  assert(thrown, "should throw");
  // 重新初始化，讓後續 embedding 測試可用
  initOllamaClient(ollamaCfg);
});

// ── 初始化 client（後續測試共用）──────────────────────────────────────────
initOllamaClient(ollamaCfg);
const mainClient = getOllamaClient();
const primaryBackend = mainClient["backends"][0];
const ollamaOnline = await mainClient.checkHealth(primaryBackend);
console.log(`   Ollama: ${ollamaOnline ? "✓ online" : "✗ offline (embedding tests will skip)"}`);

test("ollama health check", async () => {
  if (!ollamaOnline) return "skip";
  assert(ollamaOnline === true);
});

test("ollama embed（需 embedding model）", async () => {
  if (!ollamaOnline) return "skip";
  const vecs = await mainClient.embed(["hello world", "測試向量"]);
  if (!vecs.length) return "skip";
  assert(vecs.length === 2, `expected 2, got ${vecs.length}`);
  assert(vecs[0].length > 0, "zero-dim vector");
  console.log(`      → ${vecs[0].length} dims`);
});

// ── Module 2: vector/embedding ────────────────────────────────────────────

console.log("\n[2] vector/embedding");

const { embedTexts, embedOne, getEmbeddingDim, getCachedDim, setCachedDim } =
  await import("../dist/vector/embedding.js");

test("embedTexts 空陣列回傳空結果", async () => {
  const result = await embedTexts([]);
  assert(Array.isArray(result.vectors));
  assert(result.vectors.length === 0);
});

test("setCachedDim / getCachedDim", () => {
  setCachedDim(1024);
  assert(getCachedDim() === 1024, `got ${getCachedDim()}`);
  setCachedDim(0); // 還原
});

test("embedOne + embedTexts（需 Ollama 在線）", async () => {
  if (!ollamaOnline) return "skip";
  const vec = await embedOne("測試 embed");
  if (!vec.length) return "skip";
  assert(vec.length > 0, "zero-dim");
  console.log(`      → ${vec.length} dims`);

  const result = await embedTexts(["hello", "world"]);
  assert(result.vectors.length === 2);
  assert(result.dim === vec.length);
});

// ── Module 3: vector/lancedb ───────────────────────────────────────────────

console.log("\n[3] vector/lancedb");

const { LanceVectorService, initVectorService, getVectorService, resetVectorService } =
  await import("../dist/vector/lancedb.js");

const vectorDbPath = join(tmpDir, "_vectordb");

test("initVectorService + init()", async () => {
  const svc = initVectorService(vectorDbPath);
  await svc.init();
  assert(svc instanceof LanceVectorService);
  // init 可能因為磁碟路徑問題失敗，但不應該 throw
});

test("getVectorService singleton", () => {
  const svc = getVectorService();
  assert(svc instanceof LanceVectorService);
});

test("validateNamespace — 無效 namespace 拋出", async () => {
  const svc = getVectorService();
  let thrown = false;
  try { await svc.upsert("id", "text", ""); } catch { thrown = true; }
  assert(thrown, "empty namespace should throw");

  thrown = false;
  try { await svc.upsert("id", "text", "invalid-ns"); } catch { thrown = true; }
  assert(thrown, "invalid namespace should throw");
});

test("validateNamespace — 合法格式", async () => {
  // 這些不應該 throw（upsert 本身因 Ollama offline 可能 skip，但不報錯）
  const svc = getVectorService();
  for (const ns of ["global", "project/game-server", "account/wells"]) {
    try { await svc.upsert("test-id", "test", ns); } catch (err) {
      if (err.message.includes("無效 namespace")) throw err;
      // 其他錯誤（Ollama offline）可接受
    }
  }
});

test("upsert + search（需 Ollama embedding 在線）", async () => {
  if (!ollamaOnline) return "skip";
  const testVec = await embedOne("test");
  if (!testVec.length) return "skip";

  const svc = getVectorService();
  await svc.upsert("atom-1", "這是關於記憶系統的知識", "global", { path: "memory/atoms/test.md" });
  await svc.upsert("atom-2", "這是關於 Discord bot 設定的知識", "global");

  const results = await svc.search("記憶系統知識", { namespace: "global", topK: 5, minScore: 0.5 });
  assert(Array.isArray(results), "should return array");
  console.log(`      → ${results.length} hits`);
  if (results.length > 0) {
    assert(typeof results[0].score === "number");
    assert(results[0].score >= 0 && results[0].score <= 1);
  }
});

test("delete（需 Ollama embedding 在線）", async () => {
  if (!ollamaOnline) return "skip";
  const testVec = await embedOne("test");
  if (!testVec.length) return "skip";

  const svc = getVectorService();
  await svc.delete("atom-1", "global");
  const results = await svc.search("記憶系統", { namespace: "global", topK: 5 });
  assert(!results.some(r => r.id === "atom-1"), "atom-1 should be deleted");
});

// ── 執行所有測試（sequential）+ 清理 + 結果 ──────────────────────────────

await runAll();

resetVectorService();
resetOllamaClient();
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${"─".repeat(40)}`);
const total = passed + failed + skipped;
if (failed === 0) {
  console.log(`✅ ${passed} 通過，${skipped} skip（Ollama offline），共 ${total} 測試`);
} else {
  console.log(`❌ ${failed} 失敗 / ${total} 測試`);
  process.exit(1);
}
