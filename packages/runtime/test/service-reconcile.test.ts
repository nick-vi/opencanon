import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  buildServiceOverview,
  chooseRuntimePort,
  inspectAllRuntimes,
  inspectRuntimeEntry,
  LocalControlProtocolVersion,
  LocalTransportKind,
  ProcessLifecycleEventKind,
  ProcessLifecycleStatus,
  readRuntimeLifecycleEvents,
  readRuntimeRegistry,
  readServiceEntry,
  repairServiceProcessState,
  reconcileProjectRuntimes,
  forgetRuntimeEntry,
  forgetRuntimeEntryForPid,
  forgetServiceEntryForPid,
  renderLifecycleEventsMarkdown,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  startProjectRuntime,
  startService,
  stopProjectRuntime,
  stopService,
  upsertRuntimeEntry,
  upsertServiceEntry,
  ServiceProjectStatusValue,
} from "@opencanon/runtime";
import {
  processIsRunning,
  readyFakeRuntimeCliSource,
  readyFakeServiceCliSource,
  testLifecycle,
  testRuntimeIdentity,
  testRuntimeLease,
  testRuntimePipeEndpoint,
  testServiceLease,
  testServicePipeEndpoint,
  waitForSpawnedPid,
  waitUntilProcessStops,
} from "./service-support.ts";

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
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)),
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
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)),
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
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)),
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
