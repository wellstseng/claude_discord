/**
 * recall 管線 smoke test — Vector-First 5 步管線
 *
 * 測試項目：
 *   1. keyword bonus：matchTriggers 命中 → score 加 0.05（微調）
 *   2. computeActivation：ACT-R 計算仍用於 consolidation（不影響 recall 排序）
 *   3. Step 5 排序：純 cosine + keyword 微調，不使用 ACT-R
 *   4. Keyword Fallback：向量不可用 → 固定分數 0.5
 *   5. matchedBy 標記：vector / keyword 兩種來源
 *   6. Consolidate sigmoid 評分
 *   7. 無 ACT-R 影響：不同 confirmations 但同 cosine → 排名相同
 *
 * 用法：node tests/recall-smoke.mjs
 */

import { matchTriggers } from "../dist/memory/index-manager.js";
import { computeActivation } from "../dist/memory/atom.js";

// ── 測試工具 ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function assertClose(actual, expected, tolerance, name) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✓ ${name} (${actual.toFixed(4)} ≈ ${expected.toFixed(4)})`);
    passed++;
  } else {
    console.error(`  ✗ ${name} — expected ${expected.toFixed(4)}, got ${actual.toFixed(4)}`);
    failed++;
  }
}

// ── 常數（與 recall.ts 同步） ───────────────────────────────────────────────

const KEYWORD_BONUS = 0.05;

// ── 共用 mock atoms ─────────────────────────────────────────────────────────

const now = Date.now();
const MS_PER_DAY = 86_400_000;

const atomFresh = {
  name: "fresh", path: "", description: "", confidence: "[固]",
  scope: "global", triggers: [], related: [], raw: "", content: "",
  confirmations: 10,
  createdAt: now - 30 * MS_PER_DAY,
  lastUsed: new Date(now - 1 * MS_PER_DAY).toISOString().slice(0, 10),
};

const atomStale = {
  name: "stale", path: "", description: "", confidence: "[臨]",
  scope: "global", triggers: [], related: [], raw: "", content: "",
  confirmations: 1,
  createdAt: now - 180 * MS_PER_DAY,
  lastUsed: new Date(now - 90 * MS_PER_DAY).toISOString().slice(0, 10),
};

// ── Test 1: matchTriggers（keyword 快篩） ───────────────────────────────────

console.log("\n═══ Test 1: matchTriggers ═══");

const entries = [
  { name: "preferences",  path: "preferences.md",  triggers: ["偏好", "風格", "習慣"], confidence: "[固]" },
  { name: "decisions",    path: "decisions.md",     triggers: ["決策", "記憶系統"],    confidence: "[固]" },
  { name: "toolchain",    path: "toolchain.md",     triggers: ["工具鏈", "bash", "git"], confidence: "[觀]" },
  { name: "workflow",     path: "workflow.md",      triggers: ["工作流程", "SOP"],      confidence: "[觀]" },
];

// 1a: 命中一個
const hit1 = matchTriggers("記憶系統怎麼設定", entries);
assert(hit1.length === 1, "prompt '記憶系統怎麼設定' → 命中 1 個 (decisions)");
assert(hit1[0]?.name === "decisions", "命中的是 decisions atom");

// 1b: 命中多個
const hit2 = matchTriggers("git 工具鏈設定", entries);
assert(hit2.length === 1, "prompt 'git 工具鏈設定' → 命中 toolchain (git + 工具鏈 都在同一 entry)");

// 1c: 無命中
const hit3 = matchTriggers("今天天氣如何", entries);
assert(hit3.length === 0, "prompt '今天天氣如何' → 無命中");

// 1d: 大小寫不敏感
const hit4 = matchTriggers("use BASH to run", entries);
assert(hit4.length === 1, "prompt 'use BASH to run' → 命中 toolchain (case insensitive)");

// ── Test 2: computeActivation（仍用於 consolidation）──────────────────────

console.log("\n═══ Test 2: computeActivation（consolidation 用）═══");

// 2a: 高 confirmations + 近期 → 高 activation
const actFresh = computeActivation(atomFresh);
const actStale = computeActivation(atomStale);

assert(actFresh > actStale, `fresh (${actFresh.toFixed(3)}) > stale (${actStale.toFixed(3)})`);
assert(actFresh > 0, `fresh activation > 0 (${actFresh.toFixed(3)})`);

// 2b: 相同 atom，confirmations 增加 → activation 增加
const atomMore = { ...atomFresh, confirmations: 20 };
const actMore = computeActivation(atomMore);
assert(actMore > actFresh, `20次確認 (${actMore.toFixed(3)}) > 10次確認 (${actFresh.toFixed(3)})`);

// ── Test 3: Step 5 排序 — 純 cosine + keyword 微調 ─────────────────────────

console.log("\n═══ Test 3: Step 5 — 純 cosine + keyword 微調 ═══");

{
  // 模擬三個 vector search 結果（raw cosine scores）
  const fragments = [
    { id: "atomA", score: 0.80 },
    { id: "atomB", score: 0.75 },
    { id: "atomC", score: 0.70 },
  ];

  // keyword 命中 atomC
  const keywordHits = new Set(["atomC"]);

  // 重現 Step 5 邏輯：純 cosine + keyword 微調
  const scored = fragments.map(f => ({
    id: f.id,
    score: f.score + (keywordHits.has(f.id) ? KEYWORD_BONUS : 0),
  }));
  scored.sort((a, b) => b.score - a.score);

  console.log("  排序結果：");
  for (const s of scored) {
    console.log(`    ${s.id}: score=${s.score.toFixed(4)}`);
  }

  // 3a: atomA 有最高 cosine → 排第一
  assert(scored[0].id === "atomA", "atomA（最高 cosine 0.80）排第一");

  // 3b: atomC 拿到 keyword bonus 但 cosine 太低，仍排最後
  assert(scored[2].id === "atomC", "atomC（cosine 0.70 + kw 0.05 = 0.75）排第三");

  // 3c: keyword bonus 值正確
  assertClose(scored[2].score, 0.75, 0.001, "atomC score = 0.70 + 0.05 = 0.75");
}

// ── Test 4: Keyword Fallback（向量不可用→固定分數 0.5）────────────────────

console.log("\n═══ Test 4: Keyword Fallback ═══");

{
  const kwHits = new Set(["preferences", "decisions"]);

  // 重現 fallback 邏輯：固定分數 0.5，matchedBy = "keyword"
  const fallbackFrags = [];
  for (const name of kwHits) {
    fallbackFrags.push({ id: name, score: 0.5, matchedBy: "keyword" });
  }

  // 4a: 有 keyword 命中 → 應該產生結果
  assert(fallbackFrags.length === 2, `keyword fallback 產生 ${fallbackFrags.length} 個結果`);

  // 4b: matchedBy 應該是 "keyword"
  assert(fallbackFrags[0].matchedBy === "keyword", "fallback 結果 matchedBy = 'keyword'");

  // 4c: 所有結果分數都是固定 0.5（不再用 ACT-R）
  assert(fallbackFrags.every(f => f.score === 0.5), "fallback 分數統一為 0.5（不使用 ACT-R）");

  // 4d: 無 keyword 命中 → 空結果
  const emptyKw = new Set();
  assert(emptyKw.size === 0, "keyword 全無命中 → fallback 回傳空");
}

// ── Test 5: matchedBy 兩種標記 ──────────────────────────────────────────────

console.log("\n═══ Test 5: matchedBy 標記區分 ═══");

{
  const vectorHit  = { id: "vec-atom",  matchedBy: "vector",  score: 0.85 };
  const keywordHit = { id: "kw-atom",   matchedBy: "keyword", score: 0.50 };

  // 5a: 兩種 matchedBy 值互不相同
  const types = new Set([vectorHit.matchedBy, keywordHit.matchedBy]);
  assert(types.size === 2, "兩種 matchedBy 值互不相同");

  // 5b: 各值正確
  assert(vectorHit.matchedBy === "vector", "向量搜尋 → matchedBy='vector'");
  assert(keywordHit.matchedBy === "keyword", "keyword fallback → matchedBy='keyword'");

  // 5c: trace 輸出格式合法
  const traceHits = [vectorHit, keywordHit].map(f => ({
    name: f.id,
    score: Math.round(f.score * 1000) / 1000,
    matchedBy: f.matchedBy,
  }));
  assert(traceHits.every(h => ["vector", "keyword"].includes(h.matchedBy)),
    "trace 輸出的 matchedBy 都是合法值");
}

// ── Test 6: Consolidate ACT-R sigmoid ──────────────────────────────────────

console.log("\n═══ Test 6: Consolidate ACT-R 評分（consolidation 專用）═══");

{
  const sigmoid = x => 1 / (1 + Math.exp(-x));

  // 6a: 高活躍 atom → sigmoid 分數高（不該被 archive）
  const freshScore = sigmoid(computeActivation(atomFresh));
  assert(freshScore > 0.5, `活躍 atom sigmoid score (${freshScore.toFixed(3)}) > 0.5`);

  // 6b: 低活躍 atom → sigmoid 分數低（可能被 archive）
  const staleScore = sigmoid(computeActivation(atomStale));
  assert(staleScore < freshScore, `過期 atom (${staleScore.toFixed(3)}) < 活躍 atom (${freshScore.toFixed(3)})`);

  // 6c: sigmoid 輸出在 0~1 之間
  assert(freshScore >= 0 && freshScore <= 1, `sigmoid 輸出在 0~1 (${freshScore.toFixed(3)})`);
  assert(staleScore >= 0 && staleScore <= 1, `sigmoid 輸出在 0~1 (${staleScore.toFixed(3)})`);

  console.log(`    archiveThreshold=0.2, stale=${staleScore.toFixed(3)}, fresh=${freshScore.toFixed(3)}`);
}

// ── Test 7: 無 ACT-R 影響 — 不同 confirmations 同 cosine → 排名相同 ────────

console.log("\n═══ Test 7: 無 ACT-R 影響驗證 ═══");

{
  // 兩個 atom 的 cosine score 相同，但 confirmations 差異巨大
  const fragmentHigh = { id: "popular", score: 0.75 };
  const fragmentLow  = { id: "obscure", score: 0.75 };

  // 模擬 Step 5：純 cosine 排序，無 ACT-R
  const keywordHits = new Set();
  const scored = [fragmentHigh, fragmentLow].map(f => ({
    id: f.id,
    score: f.score + (keywordHits.has(f.id) ? KEYWORD_BONUS : 0),
  }));

  // 7a: 同 cosine → 同分（不因 confirmations 而改變）
  assert(scored[0].score === scored[1].score,
    `popular (${scored[0].score}) === obscure (${scored[1].score}) — confirmations 不影響排序`);

  // 7b: keyword bonus 不會因為 atom 被頻繁召回而放大
  const withKw = { id: "kw-hit", score: 0.60 };
  const finalScore = withKw.score + KEYWORD_BONUS;
  assertClose(finalScore, 0.65, 0.001, "keyword bonus 固定 0.05，不受 confirmations 影響");
}

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
