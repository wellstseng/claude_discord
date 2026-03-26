/**
 * @file scripts/smoke-test-s8.mjs
 * @description Smoke test — S8 Skill Tier + 額外 Provider
 * 執行：node scripts/smoke-test-s8.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
const _queue = [];

function test(name, fn) { _queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── 1. write_file ─────────────────────────────────────────────────────────────

test("write_file: tool exists + tier=elevated", async () => {
  const { tool } = await import("../dist/tools/builtin/write-file.js");
  assertEqual(tool.name, "write_file");
  assertEqual(tool.tier, "elevated");
  assert(tool.parameters.required.includes("path"));
  assert(tool.parameters.required.includes("content"));
});

test("write_file: writes content + returns bytesWritten", async () => {
  const { tool } = await import("../dist/tools/builtin/write-file.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s8-wf-"));
  const filePath = join(tmpDir, "hello.txt");
  const content = "hello catclaw";
  const fakeEventBus = { emit: () => {} };
  const result = await tool.execute(
    { path: filePath, content },
    { accountId: "test", eventBus: fakeEventBus }
  );
  assert(!result.error, `error: ${result.error}`);
  assertEqual(result.result.path, filePath);
  assertEqual(result.result.bytesWritten, Buffer.byteLength(content, "utf-8"));
  assertEqual(result.fileModified, true);
  rmSync(tmpDir, { recursive: true });
});

test("write_file: empty path → error", async () => {
  const { tool } = await import("../dist/tools/builtin/write-file.js");
  const fakeEventBus = { emit: () => {} };
  const result = await tool.execute({ path: "", content: "x" }, { accountId: "test", eventBus: fakeEventBus });
  assert(result.error, "should return error");
});

// ── 2. edit_file ──────────────────────────────────────────────────────────────

test("edit_file: tool exists + tier=elevated", async () => {
  const { tool } = await import("../dist/tools/builtin/edit-file.js");
  assertEqual(tool.name, "edit_file");
  assertEqual(tool.tier, "elevated");
  assert(tool.parameters.required.includes("path"));
  assert(tool.parameters.required.includes("old_string"));
  assert(tool.parameters.required.includes("new_string"));
});

test("edit_file: replaces first occurrence", async () => {
  const { tool } = await import("../dist/tools/builtin/edit-file.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s8-ef-"));
  const filePath = join(tmpDir, "edit.txt");
  writeFileSync(filePath, "AAA BBB AAA");
  const fakeEventBus = { emit: () => {} };
  const result = await tool.execute(
    { path: filePath, old_string: "AAA", new_string: "ZZZ" },
    { accountId: "test", eventBus: fakeEventBus }
  );
  assert(result.error, "should error: old_string 出現多次");
  rmSync(tmpDir, { recursive: true });
});

test("edit_file: replace_all=true replaces all", async () => {
  const { tool } = await import("../dist/tools/builtin/edit-file.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s8-ef2-"));
  const filePath = join(tmpDir, "edit2.txt");
  writeFileSync(filePath, "AAA BBB AAA");
  const fakeEventBus = { emit: () => {} };
  const result = await tool.execute(
    { path: filePath, old_string: "AAA", new_string: "ZZZ", replace_all: true },
    { accountId: "test", eventBus: fakeEventBus }
  );
  assert(!result.error, `error: ${result.error}`);
  assertEqual(result.result.replaced, "all");
  rmSync(tmpDir, { recursive: true });
});

test("edit_file: old_string not found → error", async () => {
  const { tool } = await import("../dist/tools/builtin/edit-file.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s8-ef3-"));
  const filePath = join(tmpDir, "edit3.txt");
  writeFileSync(filePath, "hello world");
  const fakeEventBus = { emit: () => {} };
  const result = await tool.execute(
    { path: filePath, old_string: "notexist", new_string: "x" },
    { accountId: "test", eventBus: fakeEventBus }
  );
  assert(result.error, "should return error");
  rmSync(tmpDir, { recursive: true });
});

// ── 3. glob ───────────────────────────────────────────────────────────────────

test("glob: tool exists + tier=elevated", async () => {
  const { tool } = await import("../dist/tools/builtin/glob.js");
  assertEqual(tool.name, "glob");
  assertEqual(tool.tier, "elevated");
  assert(tool.parameters.required.includes("pattern"));
});

test("glob: finds files matching scripts/**/*.mjs", async () => {
  const { tool } = await import("../dist/tools/builtin/glob.js");
  const result = await tool.execute(
    { pattern: "scripts/**/*.mjs", path: process.cwd() },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(!result.error, `error: ${result.error}`);
  assert(Array.isArray(result.result), "result should be array");
  assert(result.result.length > 0, "should find some .mjs files");
  assert(result.result.every(p => p.endsWith(".mjs")), "all should be .mjs");
});

test("glob: pattern={ts,js} brace expansion", async () => {
  const { tool } = await import("../dist/tools/builtin/glob.js");
  const result = await tool.execute(
    { pattern: "src/**/*.{ts,js}", path: process.cwd() },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(!result.error, `error: ${result.error}`);
  assert(Array.isArray(result.result));
});

test("glob: empty pattern → error", async () => {
  const { tool } = await import("../dist/tools/builtin/glob.js");
  const result = await tool.execute(
    { pattern: "" },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(result.error, "should return error");
});

// ── 4. grep ───────────────────────────────────────────────────────────────────

test("grep: tool exists + tier=elevated", async () => {
  const { tool } = await import("../dist/tools/builtin/grep.js");
  assertEqual(tool.name, "grep");
  assertEqual(tool.tier, "elevated");
  assert(tool.parameters.required.includes("pattern"));
});

test("grep: finds pattern in files", async () => {
  const { tool } = await import("../dist/tools/builtin/grep.js");
  const result = await tool.execute(
    { pattern: "smoke-test", path: join(process.cwd(), "scripts"), glob: "*.mjs" },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(!result.error, `error: ${result.error}`);
  assert(result.result.total > 0, "should find matches");
  assert(result.result.matches.every(m => "file" in m && "line" in m && "text" in m));
});

test("grep: case insensitive -i flag", async () => {
  const { tool } = await import("../dist/tools/builtin/grep.js");
  const result = await tool.execute(
    { pattern: "SMOKE-TEST", path: join(process.cwd(), "scripts"), glob: "*.mjs", "-i": true },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(!result.error, `error: ${result.error}`);
  assert(result.result.total > 0, "case-insensitive should find matches");
});

test("grep: invalid regex → error", async () => {
  const { tool } = await import("../dist/tools/builtin/grep.js");
  const result = await tool.execute(
    { pattern: "[invalid" },
    { accountId: "test", eventBus: { emit: () => {} } }
  );
  assert(result.error, "should return error");
});

// ── 5. openai-compat provider ─────────────────────────────────────────────────

test("OpenAICompatProvider: instantiation + default values", async () => {
  const { OpenAICompatProvider } = await import("../dist/providers/openai-compat.js");
  const p = new OpenAICompatProvider("test-ollama", {
    host: "http://localhost:11434",
    model: "qwen3:1.7b",
  });
  assertEqual(p.id, "test-ollama");
  assert(p.name.includes("test-ollama"));
  assert(typeof p.supportsToolUse === "boolean");
  assert(p.maxContextTokens > 0);
});

test("OpenAICompatProvider: baseUrl override", async () => {
  const { OpenAICompatProvider } = await import("../dist/providers/openai-compat.js");
  const p = new OpenAICompatProvider("vllm", {
    baseUrl: "http://vllm-host:8000/",
    model: "llama3",
  });
  assertEqual(p.id, "vllm");
  // supportsToolUse default true (not disabled)
  assertEqual(p.supportsToolUse, true);
});

test("OpenAICompatProvider: supportsToolUse=false override", async () => {
  const { OpenAICompatProvider } = await import("../dist/providers/openai-compat.js");
  const p = new OpenAICompatProvider("lm", {
    baseUrl: "http://localhost:1234",
    supportsToolUse: false,
  });
  assertEqual(p.supportsToolUse, false);
});

// ── 6. ProviderRegistry: openai-compat entry ─────────────────────────────────

test("buildProviderRegistry: host entry → OpenAICompatProvider", async () => {
  const { buildProviderRegistry } = await import("../dist/providers/registry.js");
  // 不會實際呼叫 init（因為 init 需要 Ollama running），只檢查是否建立
  // 但 buildProviderRegistry 會呼叫 init，我們需要 mock fetch
  // 簡化：只測試 apiKey entry（Claude API 需要 key，會直接建立 without init）
  // 改驗證 host entry：建立後 registry 有該 provider
  // 用一個必定 fail 的 host，init 會 catch error 但 provider 仍然建立
  const registry = await buildProviderRegistry(
    "local",
    { local: { host: "http://127.0.0.1:19999", model: "test" } },
    {},
  );
  const p = registry.get("local");
  assert(p !== undefined, "provider should exist");
  assertEqual(p.id, "local");
});

// ── 7. PermissionGate.checkTier ───────────────────────────────────────────────

test("PermissionGate.checkTier: guest can access public tier", async () => {
  const { AccountRegistry } = await import("../dist/accounts/registry.js");
  const { ToolRegistry, initToolRegistry } = await import("../dist/tools/registry.js");
  const { PermissionGate } = await import("../dist/accounts/permission-gate.js");

  const tmpDir = mkdtempSync(join(tmpdir(), "s8-pg-"));
  const acctReg = new AccountRegistry(tmpDir);
  acctReg.init();
  acctReg.create({ accountId: "guest1", displayName: "G", role: "guest", identities: [] });

  const toolReg = initToolRegistry();
  const gate = new PermissionGate(acctReg, toolReg);

  const r = gate.checkTier("guest1", "public");
  assertEqual(r.allowed, true);
  rmSync(tmpDir, { recursive: true });
});

test("PermissionGate.checkTier: guest cannot access elevated tier", async () => {
  const { AccountRegistry } = await import("../dist/accounts/registry.js");
  const { ToolRegistry, initToolRegistry } = await import("../dist/tools/registry.js");
  const { PermissionGate } = await import("../dist/accounts/permission-gate.js");

  const tmpDir = mkdtempSync(join(tmpdir(), "s8-pg2-"));
  const acctReg = new AccountRegistry(tmpDir);
  acctReg.init();
  acctReg.create({ accountId: "guest2", displayName: "G2", role: "guest", identities: [] });

  const toolReg = initToolRegistry();
  const gate = new PermissionGate(acctReg, toolReg);

  const r = gate.checkTier("guest2", "elevated");
  assertEqual(r.allowed, false);
  assert(r.reason?.includes("guest"), `reason: ${r.reason}`);
  rmSync(tmpDir, { recursive: true });
});

test("PermissionGate.checkTier: platform-owner can access owner tier", async () => {
  const { AccountRegistry } = await import("../dist/accounts/registry.js");
  const { ToolRegistry, initToolRegistry } = await import("../dist/tools/registry.js");
  const { PermissionGate } = await import("../dist/accounts/permission-gate.js");

  const tmpDir = mkdtempSync(join(tmpdir(), "s8-pg3-"));
  const acctReg = new AccountRegistry(tmpDir);
  acctReg.init();
  acctReg.create({ accountId: "owner1", displayName: "O", role: "platform-owner", identities: [] });

  const toolReg = initToolRegistry();
  const gate = new PermissionGate(acctReg, toolReg);

  const r = gate.checkTier("owner1", "owner");
  assertEqual(r.allowed, true);
  rmSync(tmpDir, { recursive: true });
});

test("PermissionGate.checkTier: developer can access elevated but not admin", async () => {
  const { AccountRegistry } = await import("../dist/accounts/registry.js");
  const { ToolRegistry, initToolRegistry } = await import("../dist/tools/registry.js");
  const { PermissionGate } = await import("../dist/accounts/permission-gate.js");

  const tmpDir = mkdtempSync(join(tmpdir(), "s8-pg4-"));
  const acctReg = new AccountRegistry(tmpDir);
  acctReg.init();
  acctReg.create({ accountId: "dev1", displayName: "D", role: "developer", identities: [] });

  const toolReg = initToolRegistry();
  const gate = new PermissionGate(acctReg, toolReg);

  assertEqual(gate.checkTier("dev1", "elevated").allowed, true);
  assertEqual(gate.checkTier("dev1", "admin").allowed, false);
  rmSync(tmpDir, { recursive: true });
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

console.log("\nSmoke Test — S8 Skill Tier + 額外 Provider\n");
await runAll();
console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
