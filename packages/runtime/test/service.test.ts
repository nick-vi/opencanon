import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  runtimeAuthHeaders,
  ServiceActionId,
  ServiceEffectKind,
  ServiceProjectStatusValue,
  buildServiceOverview,
  LocalTransportKind,
  localPipeEndpoint,
  localProtocolTransport,
  discoverOpenCanonProject,
  discoverOpenCanonProjectsFromRoots,
  ProcessLifecycleStatus,
  ProcessLifecycleEventKind,
  RuntimeCliInvocationKind,
  chooseRuntimePort,
  inspectAllRuntimes,
  inspectRuntimeEntry,
  LocalControlProtocolVersion,
  acquireProjectWorkerLease,
  readRuntimeLifecycleEvents,
  readRuntimeRegistry,
  readRuntimeRegistryDiagnostics,
  readProjectWorkerLease,
  readServiceEntry,
  repairServiceProcessState,
  projectWorkerLeasePath,
  reconcileProjectRuntimes,
  forgetRuntimeEntry,
  forgetRuntimeEntryForPid,
  forgetServiceEntryForPid,
  forgetServiceEntry,
  renderLifecycleEventsMarkdown,
  renderRuntimeListMarkdown,
  renderRuntimeStatusMarkdown,
  renderServiceStatusMarkdown,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  startProjectRuntime,
  startService,
  startServiceServer,
  stopService,
  stopProjectRuntime,
  waitForProjectRuntimeReady,
  upsertRuntimeEntry,
  upsertServiceEntry,
  writeRuntimeRegistry,
} from "@opencanon/runtime";
import { createAuthoringProject } from "./support.ts";

const testRuntimeIdentity = {
  transport: LocalTransportKind.Pipe,
  protocolVersion: LocalControlProtocolVersion,
  runtimeVersion: "0.4.0-test",
  runtimeFingerprint: "sha256:test-runtime",
  cliPath: process.execPath,
};

function testLifecycle(status: ProcessLifecycleStatus = ProcessLifecycleStatus.Running) {
  return {
    status,
    updatedAt: "2026-05-01T00:00:00.000Z",
    restart: { attempts: 0 },
  };
}

function testRuntimeLease(leaseId = "test-runtime-lease") {
  return {
    leaseId,
    lifecycle: testLifecycle(),
  };
}

function testServiceLease(leaseId = "test-service-lease") {
  return {
    leaseId,
    lifecycle: testLifecycle(),
  };
}

function testRuntimePipeEndpoint(rootDir: string, registryPath: string): string {
  return localPipeEndpoint({ scope: "runtime", key: `${registryPath}:${rootDir}` });
}

function testStartupLockPath(registryPath: string, kind: "service" | "runtime", key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(path.dirname(registryPath), `opencanon-${kind}-${hash}.start.lock`);
}

function writeStartupLock(registryPath: string, kind: "service" | "runtime", key: string, pid: number): string {
  const lockPath = testStartupLockPath(registryPath, kind, key);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(lockPath, JSON.stringify({ pid, scope: `opencanon-${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, startedAt: now, heartbeatAt: now }, null, 2));
  return lockPath;
}

function testServicePipeEndpoint(registryPath: string): string {
  return localPipeEndpoint({ scope: "service", key: registryPath });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilProcessStops(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsRunning(pid);
}

async function waitForSpawnedPid(child: ReturnType<typeof spawn>, description: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      if (child.pid) resolve(child.pid);
      else reject(new Error(`${description} started without a pid.`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function writeProjectWorkerLease(rootDir: string, pid: number, leaseId = "test-worker-lease"): void {
  const lockPath = projectWorkerLeasePath(rootDir);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(lockPath, JSON.stringify({ rootDir, pid, leaseId, acquiredAt: now, heartbeatAt: now }, null, 2));
}

function readyFakeServiceCliSource(options: { exitOnceMarkerPath?: string; pidPathEnv?: string } = {}): string {
  return [
    'import { createServer } from "node:http";',
    'import net from "node:net";',
    `import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";`,
    'import path from "node:path";',
    ...(options.exitOnceMarkerPath
      ? [
          `const exitOnceMarkerPath = ${JSON.stringify(options.exitOnceMarkerPath)};`,
          "if (!existsSync(exitOnceMarkerPath)) {",
          "  writeFileSync(exitOnceMarkerPath, String(process.pid));",
          "  process.exit(12);",
          "}",
        ]
      : []),
    ...(options.pidPathEnv ? [`writeFileSync(process.env["${options.pidPathEnv}"], String(process.pid));`] : []),
    'const portArg = process.argv.indexOf("--port");',
    'const hostArg = process.argv.indexOf("--host");',
    "const port = Number(process.argv[portArg + 1]);",
    'const host = hostArg >= 0 ? process.argv[hostArg + 1] : "127.0.0.1";',
    "const pipeEndpoint = process.env.OPENCANON_SERVICE_PIPE_ENDPOINT;",
    "const ready = { ok: true, data: { status: 'ready', protocolVersion: 1, runtimeVersion: '0.4.0-test', process: { kind: 'service', pid: process.pid, leaseId: process.env.OPENCANON_SERVICE_LEASE_ID } } };",
    "createServer((_request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });',
    "  response.end(JSON.stringify(ready));",
    "}).listen(port, host);",
    "if (pipeEndpoint) {",
    "  if (process.platform !== 'win32') { mkdirSync(path.dirname(pipeEndpoint), { recursive: true }); rmSync(pipeEndpoint, { force: true }); }",
    "  net.createServer((socket) => {",
    "    let buffer = '';",
    "    socket.on('data', (chunk) => {",
    "      buffer += chunk.toString('utf8');",
    "      if (!buffer.includes('\\n')) return;",
    "      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));",
    "      socket.end(JSON.stringify({ protocol: 'opencanon.local.v1', id: request.id, status: 200, statusText: 'OK', body: ready }) + '\\n');",
    "    });",
    "  }).listen(pipeEndpoint);",
    "}",
    "",
  ].join("\n");
}

function readyFakeRuntimeCliSource(options: { exitOnceMarkerPath?: string; pidPathEnv?: string } = {}): string {
  return [
    'import { createServer } from "node:http";',
    'import net from "node:net";',
    `import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";`,
    'import path from "node:path";',
    ...(options.exitOnceMarkerPath
      ? [
          `const exitOnceMarkerPath = ${JSON.stringify(options.exitOnceMarkerPath)};`,
          "if (!existsSync(exitOnceMarkerPath)) {",
          "  writeFileSync(exitOnceMarkerPath, String(process.pid));",
          "  process.exit(12);",
          "}",
        ]
      : []),
    ...(options.pidPathEnv ? [`writeFileSync(process.env["${options.pidPathEnv}"], String(process.pid));`] : []),
    'const portArg = process.argv.indexOf("--port");',
    'const hostArg = process.argv.indexOf("--host");',
    "const port = Number(process.argv[portArg + 1]);",
    'const host = hostArg >= 0 ? process.argv[hostArg + 1] : "127.0.0.1";',
    "const pipeEndpoint = process.env.OPENCANON_RUNTIME_PIPE_ENDPOINT;",
    "const health = { ok: true, data: { status: 'stale', process: { kind: 'runtime', pid: process.pid, leaseId: process.env.OPENCANON_RUNTIME_LEASE_ID }, engine: { engineVersion: '0.4.0-test', packageVersion: '0.4.0-test', napiVersion: 'test', schemaVersion: 1 }, refresh: { status: 'stale', mode: 'manual', bufferedEvents: 0, reason: 'File watching is not running; manual refresh is required.' }, startedAt: new Date().toISOString() } };",
    "createServer((_request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });',
    "  response.end(JSON.stringify(health));",
    "}).listen(port, host);",
    "if (pipeEndpoint) {",
    "  if (process.platform !== 'win32') { mkdirSync(path.dirname(pipeEndpoint), { recursive: true }); rmSync(pipeEndpoint, { force: true }); }",
    "  net.createServer((socket) => {",
    "    let buffer = '';",
    "    socket.on('data', (chunk) => {",
    "      buffer += chunk.toString('utf8');",
    "      if (!buffer.includes('\\n')) return;",
    "      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));",
    "      socket.end(JSON.stringify({ protocol: 'opencanon.local.v1', id: request.id, status: 200, statusText: 'OK', body: health }) + '\\n');",
    "    });",
    "  }).listen(pipeEndpoint);",
    "}",
    "",
  ].join("\n");
}

test("runtime CLI resolution ignores project-local runtime paths", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-cli-resolution-"));
  const originalOverride = process.env.OPENCANON_CLI;
  const originalArgv1 = process.argv[1];
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const localBinDir = path.join(rootDir, "node_modules", ".bin");
    mkdirSync(localBinDir, { recursive: true });
    const localBin = path.join(localBinDir, "opencanon");
    writeFileSync(localBin, "#!/usr/bin/env node\nconsole.log('local');\n");
    const override = path.join(rootDir, "override.mjs");
    writeFileSync(override, "export const override = true;\n");

    process.env.OPENCANON_CLI = override;
    let resolved = resolveRuntimeCliEntrypoint(rootDir);
    assert.equal(resolved.path, realpathSync(override));
    assert.equal(resolved.kind, RuntimeCliInvocationKind.NodeScript);
    assert.equal(resolved.source, "env");

    delete process.env.OPENCANON_CLI;
    const installedRuntimeDir = path.join(rootDir, "installed-runtime");
    const installedRuntimeCli = path.join(installedRuntimeDir, "cli.js");
    mkdirSync(installedRuntimeDir, { recursive: true });
    writeFileSync(installedRuntimeCli, "#!/usr/bin/env node\nconsole.log('runtime');\n");
    writeFileSync(path.join(installedRuntimeDir, "runtime.js"), "export const runtime = true;\n");
    writeFileSync(path.join(installedRuntimeDir, "package.json"), JSON.stringify({ name: "opencanon", type: "module" }));
    process.argv[1] = installedRuntimeCli;
    resolved = resolveRuntimeCliEntrypoint(rootDir);
    assert.equal(resolved.path, realpathSync(installedRuntimeCli));
    assert.equal(resolved.source, "current-argv");
    process.argv[1] = originalArgv1;

    resolved = resolveRuntimeCliEntrypoint(rootDir);
    assert.notEqual(resolved.path, realpathSync(localBin));
    assert(["current-argv", "path", "dev-checkout"].includes(resolved.source));

    rmSync(localBin, { force: true });
    const skillScript = path.join(rootDir, ".agents", "skills", "opencanon", "scripts", "opencanon.mjs");
    const runtimeCli = path.join(rootDir, ".agents", "skills", "opencanon", "runtime", "cli.js");
    mkdirSync(path.dirname(skillScript), { recursive: true });
    mkdirSync(path.dirname(runtimeCli), { recursive: true });
    writeFileSync(skillScript, "export const script = true;\n");
    writeFileSync(runtimeCli, "export const runtime = true;\n");

    resolved = resolveRuntimeCliEntrypoint(rootDir);
    assert.notEqual(resolved.path, realpathSync(skillScript));
    assert.notEqual(resolved.path, realpathSync(runtimeCli));
  } finally {
    process.argv[1] = originalArgv1;
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime identity includes the invocation kind for node-script entrypoints", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-identity-"));
  try {
    const cli = path.join(rootDir, "opencanon.mjs");
    writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('runtime');\n");

    const nodeScript = runtimeIdentityForEntrypoint({
      path: realpathSync(cli),
      kind: RuntimeCliInvocationKind.NodeScript,
      source: "test",
    });
    const executable = runtimeIdentityForEntrypoint({
      path: realpathSync(cli),
      kind: RuntimeCliInvocationKind.Executable,
      source: "test",
    });

    assert.notEqual(nodeScript.runtimeFingerprint, executable.runtimeFingerprint);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local protocol does not fall back from pipe to loopback", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-local-protocol-strict-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  let loopbackHit = false;
  const server = createServer((_request, response) => {
    loopbackHit = true;
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, data: { unexpected: true } }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      () => localProtocolTransport.request(
        {
          transport: LocalTransportKind.Pipe,
          pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
          url: `http://127.0.0.1:${port}`,
          authToken: "test-token",
        },
        { method: "GET", path: "/api/health", timeoutMs: 500 },
      ),
      /ENOENT|ECONNREFUSED|connect|pipe/i,
    );
    assert.equal(loopbackHit, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project runtime spawn failures do not register stale runtime entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-spawn-failure-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const originalOverride = process.env.OPENCANON_CLI;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const nonExecutableCli = path.join(rootDir, "opencanon-test-cli");
    writeFileSync(nonExecutableCli, "not executable\n");
    process.env.OPENCANON_CLI = nonExecutableCli;

    await assert.rejects(
      () => startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 }),
      /OpenCanon project runtime could not start/,
    );

    assert.deepEqual(readRuntimeRegistry(registryPath), []);
    const events = readRuntimeLifecycleEvents(registryPath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, ProcessLifecycleEventKind.RuntimeStartupFailed);
    assert(events[0]?.message?.includes("OpenCanon project runtime could not start"));
  } finally {
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project runtime retries auto-selected ports when the spawned runtime exits before health", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-auto-port-retry-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const exitOnceMarkerPath = path.join(rootDir, "first-runtime-exit.txt");
  const originalCli = process.env.OPENCANON_CLI;
  let pid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource({ exitOnceMarkerPath }));
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    pid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
    assert.equal(existsSync(exitOnceMarkerPath), true);
    const events = readRuntimeLifecycleEvents(registryPath);
    assert.equal(events.filter((event) => event.kind === ProcessLifecycleEventKind.RuntimeStartupFailed).length, 1);
    assert.equal(events.filter((event) => event.kind === ProcessLifecycleEventKind.RuntimeStarted).length, 2);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project runtime start steals startup locks owned by dead processes", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-dead-start-lock-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "ready-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let pid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;
    const lockPath = writeStartupLock(registryPath, "runtime", rootDir, 9_999_999);

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    pid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.equal(existsSync(lockPath), false);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project worker lease rejects a second active owner", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worker-lease-exclusive-"));
  let lease: ReturnType<typeof acquireProjectWorkerLease> | undefined;
  try {
    lease = acquireProjectWorkerLease({ rootDir, leaseId: "first-worker" });
    assert.equal(readProjectWorkerLease(rootDir)?.leaseId, "first-worker");
    assert.throws(
      () => acquireProjectWorkerLease({ rootDir, leaseId: "second-worker" }),
      /project worker is already running/i,
    );
  } finally {
    lease?.release();
    assert.equal(readProjectWorkerLease(rootDir), undefined);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project stop removes stale worker leases without a runtime registry entry", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worker-lease-stale-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeProjectWorkerLease(rootDir, 9_999_999, "stale-worker");

    const result = await stopProjectRuntime(rootDir, registryPath);

    assert.equal(result.status, "stale");
    assert.equal(readProjectWorkerLease(rootDir), undefined);
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
    const events = readRuntimeLifecycleEvents(registryPath);
    assert.equal(events.at(-1)?.kind, ProcessLifecycleEventKind.RuntimeStale);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project stop removes inactive startup locks without a runtime registry entry", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-start-lock-stale-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const lockPath = writeStartupLock(registryPath, "runtime", rootDir, 9_999_999);

    const result = await stopProjectRuntime(rootDir, registryPath);

    assert.equal(result.status, "stale");
    assert.match(result.message, /startup lock/);
    assert.equal(existsSync(lockPath), false);
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project start retires a live conflicting worker lease before spawning replacement", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worker-lease-conflict-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "ready-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  const conflicting = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  let conflictingPid: number | undefined;
  try {
    conflictingPid = await waitForSpawnedPid(conflicting, "conflicting worker");
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    writeProjectWorkerLease(rootDir, conflictingPid, "conflicting-worker");
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });

    assert.equal(started.status, "started");
    assert.equal(await waitUntilProcessStops(conflictingPid, 3000), true);
    assert.equal(readProjectWorkerLease(rootDir), undefined);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (conflictingPid && processIsRunning(conflictingPid)) conflicting.kill("SIGKILL");
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service ensure registers slow-starting runtimes without waiting for health", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-slow-start-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "slow-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, "setInterval(() => {}, 1000);\n");
    process.env.OPENCANON_CLI = fakeCliPath;
    server = await startServiceServer({ port: 0, registryPath, authToken: "service-token", reconcileIntervalMs: false });

    const startedAt = Date.now();
    const response = await fetch(`${server.url}/api/projects/ensure`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ rootDir }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert(Date.now() - startedAt < 2000);

    const payload = JSON.parse(text) as { data?: { project?: { entry?: { lifecycle?: { status?: string } } } } };
    assert.equal(payload.data?.project?.entry?.lifecycle?.status, ProcessLifecycleStatus.Starting);
    const entries = readRuntimeRegistry(registryPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.rootDir, rootDir);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    await server?.stop().catch(() => undefined);
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project runtime readiness wait resolves no-wait starts", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-ready-wait-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "ready-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, waitForReady: false, idleTimeoutMs: 0 });
    const ready = await waitForProjectRuntimeReady(rootDir, { registryPath, timeoutMs: 3000, intervalMs: 50 });

    assert.equal(started.status, "started");
    assert.equal(ready.status, "running");
    assert.equal(ready.entry.pid, started.entry.pid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project runtime readiness wait fails fast for stale registered state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-ready-stale-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const startedAt = new Date().toISOString();
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    const pid = await waitForSpawnedPid(child, "stale runtime");
    child.kill("SIGKILL");
    assert.equal(await waitUntilProcessStops(pid, 2000), true);

    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: await chooseRuntimePort({ host: "127.0.0.1" }),
      url: "http://127.0.0.1:4767",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid,
      startedAt,
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      leaseId: "stale-runtime-lease",
      lifecycle: testLifecycle(ProcessLifecycleStatus.Starting),
      ...testRuntimeIdentity,
    }, registryPath);

    await assert.rejects(
      () => waitForProjectRuntimeReady(rootDir, { registryPath, timeoutMs: 3000, intervalMs: 50 }),
      /Project runtime did not become ready: stale: Registered process is not running\./,
    );
  } finally {
    forgetRuntimeEntry(rootDir, registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service project discovery accepts the current default scaffold", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-discovery-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon", "conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon", "conventions", "index.ts"), "export default [];\n");

    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents", "skills", "opencanon", "index.ts")), false);
    assert.deepEqual(discoverOpenCanonProject(rootDir), { rootDir });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service project discovery finds initialized roots and direct children", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-discover-roots-"));
  try {
    const direct = path.join(rootDir, "direct");
    const child = path.join(rootDir, "workspace", "child");
    const ignored = path.join(rootDir, "workspace", "plain");
    mkdirSync(direct, { recursive: true });
    mkdirSync(path.join(child, "opencanon", "conventions"), { recursive: true });
    mkdirSync(ignored, { recursive: true });
    writeFileSync(path.join(direct, "opencanon.config.json"), "{}\n");
    writeFileSync(path.join(child, "opencanon", "conventions", "index.ts"), "export default [];\n");

    const discovered = discoverOpenCanonProjectsFromRoots([
      direct,
      path.join(rootDir, "workspace"),
      path.join(rootDir, "missing"),
      "",
      direct,
    ]);

    assert.deepEqual(discovered.map((project) => project.rootDir).sort(), [
      realpathSync(direct),
      realpathSync(child),
    ].sort());
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project and service lifecycle commands reject unknown options", () => {
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const project = spawnSync(process.execPath, [cli, "project", "status", "--bogus"], { encoding: "utf8" });
  assert.notEqual(project.status, 0);
  assert(`${project.stderr}\n${project.stdout}`.includes("Unknown opencanon project status option: --bogus"));

  const service = spawnSync(process.execPath, [cli, "service", "stop", "--bogus"], { encoding: "utf8" });
  assert.notEqual(service.status, 0);
  assert(`${service.stderr}\n${service.stdout}`.includes("Unknown opencanon service stop option: --bogus"));
});

test("top-level status renders a public summary by default", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-status-summary-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };

  try {
    const status = spawnSync(process.execPath, [cli, "status"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert(status.stdout.includes("# OpenCanon Status"));
    assert(status.stdout.includes("Service: not-running"));
    assert(status.stdout.includes("Project: not-running"));
    assert(status.stdout.includes("Details: opencanon service status, opencanon project status, or opencanon status --format json"));
    assert.doesNotMatch(status.stdout, /\b(?:Pipe|PID|Lease|Validator graph hash|NAPI|Cache):/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project and service stop commands support JSON format", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-stop-json-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };

  try {
    const project = spawnSync(process.execPath, [cli, "project", "stop", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(project.status, 0, project.stderr);
    const projectPayload = JSON.parse(project.stdout) as { status: string; rootDir: string; message: string };
    assert.equal(projectPayload.status, "not-running");
    assert.equal(projectPayload.rootDir, realpathSync(rootDir));
    assert(projectPayload.message.includes("No OpenCanon runtime is registered"));

    const service = spawnSync(process.execPath, [cli, "service", "stop", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(service.status, 0, service.stderr);
    const servicePayload = JSON.parse(service.stdout) as { status: string; message: string };
    assert(["not-running", "stale"].includes(servicePayload.status));
    assert(servicePayload.message.includes("No OpenCanon service is registered"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("top-level CLI exposes project runtime, status, ask, canon, and state surfaces", { timeout: 60000 }, () => {
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert(help.stdout.includes("Daily workflow:"));
  assert(help.stdout.includes("Project Canon:"));
  assert(help.stdout.includes("Project runtime:"));
  assert(help.stdout.includes("Agent and integration:"));
  assert(help.stdout.includes("Advanced and operations:"));
  assert(help.stdout.includes("opencanon status"));
  assert(help.stdout.includes("opencanon --version"));
  assert(help.stdout.includes("opencanon status --format json"));
  assert(help.stdout.includes("opencanon project status"));
  assert(help.stdout.includes("opencanon project status --format json"));
  assert(help.stdout.includes("opencanon project start --foreground"));
  assert(help.stdout.includes('opencanon ask "where is auth enforced?"'));
  assert(help.stdout.includes("opencanon canon list"));
  assert(help.stdout.includes("opencanon state status"));
  assert.equal(help.stdout.includes("project-types"), false);

  const expectedVersion = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version as string;
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const version = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), expectedVersion);
  }

  const projectHelp = spawnSync(process.execPath, [cli, "project", "--help"], { encoding: "utf8" });
  assert.equal(projectHelp.status, 0, projectHelp.stderr);
  assert(projectHelp.stdout.includes("opencanon project index"));
  assert(projectHelp.stdout.includes("opencanon project index --format json"));
  assert(projectHelp.stdout.includes("opencanon project logs --tail 200"));

  const canonHelp = spawnSync(process.execPath, [cli, "canon", "--help"], { encoding: "utf8" });
  assert.equal(canonHelp.status, 0, canonHelp.stderr);
  assert(canonHelp.stdout.includes("opencanon canon map"));

  const askHelp = spawnSync(process.execPath, [cli, "ask", "--help"], { encoding: "utf8" });
  assert.equal(askHelp.status, 0, askHelp.stderr);
  assert(askHelp.stdout.includes("opencanon ask <query>"));

  const graphHelp = spawnSync(process.execPath, [cli, "graph", "--help"], { encoding: "utf8" });
  assert.equal(graphHelp.status, 0, graphHelp.stderr);
  assert(graphHelp.stdout.includes("opencanon graph callers <symbol>"));

  const state = spawnSync(process.execPath, [cli, "state", "status"], { encoding: "utf8" });
  assert.equal(state.status, 0, state.stderr);
  assert(state.stdout.includes("# OpenCanon State"));

  const removedContextIndex = spawnSync(process.execPath, [cli, "context", "index"], { encoding: "utf8" });
  assert.notEqual(removedContextIndex.status, 0);
  assert(`${removedContextIndex.stderr}\n${removedContextIndex.stdout}`.includes("Use opencanon project index."));

  const removedChangesRender = spawnSync(process.execPath, [cli, "changes", "render"], { encoding: "utf8" });
  assert.notEqual(removedChangesRender.status, 0);
  assert(`${removedChangesRender.stderr}\n${removedChangesRender.stdout}`.includes("Use opencanon canon render changes instead."));
  const removedRunCheck = spawnSync(process.execPath, [cli, "changes", "run-check", "change-id", "check-id"], { encoding: "utf8" });
  assert.notEqual(removedRunCheck.status, 0);
  assert(`${removedRunCheck.stderr}\n${removedRunCheck.stdout}`.includes("Unknown changes command: run-check"));

  for (const removed of ["runtime", "dev", "areas", "conventions", "specs", "project-types"]) {
    const result = spawnSync(process.execPath, [cli, removed, "--help"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert(`${result.stderr}\n${result.stdout}`.includes(`Unknown command: ${removed}`));
  }
});

test("status commands render token-safe JSON", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-status-json-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const fakePid = 9_999_999;
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
    pid: fakePid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "runtime.log"),
    authToken: "project-secret-token",
    ...testRuntimeLease("project-json-lease"),
    ...testRuntimeIdentity,
  };
  const service = {
    host: "127.0.0.1",
    port: 4766,
    url: "http://127.0.0.1:4766",
    pipeEndpoint: testServicePipeEndpoint(registryPath),
    pid: fakePid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, "global", "service.log"),
    authToken: "service-secret-token",
    ...testServiceLease("service-json-lease"),
    ...testRuntimeIdentity,
  };
  const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };

  try {
    upsertRuntimeEntry(entry, registryPath);
    upsertServiceEntry(service, registryPath);

    const status = spawnSync(process.execPath, [cli, "status", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as { service: { status: string; entry?: Record<string, unknown> }; project: { status: string; entry?: Record<string, unknown> } };
    assert.equal(statusPayload.service.status, "stale");
    assert.equal(statusPayload.project.status, "stale");
    assert.equal(statusPayload.service.entry?.authToken, undefined);
    assert.equal(statusPayload.project.entry?.authToken, undefined);
    assert(!status.stdout.includes("project-secret-token"));
    assert(!status.stdout.includes("service-secret-token"));

    const projectStatus = spawnSync(process.execPath, [cli, "project", "status", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(projectStatus.status, 0, projectStatus.stderr);
    const projectPayload = JSON.parse(projectStatus.stdout) as { project: { status: string; actions: string[]; entry?: Record<string, unknown> } };
    assert.equal(projectPayload.project.status, "stale");
    assert(projectPayload.project.actions.includes("Run opencanon project start to recreate project runtime state."));
    assert.equal(projectPayload.project.entry?.authToken, undefined);

    const serviceStatus = spawnSync(process.execPath, [cli, "service", "status", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(serviceStatus.status, 0, serviceStatus.stderr);
    const servicePayload = JSON.parse(serviceStatus.stdout) as { service: { status: string; actions: string[]; entry?: Record<string, unknown> } };
    assert.equal(servicePayload.service.status, "stale");
    assert(servicePayload.service.actions.includes("Run opencanon service start to recreate service state."));
    assert.equal(servicePayload.service.entry?.authToken, undefined);

    const projectList = spawnSync(process.execPath, [cli, "project", "list", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(projectList.status, 0, projectList.stderr);
    const listPayload = JSON.parse(projectList.stdout) as { projects: Array<{ status: string; entry?: Record<string, unknown> }>; diagnostics: string[] };
    assert.equal(listPayload.projects[0]?.status, "stale");
    assert.equal(listPayload.projects[0]?.entry?.authToken, undefined);
    assert.deepEqual(listPayload.diagnostics, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime status renders explicit recovery when project refresh is stale", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-refresh-stale-"));
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pipeEndpoint: testRuntimePipeEndpoint(rootDir, path.join(rootDir, "global", "service.json")),
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "runtime.log"),
    authToken: "test-token",
    ...testRuntimeLease("refresh-stale-lease"),
    ...testRuntimeIdentity,
  };

  try {
    const markdown = renderRuntimeStatusMarkdown(
      {
        entry,
        status: "running",
        message: "ready",
        health: {
          status: "stale",
          engine: {
            packageVersion: "0.1.0",
            engineVersion: "0.1.0",
            napiVersion: "3.9.0",
            schemaVersion: 1,
          },
          refresh: {
            status: "stale",
            mode: "manual",
            bufferedEvents: 0,
            reason: "File watching is unavailable; manual refresh is required.",
          },
          startedAt: "2026-05-01T00:00:00.000Z",
        },
      },
      rootDir,
    );

    assert(markdown.includes("Refresh: stale (mode manual, buffered 0, File watching is unavailable; manual refresh is required.)"));
    assert(markdown.includes("Action: Run opencanon project index to refresh derived project knowledge now; run opencanon project stop, then opencanon project start to restore live file watching."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service registry stores project runtime entries and lazily starts isolated projects", { timeout: 60000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "runtime.log"),
    authToken: "test-token",
    ...testRuntimeLease("registry-runtime-lease"),
    ...testRuntimeIdentity,
  };
  const service = {
    host: "127.0.0.1",
    port: 4766,
    url: "http://127.0.0.1:4766",
    pipeEndpoint: testServicePipeEndpoint(registryPath),
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, "global", "service.log"),
    authToken: "service-token",
    ...testServiceLease("registry-service-lease"),
    ...testRuntimeIdentity,
  };
  const projectA = path.join(rootDir, "project-a");
  const projectB = path.join(rootDir, "project-b");
  let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;

  try {
    upsertServiceEntry(service, registryPath);
    writeRuntimeRegistry([entry], registryPath);
    assert.deepEqual(readRuntimeRegistry(registryPath), [entry]);
    assert.deepEqual(readServiceEntry(registryPath), service);

    upsertRuntimeEntry({ ...entry, port: 4768, url: "http://127.0.0.1:4768" }, registryPath);
    assert.equal(readRuntimeRegistry(registryPath)[0].port, 4768);
    assert(renderRuntimeListMarkdown([{ entry, status: "running", message: "ready" }]).includes(rootDir));
    assert(renderServiceStatusMarkdown({ entry: service, status: "running", message: "ready" }).includes("OpenCanon Service"));

    forgetRuntimeEntry(rootDir, registryPath);
    assert.deepEqual(readRuntimeRegistry(registryPath), []);
    forgetServiceEntry(registryPath);
    assert.equal(readServiceEntry(registryPath), undefined);

    createAuthoringProject(projectA);
    createAuthoringProject(projectB);
    server = await startServiceServer({ port: 0, registryPath, authToken: "service-token" });
    const serviceServer = server;
    const unauthHealth = await fetch(`${serviceServer.url}/api/health`);
    assert.equal(unauthHealth.status, 401);
    const authHealth = await fetch(`${serviceServer.url}/api/health`, { headers: runtimeAuthHeaders(serviceServer.authToken) });
    assert.equal(authHealth.status, 200);
    const uninitializedRoot = path.join(rootDir, "uninitialized");
    mkdirSync(uninitializedRoot, { recursive: true });
    const uninitializedResponse = await fetch(`${serviceServer.url}/api/projects/ensure`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ rootDir: uninitializedRoot }),
    });
    const uninitializedText = await uninitializedResponse.text();
    const uninitializedPayload = JSON.parse(uninitializedText) as { error?: { kind?: string; problem?: { code?: string; path?: string; action?: string } } };
    assert.equal(uninitializedResponse.status, 400, uninitializedText);
    assert.equal(uninitializedPayload.error?.kind, "problem");
    assert.equal(uninitializedPayload.error?.problem?.code, "project-not-found");
    assert.equal(uninitializedPayload.error?.problem?.path, uninitializedRoot);
    assert.equal(uninitializedPayload.error?.problem?.action?.includes("opencanon init --yes"), true);

    for (const rootDir of [projectA, projectB]) {
      const response: Response = await fetch(`${serviceServer.url}/api/projects/ensure`, {
        method: "POST",
        headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ rootDir, idleTimeoutMs: 30000, waitForReady: true }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
    }

    const entries = readRuntimeRegistry(registryPath);
    assert.deepEqual(entries.map((entry) => entry.rootDir).sort(), [projectA, projectB].sort());
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 2);
    assert.equal(entries.every((entry) => entry.logPath.startsWith(path.join(entry.rootDir, ".opencanon"))), true);
    assert.equal(existsSync(path.join(projectA, ".opencanon", "state.sqlite")), true);
    assert.equal(existsSync(path.join(projectB, ".opencanon", "state.sqlite")), true);

    const proxiedSnapshot = await fetch(`${serviceServer.url}/api/projects/request`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ rootDir: projectA, method: "GET", path: "/api/snapshot" }),
    });
    const proxiedText = await proxiedSnapshot.text();
    assert.equal(proxiedSnapshot.status, 200, proxiedText);
    const proxiedPayload = JSON.parse(proxiedText) as { data?: { status?: number; body?: { ok?: boolean; data?: { graph?: { rootDir?: string } } } } };
    assert.equal(proxiedPayload.data?.status, 200);
    assert.equal(proxiedPayload.data?.body?.ok, true);
    assert.equal(proxiedPayload.data?.body?.data?.graph?.rootDir, realpathSync(projectA));

    const summaryResponse = await fetch(`${serviceServer.url}/api/projects/summary?rootDir=${encodeURIComponent(projectA)}`, {
      headers: runtimeAuthHeaders(serviceServer.authToken),
    });
    const summaryText = await summaryResponse.text();
    assert.equal(summaryResponse.status, 200, summaryText);
    const summaryPayload = JSON.parse(summaryText) as { data?: { rootDir?: string; health?: { status?: string }; files?: number; productModel?: { nodes?: number } } };
    assert.equal(summaryPayload.data?.rootDir, realpathSync(projectA));
    assert.equal(summaryPayload.data?.health?.status, "ready");
    assert.equal(typeof summaryPayload.data?.files, "number");
    assert.equal(typeof summaryPayload.data?.productModel?.nodes, "number");

    const overviewResponse = await fetch(`${serviceServer.url}/api/overview`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        discoveryRoots: [rootDir],
        recentProjects: [{ rootDir: projectB, openedAt: "2026-06-17T00:00:00.000Z" }],
        currentRootDir: projectA,
      }),
    });
    const overviewText = await overviewResponse.text();
    assert.equal(overviewResponse.status, 200, overviewText);
    const overviewPayload = JSON.parse(overviewText) as {
      data?: {
        currentRootDir?: string;
        projects?: Array<{ rootDir: string; status: string; files?: number; findings?: number }>;
        actions?: Array<{ id: string; enabled: boolean; disabledReason?: string }>;
        activity?: Array<{ id: string; kind: string }>;
      };
    };
    assert.equal(overviewPayload.data?.currentRootDir, realpathSync(projectA));
    const overviewProjects = overviewPayload.data?.projects ?? [];
    assert.equal(overviewProjects.find((project) => project.rootDir === realpathSync(projectA))?.status, ServiceProjectStatusValue.Current);
    assert.equal(overviewProjects.find((project) => project.rootDir === realpathSync(projectB))?.status, ServiceProjectStatusValue.Running);
    assert.equal(typeof overviewProjects.find((project) => project.rootDir === realpathSync(projectA))?.files, "number");
    const reindexAction = overviewPayload.data?.actions?.find((action) => action.id === ServiceActionId.ProjectReindex);
    assert.equal(reindexAction?.enabled, true);
    assert((overviewPayload.data?.activity ?? []).some((event) => event.kind === "runtime-started"));

    const openLogsResponse = await fetch(`${serviceServer.url}/api/actions/invoke`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ id: ServiceActionId.OpenLogs, rootDir: projectA }),
    });
    const openLogsText = await openLogsResponse.text();
    assert.equal(openLogsResponse.status, 200, openLogsText);
    const openLogsPayload = JSON.parse(openLogsText) as { data?: { status?: string; path?: string; effects?: Array<{ kind: string; path?: string }> } };
    assert.equal(openLogsPayload.data?.status, "ok");
    assert.equal(openLogsPayload.data?.effects?.[0]?.kind, ServiceEffectKind.RevealPath);
    assert.equal(existsSync(openLogsPayload.data?.path ?? ""), true);

    const invalidPort = await fetch(`${serviceServer.url}/api/projects/ensure`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(serviceServer.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ rootDir: projectA, port: 0 }),
    });
    assert.equal(invalidPort.status, 400);
  } finally {
    await stopProjectRuntime(projectA, registryPath).catch(() => undefined);
    await stopProjectRuntime(projectB, registryPath).catch(() => undefined);
    await server?.stop().catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime stop terminates registered runtimes without waiting for health", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-unhealthy-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    if (!child.pid) throw new Error("test child did not start");
    const entry = {
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: child.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("stop-runtime-lease"),
      ...testRuntimeIdentity,
    };
    upsertRuntimeEntry(entry, registryPath);

    const stopped = await stopProjectRuntime(rootDir, registryPath);
    assert.equal(stopped.status, "stopped");
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
    assert.equal(processIsRunning(child.pid), false);
  } finally {
    if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime stop waits for killed runtimes and removes inactive pipe endpoints", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-kill-stop-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    if (!child.pid) throw new Error("test child did not start");
    const pipeEndpoint = testRuntimePipeEndpoint(rootDir, registryPath);
    mkdirSync(path.dirname(pipeEndpoint), { recursive: true });
    writeFileSync(pipeEndpoint, "");
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint,
      pid: child.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("stop-runtime-kill-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const stopped = await stopProjectRuntime(rootDir, registryPath);

    assert.equal(stopped.status, "stopped");
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
    assert.equal(processIsRunning(child.pid), false);
    assert.equal(existsSync(pipeEndpoint), false);
  } finally {
    if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime inspection rejects health from a different process lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-lease-mismatch-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      ok: true,
      data: {
        status: "ready",
        process: { kind: "runtime", pid: process.pid, leaseId: "wrong-lease" },
        engine: { engineVersion: "0.4.0-test", packageVersion: "0.4.0-test", napiVersion: "test", schemaVersion: 1 },
        refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
        startedAt: new Date().toISOString(),
      },
    }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const inspection = await inspectRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("expected-lease"),
      ...testRuntimeIdentity,
      transport: LocalTransportKind.Http,
      pipeEndpoint: "",
    });

    assert.equal(inspection.status, "unhealthy");
    assert.equal(inspection.message, "Runtime health endpoint responded for a different process lease.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reconciler restarts a stale registered project runtime and records lifecycle events", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reconcile-stale-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;
    const port = await chooseRuntimePort({ host: "127.0.0.1" });
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: 9_999_998,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("stale-runtime-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const result = await reconcileProjectRuntimes({ registryPath, nowMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const registered = readRuntimeRegistry(registryPath)[0];
    replacementPid = registered?.pid;

    assert.equal(result.stale, 1);
    assert.equal(result.restarted, 1);
    assert(registered);
    assert.notEqual(registered.pid, 9_999_998);
    assert.equal(registered.lifecycle.status, ProcessLifecycleStatus.Running);
    const events = readRuntimeLifecycleEvents(registryPath);
    assert(events.some((event) => event.kind === "runtime-stale"));
    assert(events.some((event) => event.kind === "runtime-started"));
    assert(renderLifecycleEventsMarkdown(events).includes("runtime-started"));
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("app overview reconciles stale registered project runtimes before listing projects", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-overview-reconcile-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: await chooseRuntimePort({ host: "127.0.0.1" }),
      url: "http://127.0.0.1:4767",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: 9_999_996,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("overview-stale-runtime-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const overview = await buildServiceOverview({ registryPath });
    const project = overview.projects.find((project) => project.rootDir === realpathSync(rootDir));
    replacementPid = readRuntimeRegistry(registryPath)[0]?.pid;

    assert(project, "expected the restarted project in overview");
    assert.equal(project.status, ServiceProjectStatusValue.Running);
    assert(replacementPid);
    assert.notEqual(replacementPid, 9_999_996);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reconciler restarts stale project runtimes on another port when the old port is busy", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reconcile-busy-port-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  const blocker = createServer();
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const projectRoot = realpathSync(rootDir);
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;
    const blockedPort = await chooseRuntimePort({ host: "127.0.0.1", rangeKey: projectRoot });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(blockedPort, "127.0.0.1", resolve);
    });
    upsertRuntimeEntry({
      rootDir: projectRoot,
      host: "127.0.0.1",
      port: blockedPort,
      url: `http://127.0.0.1:${blockedPort}`,
      pipeEndpoint: testRuntimePipeEndpoint(projectRoot, registryPath),
      pid: 9_999_995,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(projectRoot, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("busy-port-stale-runtime-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const result = await reconcileProjectRuntimes({ registryPath, nowMs: Date.parse("2026-05-01T00:00:00.000Z") });
    const registered = readRuntimeRegistry(registryPath)[0];
    replacementPid = registered?.pid;

    assert.equal(result.stale, 1);
    assert.equal(result.restarted, 1);
    assert(registered);
    assert.notEqual(registered.pid, 9_999_995);
    assert.notEqual(registered.port, blockedPort);
    assert.equal(registered.lifecycle.status, ProcessLifecycleStatus.Running);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reconciler preserves starting project runtimes during startup grace", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reconcile-starting-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const starting = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    if (!starting.pid) throw new Error("test child did not start");
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: await chooseRuntimePort({ host: "127.0.0.1" }),
      url: "http://127.0.0.1:4767",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: starting.pid,
      startedAt,
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      leaseId: "starting-runtime-lease",
      lifecycle: {
        status: ProcessLifecycleStatus.Starting,
        updatedAt: startedAt,
        message: "Waiting for runtime health endpoint.",
        restart: { attempts: 0 },
      },
      ...testRuntimeIdentity,
    }, registryPath);

    const inspection = await inspectRuntimeEntry(readRuntimeRegistry(registryPath)[0]!);
    assert.equal(inspection.status, "starting");
    assert.equal(inspection.message, "Runtime is still starting; waiting for health endpoint.");

    const result = await reconcileProjectRuntimes({ registryPath, nowMs: Date.now() });
    const registered = readRuntimeRegistry(registryPath)[0];

    assert.equal(result.starting, 1);
    assert.equal(result.unhealthy, 0);
    assert.equal(result.restarted, 0);
    assert.equal(registered?.pid, starting.pid);
    assert(processIsRunning(starting.pid));
  } finally {
    if (starting.pid && processIsRunning(starting.pid)) process.kill(starting.pid, "SIGKILL");
    forgetRuntimeEntry(rootDir, registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reconciler preserves active restart backoff without incrementing attempts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reconcile-backoff-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const backoffLifecycle = {
    status: ProcessLifecycleStatus.BackingOff,
    updatedAt: "2026-05-01T00:00:00.000Z",
    message: "Process exited unexpectedly.",
    restart: {
      attempts: 2,
      firstFailureAt: "2026-05-01T00:00:00.000Z",
      lastFailureAt: "2026-05-01T00:00:01.000Z",
      nextRestartAt: "2026-05-01T00:01:00.000Z",
      lastReason: "Process exited unexpectedly.",
    },
  };

  try {
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 4767,
      url: "http://127.0.0.1:4767",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: 9_999_997,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      leaseId: "backoff-runtime-lease",
      lifecycle: backoffLifecycle,
      ...testRuntimeIdentity,
    }, registryPath);

    const result = await reconcileProjectRuntimes({ registryPath, nowMs: Date.parse("2026-05-01T00:00:30.000Z") });
    const registered = readRuntimeRegistry(registryPath)[0];

    assert.equal(result.backingOff, 1);
    assert.equal(result.restarted, 0);
    assert.equal(registered?.lifecycle.restart.attempts, 2);
    assert.equal(registered?.lifecycle.restart.nextRestartAt, "2026-05-01T00:01:00.000Z");
  } finally {
    forgetRuntimeEntry(rootDir, registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime start terminates an unhealthy registered runtime before replacement", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-replace-unhealthy-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const fakeRuntimePidPath = path.join(rootDir, "fake-runtime.pid");
  const unhealthy = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource({ pidPathEnv: "OPENCANON_FAKE_RUNTIME_PID_PATH" }));
    if (!unhealthy.pid) throw new Error("test child did not start");
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: unhealthy.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("replace-unhealthy-lease"),
      ...testRuntimeIdentity,
    }, registryPath);
    process.env.OPENCANON_CLI = fakeCliPath;
    process.env.OPENCANON_FAKE_RUNTIME_PID_PATH = fakeRuntimePidPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    replacementPid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.notEqual(replacementPid, unhealthy.pid);
    assert.equal(await waitUntilProcessStops(unhealthy.pid, 2000), true);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.pid, replacementPid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (unhealthy.pid && processIsRunning(unhealthy.pid)) process.kill(unhealthy.pid, "SIGKILL");
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    delete process.env.OPENCANON_FAKE_RUNTIME_PID_PATH;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime start retires unsupported registry runtime leases before replacement", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reap-unsupported-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const previous = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    if (!previous.pid) throw new Error("test child did not start");
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      version: 2,
      runtimes: [{
        rootDir,
        host: "127.0.0.1",
        port: 9,
        url: "http://127.0.0.1:9",
        pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
        pid: previous.pid,
        startedAt: "2026-05-01T00:00:00.000Z",
        logPath: path.join(rootDir, ".opencanon", "runtime.log"),
        authToken: "old-token",
      }],
    }));
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    replacementPid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.notEqual(replacementPid, previous.pid);
    assert.equal(await waitUntilProcessStops(previous.pid, 2000), true);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.pid, replacementPid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (previous.pid && processIsRunning(previous.pid)) process.kill(previous.pid, "SIGKILL");
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime start retires unusable project-local runtime leases before replacement", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reap-project-local-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const previous = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    if (!previous.pid) throw new Error("test child did not start");
    const runtimeFile = path.join(rootDir, ".opencanon", "runtime.json");
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, JSON.stringify({
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: previous.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "",
    }));
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    replacementPid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.notEqual(replacementPid, previous.pid);
    assert.equal(await waitUntilProcessStops(previous.pid, 2000), true);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.pid, replacementPid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (previous.pid && processIsRunning(previous.pid)) process.kill(previous.pid, "SIGKILL");
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("concurrent runtime starts converge on one registered project runtime", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-concurrent-runtime-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let pid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const [first, second] = await Promise.all([
      startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 }),
      startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 }),
    ]);

    const entries = readRuntimeRegistry(registryPath);
    assert.equal(entries.length, 1);
    assert.equal(first.entry.pid, second.entry.pid);
    assert.equal(entries[0]?.pid, first.entry.pid);
    assert.equal(new Set([first.status, second.status]).has("started"), true);
    assert.equal(new Set([first.status, second.status]).has("already-running"), true);
    pid = entries[0]?.pid;
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service stop also terminates registered project runtimes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-stop-runtimes-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    if (!child.pid) throw new Error("test child did not start");
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: child.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("service-stop-runtime-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const stopped = await stopService(registryPath);

    assert.equal(stopped.status, "stale");
    assert.match(stopped.message, /Stopped 1 project runtime/);
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
    assert.equal(processIsRunning(child.pid), false);
  } finally {
    if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service stop terminates every registered project runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-stop-all-runtimes-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const projectA = path.join(rootDir, "project-a");
  const projectB = path.join(rootDir, "project-b");
  const runtimeA = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  const runtimeB = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });

  try {
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(path.join(projectA, "opencanon.config.json"), "{}\n");
    writeFileSync(path.join(projectB, "opencanon.config.json"), "{}\n");
    if (!runtimeA.pid || !runtimeB.pid) throw new Error("test runtimes did not start");
    upsertRuntimeEntry({
      rootDir: projectA,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(projectA, registryPath),
      pid: runtimeA.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(projectA, ".opencanon", "runtime.log"),
      authToken: "test-token-a",
      ...testRuntimeLease("service-stop-runtime-a-lease"),
      ...testRuntimeIdentity,
    }, registryPath);
    upsertRuntimeEntry({
      rootDir: projectB,
      host: "127.0.0.1",
      port: 10,
      url: "http://127.0.0.1:10",
      pipeEndpoint: testRuntimePipeEndpoint(projectB, registryPath),
      pid: runtimeB.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(projectB, ".opencanon", "runtime.log"),
      authToken: "test-token-b",
      ...testRuntimeLease("service-stop-runtime-b-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    const stopped = await stopService(registryPath);

    assert.equal(stopped.status, "stale");
    assert.match(stopped.message, /Stopped 2 project runtimes/);
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
    assert.equal(await waitUntilProcessStops(runtimeA.pid, 2000), true);
    assert.equal(await waitUntilProcessStops(runtimeB.pid, 2000), true);
  } finally {
    if (runtimeA.pid && processIsRunning(runtimeA.pid)) process.kill(runtimeA.pid, "SIGKILL");
    if (runtimeB.pid && processIsRunning(runtimeB.pid)) process.kill(runtimeB.pid, "SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime inspection retires malformed runtime lease entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reap-malformed-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    if (!child.pid) throw new Error("test child did not start");
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      runtimes: [{
        rootDir,
        host: "127.0.0.1",
        port: 9,
        url: "http://127.0.0.1:9",
        pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
        pid: child.pid,
        startedAt: "2026-05-01T00:00:00.000Z",
        logPath: path.join(rootDir, ".opencanon", "runtime.log"),
        authToken: "",
        transport: LocalTransportKind.Pipe,
        protocolVersion: LocalControlProtocolVersion,
        runtimeVersion: "0.4.0-test",
        runtimeFingerprint: "sha256:test-runtime",
        cliPath: process.execPath,
      }],
    }));

    const inspections = await inspectAllRuntimes(registryPath);

    assert.equal(inspections.length, 0);
    assert.equal(await waitUntilProcessStops(child.pid, 2000), true);
    assert.deepEqual(readRuntimeRegistry(registryPath), []);
  } finally {
    if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service startup cleanup kills an unready spawned process", { timeout: 30000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-unready-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const fakePidPath = path.join(rootDir, "fake-service.pid");
  const originalCli = process.env.OPENCANON_CLI;
  const originalPidPath = process.env.OPENCANON_FAKE_SERVICE_PID_PATH;
  let spawnedPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(
      fakeCliPath,
      [
        'import { createServer } from "node:http";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.OPENCANON_FAKE_SERVICE_PID_PATH, String(process.pid));',
        'const portArg = process.argv.indexOf("--port");',
        "const port = Number(process.argv[portArg + 1]);",
        "createServer((_request, response) => {",
        '  response.writeHead(503, { "content-type": "application/json; charset=utf-8" });',
        '  response.end(JSON.stringify({ ok: false, data: { status: "starting" } }));',
        '}).listen(port, "127.0.0.1");',
        "",
      ].join("\n"),
    );
    process.env.OPENCANON_CLI = fakeCliPath;
    process.env.OPENCANON_FAKE_SERVICE_PID_PATH = fakePidPath;

    await assert.rejects(() => startService({ cwd: rootDir, registryPath }), /did not become ready/);
    spawnedPid = Number(readFileSync(fakePidPath, "utf8"));
    assert.equal(readServiceEntry(registryPath), undefined);
    assert.equal(await waitUntilProcessStops(spawnedPid, 2000), true);
  } finally {
    if (spawnedPid && processIsRunning(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    if (originalPidPath === undefined) delete process.env.OPENCANON_FAKE_SERVICE_PID_PATH;
    else process.env.OPENCANON_FAKE_SERVICE_PID_PATH = originalPidPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service retries auto-selected ports when the spawned service exits before health", { timeout: 30000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-auto-port-retry-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const exitOnceMarkerPath = path.join(rootDir, "first-service-exit.txt");
  const originalCli = process.env.OPENCANON_CLI;
  let pid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeServiceCliSource({ exitOnceMarkerPath }));
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startService({ cwd: rootDir, registryPath });
    pid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.equal(readServiceEntry(registryPath)?.pid, pid);
    assert.equal(existsSync(exitOnceMarkerPath), true);
    const events = readRuntimeLifecycleEvents(registryPath);
    assert.equal(events.filter((event) => event.kind === ProcessLifecycleEventKind.ServiceStartupFailed).length, 1);
    assert.equal(events.filter((event) => event.kind === ProcessLifecycleEventKind.ServiceStarted).length, 2);
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service start terminates an unhealthy registered service before replacement", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-replace-unhealthy-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const fakeServicePidPath = path.join(rootDir, "fake-service.pid");
  const unhealthy = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  const originalCli = process.env.OPENCANON_CLI;
  const originalPidPath = process.env.OPENCANON_FAKE_SERVICE_PID_PATH;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(
      fakeCliPath,
      readyFakeServiceCliSource({ pidPathEnv: "OPENCANON_FAKE_SERVICE_PID_PATH" }),
    );
    if (!unhealthy.pid) throw new Error("test child did not start");
    upsertServiceEntry({
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testServicePipeEndpoint(registryPath),
      pid: unhealthy.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, "global", "service.log"),
      authToken: "service-token",
      ...testServiceLease("replace-service-lease"),
      ...testRuntimeIdentity,
    }, registryPath);
    process.env.OPENCANON_CLI = fakeCliPath;
    process.env.OPENCANON_FAKE_SERVICE_PID_PATH = fakeServicePidPath;

    const started = await startService({ cwd: rootDir, registryPath });
    replacementPid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.notEqual(replacementPid, unhealthy.pid);
    assert.equal(await waitUntilProcessStops(unhealthy.pid, 2000), true);
    assert.equal(readServiceEntry(registryPath)?.pid, replacementPid);
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (unhealthy.pid && processIsRunning(unhealthy.pid)) process.kill(unhealthy.pid, "SIGKILL");
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    if (originalPidPath === undefined) delete process.env.OPENCANON_FAKE_SERVICE_PID_PATH;
    else process.env.OPENCANON_FAKE_SERVICE_PID_PATH = originalPidPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service start retires unsupported service process leases before replacement", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-reap-unsupported-service-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const previous = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  const originalCli = process.env.OPENCANON_CLI;
  let replacementPid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeServiceCliSource());
    if (!previous.pid) throw new Error("test child did not start");
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      version: 2,
      runtimes: [],
      service: {
        host: "127.0.0.1",
        port: 9,
        url: "http://127.0.0.1:9",
        pipeEndpoint: testServicePipeEndpoint(registryPath),
        pid: previous.pid,
        startedAt: "2026-05-01T00:00:00.000Z",
        logPath: path.join(rootDir, "global", "service.log"),
        authToken: "old-token",
      },
    }));
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startService({ cwd: rootDir, registryPath });
    replacementPid = started.entry.pid;

    assert.equal(started.status, "started");
    assert.notEqual(replacementPid, previous.pid);
    assert.equal(await waitUntilProcessStops(previous.pid, 2000), true);
    assert.equal(readServiceEntry(registryPath)?.pid, replacementPid);
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (previous.pid && processIsRunning(previous.pid)) process.kill(previous.pid, "SIGKILL");
    if (replacementPid && processIsRunning(replacementPid)) process.kill(replacementPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("concurrent service starts converge on one registered service", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-concurrent-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let pid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeServiceCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const [first, second] = await Promise.all([
      startService({ cwd: rootDir, registryPath }),
      startService({ cwd: rootDir, registryPath }),
    ]);

    const registered = readServiceEntry(registryPath);
    assert(registered, "expected a registered service");
    assert.equal(first.entry.pid, second.entry.pid);
    assert.equal(registered.pid, first.entry.pid);
    assert.equal(new Set([first.status, second.status]).has("started"), true);
    assert.equal(new Set([first.status, second.status]).has("already-running"), true);
    pid = registered.pid;
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("pid-scoped registry cleanup does not remove newer service or runtime entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-pid-scoped-cleanup-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    upsertServiceEntry({
      host: "127.0.0.1",
      port: 4766,
      url: "http://127.0.0.1:4766",
      pipeEndpoint: testServicePipeEndpoint(registryPath),
      pid: 22_222,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, "global", "service.log"),
      authToken: "service-token",
      ...testServiceLease("new-service-lease"),
      ...testRuntimeIdentity,
    }, registryPath);
    upsertRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 4767,
      url: "http://127.0.0.1:4767",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid: 33_333,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "runtime-token",
      ...testRuntimeLease("new-runtime-lease"),
      ...testRuntimeIdentity,
    }, registryPath);

    forgetServiceEntryForPid(11_111, registryPath);
    forgetRuntimeEntryForPid(rootDir, 11_111, registryPath);
    assert.equal(readServiceEntry(registryPath)?.pid, 22_222);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.pid, 33_333);

    forgetServiceEntryForPid(22_222, registryPath);
    forgetRuntimeEntryForPid(rootDir, 33_333, registryPath);
    assert.equal(readServiceEntry(registryPath), undefined);
    assert.equal(readRuntimeRegistry(registryPath).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service repair retires unregistered service and project runtime peers plus stale local pipes", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-repair-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const pipeDir = path.join(rootDir, "ipc");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let peerPid: number | undefined;
  let projectPeerPid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, "setInterval(() => {}, 1000);\n");
    mkdirSync(pipeDir, { recursive: true });
    const stalePipe = path.join(pipeDir, "service-stale.sock");
    writeFileSync(stalePipe, "");
    process.env.OPENCANON_CLI = fakeCliPath;
    const peer = spawn(process.execPath, [fakeCliPath, "service", "run", "--registry", registryPath], { stdio: "ignore" });
    peerPid = await waitForSpawnedPid(peer, "unregistered service peer");
    const projectPeer = spawn(process.execPath, [fakeCliPath, "project", "start", "--foreground", "--registry", registryPath], { stdio: "ignore" });
    projectPeerPid = await waitForSpawnedPid(projectPeer, "unregistered project runtime peer");

    const result = await repairServiceProcessState({ cwd: rootDir, registryPath, pipeDir, cleanupPipeMaxAgeMs: 0 });

    assert.equal(result.retiredServiceProcesses, 1);
    assert.equal(result.retiredProjectRuntimes, 1);
    assert.equal(result.removedPipeEndpoints, 1);
    assert.equal(await waitUntilProcessStops(peerPid, 2000), true);
    assert.equal(await waitUntilProcessStops(projectPeerPid, 2000), true);
    assert.equal(existsSync(stalePipe), false);
  } finally {
    if (peerPid && processIsRunning(peerPid)) process.kill(peerPid, "SIGKILL");
    if (projectPeerPid && processIsRunning(projectPeerPid)) process.kill(projectPeerPid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reconciler retires unregistered duplicate project runtime peers before health inspection", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-reconcile-duplicate-runtime-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "fake-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let registeredPid: number | undefined;
  let duplicatePid: number | undefined;

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    registeredPid = started.entry.pid;
    const duplicatePort = await chooseRuntimePort({
      host: "127.0.0.1",
      usedPorts: [started.entry.port],
      rangeKey: `${registryPath}:duplicate`,
    });
    const duplicate = spawn(process.execPath, [
      fakeCliPath,
      "project",
      "start",
      "--foreground",
      "--host",
      "127.0.0.1",
      "--port",
      String(duplicatePort),
      "--registry",
      registryPath,
    ], {
      cwd: rootDir,
      stdio: "ignore",
      env: {
        ...process.env,
        OPENCANON_RUNTIME_LEASE_ID: "duplicate-runtime-lease",
      },
    });
    duplicatePid = await waitForSpawnedPid(duplicate, "unregistered duplicate project runtime peer");

    const result = await reconcileProjectRuntimes({ registryPath, nowMs: Date.now() });
    const registered = readRuntimeRegistry(registryPath);
    const events = readRuntimeLifecycleEvents(registryPath);

    assert.equal(result.repair.retiredProjectRuntimes, 1);
    assert.equal(result.repair.retiredServiceProcesses, 0);
    assert.equal(result.running, 1);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.pid, registeredPid);
    assert.equal(processIsRunning(registeredPid), true);
    assert.equal(await waitUntilProcessStops(duplicatePid, 2000), true);
    assert(events.some((event) => event.message?.includes("Retired unregistered OpenCanon project runtime process")));
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (registeredPid && processIsRunning(registeredPid)) process.kill(registeredPid, "SIGKILL");
    if (duplicatePid && processIsRunning(duplicatePid)) process.kill(duplicatePid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service reports malformed project registry state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-malformed-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "runtime.log"),
    authToken: "test-token",
    ...testRuntimeLease("malformed-state-valid-lease"),
    ...testRuntimeIdentity,
  };

  try {
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ version: 1, runtimes: [entry, { ...entry, authToken: "" }], events: [] }));

    assert(readRuntimeRegistryDiagnostics(registryPath).some((diagnostic) => diagnostic.includes("malformed project registry entry 2")));
    assert.deepEqual(readRuntimeRegistry(registryPath), [entry]);

    const inspections = await inspectAllRuntimes(registryPath);
    assert.equal(inspections.length, 1);
    assert.deepEqual(readRuntimeRegistry(registryPath), [entry]);

    writeFileSync(registryPath, "{");
    assert(readRuntimeRegistryDiagnostics(registryPath).some((diagnostic) => diagnostic.includes("malformed OpenCanon service registry")));
    assert.deepEqual(readRuntimeRegistry(registryPath), []);

    writeFileSync(registryPath, JSON.stringify({ version: 2, runtimes: [entry] }));
    assert(readRuntimeRegistryDiagnostics(registryPath).some((diagnostic) => diagnostic.includes("unsupported OpenCanon service registry")));
    assert.deepEqual(readRuntimeRegistry(registryPath), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime status renders runtime health and state details", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-status-"));
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pipeEndpoint: testRuntimePipeEndpoint(rootDir, path.join(rootDir, "global", "service.json")),
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "runtime.log"),
    authToken: "test-token",
    ...testRuntimeLease("status-runtime-lease"),
    ...testRuntimeIdentity,
  };

  try {
    const markdown = renderRuntimeStatusMarkdown(
      {
        entry,
        status: "running",
        message: "ready",
        health: {
          status: "ready",
          engine: {
            packageVersion: "0.1.0",
            engineVersion: "0.1.0",
            napiVersion: "3.9.0",
            schemaVersion: 1,
          },
          refresh: { status: "live", mode: "watch", bufferedEvents: 2 },
          startedAt: "2026-05-01T00:00:00.000Z",
        },
        state: {
          health: {
            status: "ready",
            engine: {
              packageVersion: "0.1.0",
              engineVersion: "0.1.0",
              napiVersion: "3.9.0",
              schemaVersion: 1,
            },
            refresh: { status: "live", mode: "watch", bufferedEvents: 2 },
            startedAt: "2026-05-01T00:00:00.000Z",
          },
          files: 3,
          findings: 1,
          staleFiles: 0,
          cacheHits: 4,
          cacheMisses: 5,
        },
      },
      rootDir,
    );

    assert(markdown.includes("Health: ready"));
    assert(markdown.includes("Engine: 0.1.0"));
    assert(markdown.includes("Refresh: live (mode watch, buffered 2)"));
    assert(markdown.includes("Files: 3"));
    assert(markdown.includes("Findings: 1"));
    assert(markdown.includes("Cache: 4 hits, 5 misses"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
