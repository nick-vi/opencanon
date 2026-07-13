import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  LocalTransportKind,
  localPipeEndpoint,
  localProtocolTransport,
  discoverOpenCanonProject,
  discoverOpenCanonProjectsFromRoots,
  ProcessLifecycleStatus,
  ProcessLifecycleEventKind,
  RuntimeStatus,
  RuntimeCliInvocationKind,
  chooseRuntimePort,
  inspectAllRuntimes,
  inspectProjectRuntime,
  inspectRuntimeEntry,
  inspectService,
  acquireProjectWorkerLease,
  readRuntimeLifecycleEvents,
  readRuntimeRegistry,
  readRuntimeRegistryDiagnostics,
  readProjectRuntimeEntry,
  readProjectWorkerLease,
  readServiceEntry,
  forgetRuntimeEntry,
  forgetServiceEntry,
  renderLifecycleEventsMarkdown,
  renderRuntimeListMarkdown,
  renderRuntimeStatusMarkdown,
  renderServiceStatusMarkdown,
  reconcileProjectRuntimes,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  serveLocalProtocolPipe,
  startProjectRuntime,
  startService,
  startServiceServer,
  stopService,
  stopProjectRuntime,
  waitForProjectRuntimeReady,
  upsertRuntimeEntry,
  upsertServiceEntry,
  writeRuntimeRegistry,
  defaultRuntimeNamespace,
  defaultServiceRegistryPath,
  projectRuntimePath,
  runtimeNamespaceForRegistry,
  RuntimeNamespaceEnv,
  StableRuntimeNamespace,
  validateRuntimeNamespace,
  runtimeLogPath,
} from "@opencanon/runtime";
import {
  processIsRunning,
  readyFakeServiceCliSource,
  readyFakeRuntimeCliSource,
  testLifecycle,
  testRuntimeIdentity,
  testRuntimeLease,
  testRuntimePipeEndpoint,
  testServiceLease,
  testServicePipeEndpoint,
  waitForSpawnedPid,
  waitUntilProcessStops,
  writeProjectWorkerLease,
  writeStartupLock,
} from "./service-support.ts";
import { createAuthoringProject } from "./support.ts";
import { parseOpenCanonProblemFromError } from "@opencanon/core";

test("runtime namespaces isolate installed, source, and explicit registries", () => {
  const previous = process.env[RuntimeNamespaceEnv];
  delete process.env[RuntimeNamespaceEnv];
  try {
    const sourceCli = path.join("/workspace", "opencanon", "packages", "cli", "src", "index.ts");
    const sourceNamespace = defaultRuntimeNamespace(sourceCli);
    assert.match(sourceNamespace, /^dev-[a-f0-9]{12}$/);
    assert.equal(defaultRuntimeNamespace("/opt/opencanon/cli.js"), StableRuntimeNamespace);
    assert.equal(defaultServiceRegistryPath("/home/test", StableRuntimeNamespace), path.join("/home/test", ".opencanon", "namespaces", "stable", "service.json"));

    const sourceRegistry = defaultServiceRegistryPath("/home/test", sourceNamespace);
    const stableRegistry = defaultServiceRegistryPath("/home/test", StableRuntimeNamespace);
    assert.equal(runtimeNamespaceForRegistry(sourceRegistry), sourceNamespace);
    assert.equal(runtimeNamespaceForRegistry(stableRegistry), StableRuntimeNamespace);
    assert.notEqual(projectRuntimePath("/project", sourceRegistry), projectRuntimePath("/project", stableRegistry));

    process.env[RuntimeNamespaceEnv] = "review-runtime";
    assert.equal(defaultRuntimeNamespace(sourceCli), "review-runtime");
    assert.match(runtimeNamespaceForRegistry("/tmp/service.json"), /^custom-[a-f0-9]{12}$/);
    assert.throws(() => validateRuntimeNamespace("../escape"), /runtime namespace/i);
  } finally {
    if (previous === undefined) delete process.env[RuntimeNamespaceEnv];
    else process.env[RuntimeNamespaceEnv] = previous;
  }
});

test("two runtime namespaces can own the same project concurrently", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-namespace-coexist-"));
  const stableRegistry = defaultServiceRegistryPath(path.join(rootDir, "home"), StableRuntimeNamespace);
  const sourceRegistry = defaultServiceRegistryPath(path.join(rootDir, "home"), "dev-test-source");
  const fakeCliPath = path.join(rootDir, "ready-opencanon.mjs");
  const originalCli = process.env.OPENCANON_CLI;
  let stablePid: number | undefined;
  let sourcePid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const stable = await startProjectRuntime({ cwd: rootDir, registryPath: stableRegistry, idleTimeoutMs: 0 });
    stablePid = stable.entry.pid;
    const source = await startProjectRuntime({ cwd: rootDir, registryPath: sourceRegistry, idleTimeoutMs: 0 });
    sourcePid = source.entry.pid;

    assert.notEqual(stablePid, sourcePid);
    assert.equal(processIsRunning(stablePid), true);
    assert.equal(processIsRunning(sourcePid), true);
    assert.equal(readProjectRuntimeEntry(rootDir, stableRegistry)?.pid, stablePid);
    assert.equal(readProjectRuntimeEntry(rootDir, sourceRegistry)?.pid, sourcePid);
    assert.notEqual(projectRuntimePath(rootDir, stableRegistry), projectRuntimePath(rootDir, sourceRegistry));
    assert.equal(existsSync(projectRuntimePath(rootDir, stableRegistry)), true);
    assert.equal(existsSync(projectRuntimePath(rootDir, sourceRegistry)), true);
  } finally {
    await stopProjectRuntime(rootDir, stableRegistry).catch(() => undefined);
    await stopProjectRuntime(rootDir, sourceRegistry).catch(() => undefined);
    if (stablePid && processIsRunning(stablePid)) process.kill(stablePid, "SIGKILL");
    if (sourcePid && processIsRunning(sourcePid)) process.kill(sourcePid, "SIGKILL");
    if (originalCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalCli;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an owner-bound service exits when its owner process stops", { timeout: 20000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-owned-service-"));
  const registryPath = path.join(rootDir, "service.json");
  const owner = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  const previousCli = process.env.OPENCANON_CLI;
  const previousOwnerPid = process.env.OPENCANON_SERVICE_OWNER_PID;
  let servicePid: number | undefined;
  try {
    if (!owner.pid) throw new Error("test owner process did not start");
    process.env.OPENCANON_CLI = path.resolve("packages/cli/src/index.ts");
    process.env.OPENCANON_SERVICE_OWNER_PID = String(owner.pid);
    const started = await startService({ cwd: rootDir, registryPath });
    servicePid = started.entry.pid;
    assert.equal(readServiceEntry(registryPath)?.ownerPid, owner.pid);

    owner.kill("SIGTERM");
    assert.equal(await waitUntilProcessStops(owner.pid, 3000), true);
    assert.equal(await waitUntilProcessStops(servicePid, 5000), true);
    assert.equal(readServiceEntry(registryPath), undefined);
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (servicePid && processIsRunning(servicePid)) process.kill(servicePid, "SIGKILL");
    if (owner.pid && processIsRunning(owner.pid)) process.kill(owner.pid, "SIGKILL");
    if (previousCli === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = previousCli;
    if (previousOwnerPid === undefined) delete process.env.OPENCANON_SERVICE_OWNER_PID;
    else process.env.OPENCANON_SERVICE_OWNER_PID = previousOwnerPid;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

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

test("project runtime inspection reports live identity mismatch as stale", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-identity-stale-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const firstCli = path.join(rootDir, "first-opencanon.mjs");
  const secondCli = path.join(rootDir, "second-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  let pid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(firstCli, readyFakeRuntimeCliSource());
    writeFileSync(secondCli, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = firstCli;
    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    pid = started.entry.pid;

    process.env.OPENCANON_CLI = secondCli;
    const inspection = await inspectProjectRuntime(rootDir, registryPath);

    assert.equal(inspection?.status, RuntimeStatus.Stale);
    assert.match(inspection?.message ?? "", /different OpenCanon runtime/);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service start replaces live service identity mismatch", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-identity-replace-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const firstCli = path.join(rootDir, "first-service-opencanon.mjs");
  const secondCli = path.join(rootDir, "second-service-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  let firstPid: number | undefined;
  let secondPid: number | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(firstCli, readyFakeServiceCliSource());
    writeFileSync(secondCli, readyFakeServiceCliSource());
    process.env.OPENCANON_CLI = firstCli;
    const first = await startService({ cwd: rootDir, registryPath });
    firstPid = first.entry.pid;

    process.env.OPENCANON_CLI = secondCli;
    const stale = await inspectService(registryPath, rootDir);
    assert.equal(stale?.status, RuntimeStatus.Stale);
    assert.match(stale?.message ?? "", /different OpenCanon runtime/);

    const second = await startService({ cwd: rootDir, registryPath });
    secondPid = second.entry.pid;

    assert.equal(second.status, "started");
    assert.notEqual(secondPid, firstPid);
    assert(firstPid !== undefined);
    assert.equal(await waitUntilProcessStops(firstPid, 3000), true);
  } finally {
    await stopService(registryPath).catch(() => undefined);
    if (firstPid && processIsRunning(firstPid)) process.kill(firstPid, "SIGKILL");
    if (secondPid && processIsRunning(secondPid)) process.kill(secondPid, "SIGKILL");
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
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
    writeProjectWorkerLease(rootDir, 9_999_999, "stale-worker", registryPath);

    const result = await stopProjectRuntime(rootDir, registryPath);

    assert.equal(result.status, "stale");
    assert.equal(readProjectWorkerLease(rootDir, registryPath), undefined);
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
    writeProjectWorkerLease(rootDir, conflictingPid, "conflicting-worker", registryPath);
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });

    assert.equal(started.status, "started");
    assert.equal(await waitUntilProcessStops(conflictingPid, 3000), true);
    assert.equal(readProjectWorkerLease(rootDir, registryPath), undefined);
    assert.equal(readRuntimeRegistry(registryPath).length, 1);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (conflictingPid && processIsRunning(conflictingPid)) conflicting.kill("SIGKILL");
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service ensure returns only after a slow-starting runtime is healthy", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-slow-start-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "slow-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource({ startupDelayMs: 250 }));
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
    assert(Date.now() - startedAt >= 200);

    const payload = JSON.parse(text) as { data?: { project?: { entry?: { lifecycle?: { status?: string } } } } };
    assert.equal(payload.data?.project?.entry?.lifecycle?.status, ProcessLifecycleStatus.Running);
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

test("project start returns a ready runtime", { timeout: 10000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-ready-wait-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const fakeCliPath = path.join(rootDir, "ready-opencanon.mjs");
  const originalOverride = process.env.OPENCANON_CLI;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    writeFileSync(fakeCliPath, readyFakeRuntimeCliSource());
    process.env.OPENCANON_CLI = fakeCliPath;

    const started = await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    const ready = await waitForProjectRuntimeReady(rootDir, { registryPath, timeoutMs: 3000, intervalMs: 50 });

    assert.equal(started.status, "started");
    assert.equal(ready.status, "running");
    assert.equal(ready.entry.pid, started.entry.pid);
    assert.equal(ready.entry.lifecycle.status, ProcessLifecycleStatus.Running);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.lifecycle.status, ProcessLifecycleStatus.Running);
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

test("project start returns one typed failure for a missing conventions entrypoint", { timeout: 30000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-missing-canon-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const sourceCliPath = path.resolve("packages/cli/src/index.ts");
  const originalOverride = process.env.OPENCANON_CLI;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem" }));
    process.env.OPENCANON_CLI = sourceCliPath;

    let startupError: unknown;
    try {
      await startProjectRuntime({ cwd: rootDir, registryPath, idleTimeoutMs: 0 });
    } catch (error) {
      startupError = error;
    }

    const problem = parseOpenCanonProblemFromError(startupError);
    const runtimeLog = readFileSync(runtimeLogPath(rootDir, registryPath), "utf8");
    assert(problem, `${startupError instanceof Error ? startupError.message : String(startupError)}\n${runtimeLog}`);
    assert.equal(problem?.code, "project-definition-missing");
    assert.equal(problem?.path, "opencanon/conventions/index.ts");
    assert.equal(problem?.retryable, false);
    assert.match(problem?.action ?? "", /opencanon init --yes/);
    assert.deepEqual(readRuntimeRegistry(registryPath), []);
    assert.equal(existsSync(path.join(path.dirname(runtimeLogPath(rootDir, registryPath)), "startup")), false);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service preserves typed project startup failures", { timeout: 30000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-missing-canon-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const sourceCliPath = path.resolve("packages/cli/src/index.ts");
  const originalOverride = process.env.OPENCANON_CLI;
  let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem" }));
    process.env.OPENCANON_CLI = sourceCliPath;
    server = await startServiceServer({ port: 0, registryPath, authToken: "service-token", reconcileIntervalMs: false });

    const response = await fetch(`${server.url}/api/projects/ensure`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ rootDir }),
    });
    const payload = await response.json() as { error?: { kind?: string; problem?: { code?: string; retryable?: boolean; path?: string } } };

    assert.equal(response.status, 422);
    assert.equal(payload.error?.kind, "problem");
    assert.equal(payload.error?.problem?.code, "project-definition-missing");
    assert.equal(payload.error?.problem?.retryable, false);
    assert.equal(payload.error?.problem?.path, "opencanon/conventions/index.ts");
    assert.deepEqual(readRuntimeRegistry(registryPath), []);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    await server?.stop().catch(() => undefined);
    if (originalOverride === undefined) delete process.env.OPENCANON_CLI;
    else process.env.OPENCANON_CLI = originalOverride;
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

test("project start supports JSON format", { timeout: 60000 }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-start-json-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };

  try {
    createAuthoringProject(rootDir);

    const start = spawnSync(process.execPath, [cli, "project", "start", "--format", "json"], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const payload = JSON.parse(start.stdout) as {
      project: { status: string; entry: { rootDir: string; authToken?: string } };
      service: { status: string; entry: { authToken?: string } };
    };
    assert(["started", "already-running"].includes(payload.project.status));
    assert.equal(payload.project.entry.rootDir, realpathSync(rootDir));
    assert.equal(payload.project.entry.authToken, undefined);
    assert.equal(payload.service.status, "running");
    assert.equal(payload.service.entry.authToken, undefined);
  } finally {
    spawnSync(process.execPath, [cli, "project", "stop", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    spawnSync(process.execPath, [cli, "service", "stop", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
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
  assert(projectHelp.stdout.includes("opencanon project start --format json"));
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

test("service start supports token-safe JSON output", { timeout: 60000 }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-start-json-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };

  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    const started = spawnSync(process.execPath, [cli, "service", "start", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const payload = JSON.parse(started.stdout) as { service: { status: string; message: string; entry: Record<string, unknown> } };
    assert(["started", "already-running"].includes(payload.service.status));
    assert(payload.service.message.length > 0);
    assert.equal(payload.service.entry.authToken, undefined);
    assert.equal(payload.service.entry.pid, readServiceEntry(registryPath)?.pid);
  } finally {
    spawnSync(process.execPath, [cli, "service", "stop", "--format", "json"], { cwd: rootDir, env, encoding: "utf8" });
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
        body: JSON.stringify({ rootDir, idleTimeoutMs: 30000 }),
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

test("service reconciliation preserves runtimes busy with project work", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-busy-runtime-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });

  try {
    const pid = await waitForSpawnedPid(child, "busy runtime");
    const entry = {
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pipeEndpoint: testRuntimePipeEndpoint(rootDir, registryPath),
      pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      leaseId: "busy-runtime-lease",
      lifecycle: {
        ...testLifecycle(ProcessLifecycleStatus.Busy),
        updatedAt: new Date().toISOString(),
        message: "Manual reindex is running.",
      },
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)),
    };
    upsertRuntimeEntry(entry, registryPath);

    const inspection = await inspectRuntimeEntry(entry, registryPath);
    assert.equal(inspection.status, "busy");

    const result = await reconcileProjectRuntimes({ registryPath });
    assert.equal(result.busy, 1);
    assert.equal(result.restarted, 0);
    assert.equal(result.unhealthy, 0);
    assert.equal(readRuntimeRegistry(registryPath)[0]?.pid, pid);
    assert.equal(processIsRunning(pid), true);
  } finally {
    if (child.pid && processIsRunning(child.pid)) process.kill(child.pid, "SIGKILL");
    forgetRuntimeEntry(rootDir, registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime inspection rejects health from a different process lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-service-lease-mismatch-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  const pipeEndpoint = testRuntimePipeEndpoint(rootDir, registryPath);
  const pipeServer = await serveLocalProtocolPipe({
    endpoint: pipeEndpoint,
    async routeRequest() {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          status: "ready",
          process: { kind: "runtime", pid: process.pid, leaseId: "wrong-lease" },
          engine: { engineVersion: "0.4.0-test", packageVersion: "0.4.0-test", napiVersion: "test", schemaVersion: 1 },
          refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
          startedAt: new Date().toISOString(),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  try {
    const inspection = await inspectRuntimeEntry({
      rootDir,
      host: "127.0.0.1",
      port: 9,
      url: "http://127.0.0.1:9",
      pid: process.pid,
      startedAt: "2026-05-01T00:00:00.000Z",
      logPath: path.join(rootDir, ".opencanon", "runtime.log"),
      authToken: "test-token",
      ...testRuntimeLease("expected-lease"),
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)),
      pipeEndpoint,
    });

    assert.equal(inspection.status, "unhealthy");
    assert.equal(inspection.message, "Runtime health endpoint responded for a different process lease.");
  } finally {
    await pipeServer.stop(true).catch(() => undefined);
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
