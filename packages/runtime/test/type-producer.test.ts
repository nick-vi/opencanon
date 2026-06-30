import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createTypeProducerRuntime, typescriptResolvableFrom } from "../src/type-producer/runtime.ts";
import { LiveTypeProducerProvider } from "../src/type-producer/live-provider.ts";
import type { TypeProducerRuntime } from "../src/type-producer/runtime.ts";

const producerMainPath = fileURLToPath(new URL("../src/type-producer/producer-main.ts", import.meta.url));
const producerTestTimeoutMs = 120_000;
const producerRequestTimeoutMs = 90_000;
const producerReadinessTimeoutMs = 90_000;

function typescriptAvailable(): boolean {
  try {
    require.resolve("typescript");
    return true;
  } catch {
    return false;
  }
}

// A tiny fixture: a comparison `mode === "fast"` where `mode` is typed as a
// string-literal union, so the producer should resolve a non-`string` type.
function makeFixture(): { rootDir: string; cleanup: () => void } {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-type-producer-"));
  writeFileSync(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "esnext", moduleResolution: "bundler" }, include: ["src"] }, null, 2),
  );
  // src/sample.ts: line 2 has the comparison; the literal "fast" is the producer site.
  const source = [
    'export function pick(mode: "fast" | "slow"): boolean {',
    '  return mode === "fast";',
    "}",
    "",
  ].join("\n");
  const srcDir = path.join(rootDir, "src");
  require("node:fs").mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "sample.ts"), source);
  return { rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

function writeFakeProducer(rootDir: string, source: string): string {
  const producerPath = path.join(rootDir, "fake-producer.mjs");
  writeFileSync(producerPath, source);
  return producerPath;
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  (process.stderr.write as unknown as (chunk: unknown, ...args: unknown[]) => boolean) = (chunk: unknown, ...args: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return original(chunk as string | Uint8Array, ...(args as []));
  };
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = original as typeof process.stderr.write;
  }
}

// Locate the StringLiteral "fast" position (1-based line/column) in the fixture.
// Line 2 (`  return mode === "fast";`): the literal starts at column 19 (1-based).
const FIXTURE_SITE = { file: "src/sample.ts", line: 2, column: 19 };

test("producer-main resolves a comparison site's type", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const child = spawn(process.execPath, [producerMainPath, "--tsconfig", path.join(rootDir, "tsconfig.json"), "--root", rootDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rl = readline.createInterface({ input: child.stdout! });
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("producer did not respond")), producerReadinessTimeoutMs);
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const message = JSON.parse(trimmed);
          if (message.id === 1) {
            clearTimeout(timer);
            resolve(message);
          }
        } catch {
          // ignore non-JSON
        }
      });
      child.on("exit", () => reject(new Error("producer exited early")));
      child.stdin!.write(`${JSON.stringify({ id: 1, method: "resolveTypes", sites: [FIXTURE_SITE] })}\n`);
    });
    assert.ok(response.result, "expected a result");
    const resolutions = response.result.resolutions as Array<{
      key: string;
      display: string;
      kind: string;
      members?: Array<{ value?: { kind: string; value?: string } }>;
    }>;
    assert.equal(resolutions.length, 1, "expected one resolved site");
    assert.equal(resolutions[0].key, `${FIXTURE_SITE.file}:${FIXTURE_SITE.line}:${FIXTURE_SITE.column}`);
    assert.match(resolutions[0].display, /fast|slow/, "expected the union type, not plain string");
    assert.equal(resolutions[0].kind, "literal-union", "string-literal union → literal-union");
    const values = (resolutions[0].members ?? []).map((m) => m.value?.value).sort();
    assert.deepEqual(values, ["fast", "slow"], "members enumerate the union arms");
  } finally {
    child.stdin!.write(`${JSON.stringify({ id: 2, method: "shutdown" })}\n`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    cleanup();
  }
});

test("TypeProducerRuntime lazy-spawns, answers a query, and shuts down on idle", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 3000,
    requestTimeoutMs: producerRequestTimeoutMs,
  });
  try {
    assert.equal(runtime.isRunning(), false, "should not spawn on construct");
    const { resolutions, generation } = await runtime.query([FIXTURE_SITE]);
    assert.equal(runtime.isRunning(), true, "first query should lazy-spawn");
    assert.equal(resolutions.length, 1, "expected one resolution");
    assert.match(resolutions[0].display, /fast|slow/);
    assert.equal(resolutions[0].kind, "literal-union");
    // The response carries the generation the facts were computed from.
    assert.equal(typeof generation, "number", "resolveTypes response carries a generation");
    assert.ok((generation ?? 0) >= 1, "generation advanced to at least 1 after the first build");
    // Wait past the idle window (last reset at query time); child self-terminates.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(runtime.isRunning(), false, "idle timeout should kill the child");
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("TypeProducerRuntime warm lazy-spawns and waits for a ready generation", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 3000,
    requestTimeoutMs: producerRequestTimeoutMs,
    warmTimeoutMs: producerRequestTimeoutMs,
  });
  try {
    assert.equal(runtime.isRunning(), false, "should not spawn on construct");
    const status = await runtime.warm();
    assert.equal(runtime.isRunning(), true, "warm should lazy-spawn");
    assert.equal(status.kind, "ready", JSON.stringify(status));
    assert.ok((status.generation ?? 0) >= 1, "warm should wait for the first generation");
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(runtime.isRunning(), false, "idle timeout should still kill the warmed child");
    assert.equal(runtime.status().kind, "ready", "idle reap preserves the warmed ready status");
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("TypeProducerRuntime idle reap is a controlled shutdown, not a query failure", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 300,
    requestTimeoutMs: producerRequestTimeoutMs,
  });
  try {
    const { stderr } = await captureStderr(async () => {
      const { resolutions } = await runtime.query([FIXTURE_SITE]);
      assert.equal(resolutions.length, 1, "expected the warm query to resolve");
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    assert.equal(runtime.isRunning(), false, "idle timeout should reap the child");
    assert.equal(runtime.status().kind, "ready", "idle reap preserves the last good producer status");
    assert(!stderr.includes("query failed"), "controlled idle reap should not log a query failure");
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("TypeProducerRuntime stop cancels a pending query without marking the producer crashed", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const producerPath = writeFakeProducer(
    rootDir,
    [
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "setInterval(() => {}, 1000).unref();",
      "",
    ].join("\n"),
  );
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 10_000,
    requestTimeoutMs: producerRequestTimeoutMs,
    producerMainPath: producerPath,
  });
  try {
    const { result, stderr } = await captureStderr(async () => {
      const pending = runtime.query([FIXTURE_SITE]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.stop();
      return await pending;
    });
    assert.deepEqual(result.resolutions, [], "controlled stop returns no facts");
    assert.notEqual(runtime.status().kind, "crashed", "runtime stop is not a producer crash");
    assert(!stderr.includes("query failed"), "controlled runtime stop should not log a query failure");
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("TypeProducerRuntime timeout is explicit crash state and does not leave the producer running", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const producerPath = writeFakeProducer(
    rootDir,
    [
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 10_000,
    requestTimeoutMs: 50,
    producerMainPath: producerPath,
  });
  try {
    const { resolutions } = await runtime.query([FIXTURE_SITE]);
    assert.deepEqual(resolutions, [], "timed-out producer returns no facts");
    assert.equal(runtime.isRunning(), false, "timed-out producer is killed");
    const status = runtime.status();
    assert.equal(status.kind, "crashed");
    assert.match(status.detail ?? "", /timed out/);
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("TypeProducerRuntime handles early producer exit without uncaught pipe errors", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const producerPath = writeFakeProducer(rootDir, "process.exit(0);\n");
  const runtime: TypeProducerRuntime = createTypeProducerRuntime({
    rootDir,
    tsconfigPath: path.join(rootDir, "tsconfig.json"),
    idleTimeoutMs: 10_000,
    requestTimeoutMs: producerRequestTimeoutMs,
    producerMainPath: producerPath,
  });
  try {
    const { resolutions } = await runtime.query([FIXTURE_SITE]);
    assert.deepEqual(resolutions, [], "early exit returns no facts");
    const status = runtime.status();
    assert.equal(status.kind, "crashed");
    assert.match(status.detail ?? "", /exited unexpectedly|stdin closed|EPIPE/);
  } finally {
    await runtime.stop();
    cleanup();
  }
});

test("typescriptResolvableFrom resolves TypeScript from an ESM runtime module", (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  assert.equal(typescriptResolvableFrom(process.cwd()), true);
});

test("C1: producer spawned against this repo answers status ready:true", { timeout: producerTestTimeoutMs }, async (ctx) => {
  // Resolve typescript from THIS repo's root (the target), mirroring how the
  // runtime resolves it. Skip when unresolvable.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  let tsconfig: string;
  try {
    require.resolve("typescript", { paths: [repoRoot, process.cwd()] });
    tsconfig = path.join(repoRoot, "tsconfig.json");
  } catch {
    return ctx.skip();
  }
  const child = spawn(process.execPath, [producerMainPath, "--tsconfig", tsconfig, "--root", repoRoot], {
    stdio: ["pipe", "pipe", "pipe"],
    // Mirror the runtime: child cwd is the root, resolution cwd passed explicitly.
    cwd: repoRoot,
    env: { ...process.env, OPENCANON_RESOLVE_CWD: process.cwd() },
  });
  try {
    const rl = readline.createInterface({ input: child.stdout! });
    const ready = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no status response")), producerReadinessTimeoutMs);
      const poll = setInterval(() => child.stdin!.write(`${JSON.stringify({ id: 1, method: "status" })}\n`), 1000);
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const message = JSON.parse(trimmed);
          if (message.id === 1 && message.result?.ready === true) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(true);
          }
        } catch {
          // ignore
        }
      });
      child.on("exit", (code) => {
        clearInterval(poll);
        reject(new Error(`producer exited early (code ${code})`));
      });
    });
    assert.equal(ready, true, "status should report ready:true once the program is built");
  } finally {
    child.kill();
  }
});

test("C2: producer exits shortly after its stdin closes (no orphan)", { timeout: producerTestTimeoutMs }, async (ctx) => {
  if (!typescriptAvailable()) return ctx.skip();
  const { rootDir, cleanup } = makeFixture();
  const child = spawn(process.execPath, [producerMainPath, "--tsconfig", path.join(rootDir, "tsconfig.json"), "--root", rootDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCANON_RESOLVE_CWD: process.cwd() },
  });
  try {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      // Close the child's stdin (simulates the runtime dying / pipe closing).
      child.stdin!.end();
    });
    assert.equal(exited, true, "producer should self-exit within a couple seconds of stdin close");
  } finally {
    child.kill();
    cleanup();
  }
});

test("LiveTypeProducerProvider returns empty (not throw) when producer unavailable", async () => {
  // A runtime whose query always degrades to [] (simulates unavailable producer).
  const stub: TypeProducerRuntime = {
    async query() {
      return { resolutions: [] };
    },
    async warm() {
      return this.status();
    },
    status() {
      return { language: "typescript", kind: "ready" };
    },
    onReady() {},
    async stop() {},
    isRunning() {
      return false;
    },
  };
  const provider = new LiveTypeProducerProvider(stub);
  const map = await provider.resolveTypes([{ file: "src/x.ts", line: 1, column: 1 }]);
  assert.equal(map.size, 0);

  // Also verify a throwing runtime is swallowed.
  const throwing: TypeProducerRuntime = {
    async query(): Promise<never> {
      throw new Error("boom");
    },
    async warm() {
      return this.status();
    },
    status() {
      return { language: "typescript", kind: "crashed", detail: "boom" };
    },
    onReady() {},
    async stop() {},
    isRunning() {
      return false;
    },
  };
  const map2 = await new LiveTypeProducerProvider(throwing).resolveTypes([{ file: "src/x.ts", line: 1, column: 1 }]);
  assert.equal(map2.size, 0);
});

test("M2: LiveTypeProducerProvider skips an unkeyed resolution instead of guessing sites[0] (no multi-site map corruption)", async () => {
  // A runtime that returns one keyed and one unkeyed literal-union resolution for
  // a two-site query. The unkeyed one must be dropped, not pinned onto sites[0].
  const sites = [
    { file: "src/a.ts", line: 1, column: 1 },
    { file: "src/b.ts", line: 2, column: 3 },
  ];
  const keyB = `${sites[1].file}:${sites[1].line}:${sites[1].column}`;
  const stub = {
    async query() {
      return {
        resolutions: [
          // Valid keyed resolution for site b.
          { key: keyB, display: "p | q", kind: "literal-union", members: [], typeSource: "checker" },
          // Unkeyed resolution — must be skipped, NOT mapped to sites[0].
          { key: "", display: "x | y", kind: "literal-union", members: [], typeSource: "checker" },
        ],
        generation: 1,
      };
    },
    status() {
      return { language: "typescript", kind: "ready" } as const;
    },
    async stop() {},
    isRunning() {
      return true;
    },
  } as unknown as TypeProducerRuntime;

  const map = await new LiveTypeProducerProvider(stub).resolveTypes(sites);
  assert.equal(map.size, 1, "only the keyed resolution surfaces");
  assert.ok(map.has(keyB), "the keyed resolution is mapped to its own site");
  assert.equal(map.has(`${sites[0].file}:${sites[0].line}:${sites[0].column}`), false, "sites[0] is never corrupted by an unkeyed guess");
});
