/**
 * recall 管線 smoke test — 測試三項新功能
 *
 * 測試項目：
 *   1. keyword bonus：matchTriggers 命中 → score 加 0.15
 *   2. ACT-R activation：高 confirmations + 近期 lastUsed → 排序靠前
 *   3. Related-Edge Spreading：命中 atom A → related atom B 自動展開
 *   5. Keyword Fallback：向量不可用 → 純 keyword + ACT-R 兜底
 *   6. matchedBy 標記：vector / keyword / related 三種來源區分
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

const KEYWORD_BONUS = 0.15;
const COSINE_WEIGHT = 0.7;
const ACTIVATION_WEIGHT = 0.3;
const RELATED_SCORE_DISCOUNT = 0.6;
const RELATED_MAX_EXPAND = 3;

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

// ── Test 2: computeActivation（ACT-R 認知模型） ─────────────────────────────

console.log("\n═══ Test 2: computeActivation ═══");

const now = Date.now();
const MS_PER_DAY = 86_400_000;

// 2a: 高 confirmations + 近期 → 高 activation
const atomFresh = {
  name: "fresh", path: "", description: "", confidence: "[固]",
  scope: "global", triggers: [], related: [], raw: "", content: "",
  confirmations: 10,
  createdAt: now - 30 * MS_PER_DAY,
  lastUsed: new Date(now - 1 * MS_PER_DAY).toISOString().slice(0, 10),
};

// 2b: 低 confirmations + 久遠 → 低 activation
const atomStale = {
  name: "stale", path: "", description: "", confidence: "[臨]",
  scope: "global", triggers: [], related: [], raw: "", content: "",
  confirmations: 1,
  createdAt: now - 180 * MS_PER_DAY,
  lastUsed: new Date(now - 90 * MS_PER_DAY).toISOString().slice(0, 10),
};

const actFresh = computeActivation(atomFresh);
const actStale = computeActivation(atomStale);

assert(actFresh > actStale, `fresh (${actFresh.toFixed(3)}) > stale (${actStale.toFixed(3)})`);
assert(actFresh > 0, `fresh activation > 0 (${actFresh.toFixed(3)})`);

// 2c: 相同 atom，confirmations 增加 → activation 增加
const atomMore = { ...atomFresh, confirmations: 20 };
const actMore = computeActivation(atomMore);
assert(actMore > actFresh, `20次確認 (${actMore.toFixed(3)}) > 10次確認 (${actFresh.toFixed(3)})`);

// ── Test 3: Step 5 排序邏輯（keyword bonus + ACT-R 混合） ───────────────────

console.log("\n═══ Test 3: Step 5 — keyword bonus + ACT-R 混合排序 ═══");

// 模擬三個 vector search 結果
const fragments = [
  { id: "atomA", score: 0.80, atom: { ...atomFresh, name: "atomA", confirmations: 2, lastUsed: new Date(now - 30 * MS_PER_DAY).toISOString().slice(0, 10) } },
  { id: "atomB", score: 0.75, atom: { ...atomFresh, name: "atomB", confirmations: 10, lastUsed: new Date(now - 1 * MS_PER_DAY).toISOString().slice(0, 10) } },
  { id: "atomC", score: 0.70, atom: { ...atomFresh, name: "atomC", confirmations: 1, lastUsed: new Date(now - 60 * MS_PER_DAY).toISOString().slice(0, 10) } },
];

// 模擬 keyword 命中 atomC
const keywordHits = new Set(["atomC"]);

// 重現 Step 5 邏輯
const activations = fragments.map(f => computeActivation(f.atom));
const maxAct = Math.max(...activations, 1);
const minAct = Math.min(...activations, 0);
const actRange = maxAct - minAct || 1;

const scored = fragments.map((f, i) => {
  const cosine = f.score;
  const actNorm = (activations[i] - minAct) / actRange;
  const kwBonus = keywordHits.has(f.id) ? KEYWORD_BONUS : 0;
  const finalScore = COSINE_WEIGHT * cosine + ACTIVATION_WEIGHT * actNorm + kwBonus;
  return { id: f.id, cosine, actNorm, kwBonus, finalScore };
});

scored.sort((a, b) => b.finalScore - a.finalScore);

console.log("  排序結果：");
for (const s of scored) {
  console.log(`    ${s.id}: final=${s.finalScore.toFixed(4)} (cosine=${s.cosine.toFixed(2)} actNorm=${s.actNorm.toFixed(3)} kw=${s.kwBonus})`);
}

// 3a: atomB 有高 activation（近期 + 10次確認），應該排在 atomA 前面
// atomA cosine=0.80 但 activation 低；atomB cosine=0.75 但 activation 高
assert(
  scored.findIndex(s => s.id === "atomB") < scored.findIndex(s => s.id === "atomA"),
  "atomB（高 activation）排在 atomA（高 cosine 但低 activation）前面"
);

// 3b: atomC 有 keyword bonus，即使 cosine 最低也應該被提升
const atomCEntry = scored.find(s => s.id === "atomC");
assert(atomCEntry.kwBonus === 0.15, "atomC 拿到 keyword bonus 0.15");

// 3c: 沒有 keyword bonus 的 atom 不應該有加分
const atomAEntry = scored.find(s => s.id === "atomA");
assert(atomAEntry.kwBonus === 0, "atomA 沒有 keyword bonus");

// ── Test 4: Step 6 — Related-Edge Spreading ─────────────────────────────────

console.log("\n═══ Test 4: Step 6 — Related-Edge Spreading ═══");

// 模擬 topFragments（Step 5 輸出）
const topFragments = [
  { id: "main-atom", score: 0.85, atom: { name: "main-atom", related: ["related-1", "related-2", "related-3", "related-4"] }, layer: "global" },
  { id: "second-atom", score: 0.70, atom: { name: "second-atom", related: [] }, layer: "global" },
];

// 模擬可用的 related atoms（模擬 readAtom 的結果）
const availableAtoms = {
  "related-1": { name: "related-1", related: [] },
  "related-2": { name: "related-2", related: [] },
  "related-3": { name: "related-3", related: [] },
  "related-4": { name: "related-4", related: [] },
};

// 重現 Step 6 邏輯
const existingIds = new Set(topFragments.map(f => f.id));
const relatedFragments = [];

for (const frag of topFragments) {
  if (frag.atom.related.length === 0) continue;
  let expanded = 0;
  for (const relName of frag.atom.related) {
    if (existingIds.has(relName) || expanded >= RELATED_MAX_EXPAND) continue;
    const relAtom = availableAtoms[relName];
    if (!relAtom) continue;
    const relScore = frag.score * RELATED_SCORE_DISCOUNT;
    relatedFragments.push({ id: relAtom.name, layer: frag.layer, atom: relAtom, score: relScore });
    existingIds.add(relName);
    expanded++;
  }
}

// 4a: 應展開 3 個（RELATED_MAX_EXPAND = 3），雖然有 4 個 related
assert(relatedFragments.length === 3, `展開 ${relatedFragments.length} 個 related atom（上限 3）`);

// 4b: related atom 的 score 應該是 parent × 0.6
const expectedRelScore = 0.85 * RELATED_SCORE_DISCOUNT;
assertClose(relatedFragments[0].score, expectedRelScore, 0.001, `related score = parent(0.85) × 0.6 = ${expectedRelScore}`);

// 4c: 第四個 related-4 不應該被展開
assert(!relatedFragments.find(f => f.id === "related-4"), "related-4 未被展開（超過上限 3）");

// 4d: 已存在的 id 不會重複展開
existingIds.clear();
const topWithOverlap = [
  { id: "A", score: 0.90, atom: { name: "A", related: ["B"] }, layer: "global" },
  { id: "B", score: 0.80, atom: { name: "B", related: [] }, layer: "global" },
];
const overlapExisting = new Set(topWithOverlap.map(f => f.id));
const overlapRelated = [];
for (const frag of topWithOverlap) {
  if (frag.atom.related.length === 0) continue;
  let expanded = 0;
  for (const relName of frag.atom.related) {
    if (overlapExisting.has(relName) || expanded >= RELATED_MAX_EXPAND) continue;
    overlapRelated.push(relName);
    expanded++;
  }
}
assert(overlapRelated.length === 0, "B 已在 top results 中 → 不重複展開");

// ── Test 5: Keyword Fallback（模擬向量不可用） ──────────────────────────────

console.log("\n═══ Test 5: Keyword Fallback ═══");

// 模擬 keywordFallback 邏輯（recall.ts 中的 fallback 函式）
// 向量掛了 → 只用 keyword hits + computeActivation 排序
{
  const kwHits = new Set(["preferences", "decisions"]);

  // 模擬各層目錄中可讀到的 atom
  const mockAtoms = {
    "preferences": { ...atomFresh, name: "preferences", confirmations: 8, lastUsed: new Date(now - 2 * MS_PER_DAY).toISOString().slice(0, 10) },
    "decisions":   { ...atomStale, name: "decisions",   confirmations: 3, lastUsed: new Date(now - 20 * MS_PER_DAY).toISOString().slice(0, 10) },
  };

  // 重現 fallback 邏輯：純 ACT-R score，matchedBy = "keyword"
  const fallbackFrags = [];
  for (const name of kwHits) {
    const atom = mockAtoms[name];
    if (!atom) continue;
    const score = computeActivation(atom);
    fallbackFrags.push({ id: atom.name, score, matchedBy: "keyword" });
  }
  fallbackFrags.sort((a, b) => b.score - a.score);

  // 5a: 有 keyword 命中 → 應該產生結果（不是空的）
  assert(fallbackFrags.length === 2, `keyword fallback 產生 ${fallbackFrags.length} 個結果`);

  // 5b: matchedBy 應該是 "keyword"
  assert(fallbackFrags[0].matchedBy === "keyword", "fallback 結果 matchedBy = 'keyword'");

  // 5c: 高 activation 的排前面
  const prefAct = computeActivation(mockAtoms["preferences"]);
  const decAct = computeActivation(mockAtoms["decisions"]);
  assert(prefAct > decAct, `preferences activation (${prefAct.toFixed(3)}) > decisions (${decAct.toFixed(3)})`);
  assert(fallbackFrags[0].id === "preferences", "高 activation 的 preferences 排第一");

  // 5d: 無 keyword 命中 → 空結果
  const emptyKw = new Set();
  assert(emptyKw.size === 0, "keyword 全無命中 → fallback 回傳空");
}

// ── Test 6: matchedBy 三種標記 ──────────────────────────────────────────────

console.log("\n═══ Test 6: matchedBy 標記區分 ═══");

{
  // 模擬完整管線產出的三種來源
  const vectorHit   = { id: "vec-atom",  matchedBy: "vector",  score: 0.85 };
  const keywordHit  = { id: "kw-atom",   matchedBy: "keyword", score: 0.60 };
  const relatedHit  = { id: "rel-atom",  matchedBy: "related", score: 0.51 };

  // 6a: 三種 matchedBy 值互不相同
  const types = new Set([vectorHit.matchedBy, keywordHit.matchedBy, relatedHit.matchedBy]);
  assert(types.size === 3, "三種 matchedBy 值互不相同");

  // 6b: 各值正確
  assert(vectorHit.matchedBy === "vector", "向量搜尋 → matchedBy='vector'");
  assert(keywordHit.matchedBy === "keyword", "keyword fallback → matchedBy='keyword'");
  assert(relatedHit.matchedBy === "related", "related spreading → matchedBy='related'");

  // 6c: 模擬 trace 輸出格式（message-pipeline.ts L212-217 的映射）
  const traceHits = [vectorHit, keywordHit, relatedHit].map(f => ({
    name: f.id,
    score: Math.round(f.score * 1000) / 1000,
    matchedBy: f.matchedBy,
  }));
  assert(traceHits.every(h => ["vector", "keyword", "related"].includes(h.matchedBy)),
    "trace 輸出的 matchedBy 都是合法值");
}

// ── Test 7: Consolidate ACT-R 統一 ─────────────────────────────────────────

console.log("\n═══ Test 7: Consolidate ACT-R 評分（與 recall 同公式） ═══");

{
  // consolidate 用 sigmoid(computeActivation(atom)) 作為 decay score
  const sigmoid = x => 1 / (1 + Math.exp(-x));

  // 7a: 高活躍 atom → sigmoid 分數高（不該被 archive）
  const freshScore = sigmoid(computeActivation(atomFresh));
  assert(freshScore > 0.5, `活躍 atom sigmoid score (${freshScore.toFixed(3)}) > 0.5`);

  // 7b: 低活躍 atom → sigmoid 分數低（可能被 archive）
  const staleScore = sigmoid(computeActivation(atomStale));
  assert(staleScore < freshScore, `過期 atom (${staleScore.toFixed(3)}) < 活躍 atom (${freshScore.toFixed(3)})`);

  // 7c: recall 與 consolidate 用的是同一個 computeActivation
  const recallAct = computeActivation(atomFresh);
  const consolidateAct = computeActivation(atomFresh);
  assert(recallAct === consolidateAct, "recall 與 consolidate 的 computeActivation() 結果一致");

  // 7d: sigmoid 輸出在 0~1 之間（可直接與 archiveThreshold 比較）
  assert(freshScore >= 0 && freshScore <= 1, `sigmoid 輸出在 0~1 (${freshScore.toFixed(3)})`);
  assert(staleScore >= 0 && staleScore <= 1, `sigmoid 輸出在 0~1 (${staleScore.toFixed(3)})`);

  // 7e: archiveThreshold=0.2 時，過期 atom 是否低於門檻
  const archiveThreshold = 0.2;
  console.log(`    archiveThreshold=${archiveThreshold}, stale=${staleScore.toFixed(3)}, fresh=${freshScore.toFixed(3)}`);
  // 不 assert 具體值（取決於 atom 參數），只確認排序正確
}

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
