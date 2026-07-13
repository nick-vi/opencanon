import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ChangeCheckRunEventType } from "@opencanon/core";
import {
  readRuntimeRegistry,
  runtimeAuthHeaders,
  startOpenCanonRuntime,
  upsertRuntimeEntry,
} from "@opencanon/runtime";
import {
  createChangeRunProject,
  quotedNode,
  readRunEvents,
  shellQuote,
  startRun,
} from "./change-run-test-support.ts";

const IntegrationTimeoutMs = 60_000;
const LifecycleTransitionTimeoutMs = 30_000;

test("active Change checks hold the supervised runtime busy lifecycle", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject(
    "busy",
    `${quotedNode()} -e ${shellQuote("setTimeout(() => console.log('finished'), 700)")}`,
  );
  const registryDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-registry-"));
  const registryPath = path.join(registryDir, "service.json");
  const leaseId = `runtime-${process.pid}-busy-test`;
  const previousRegistry = process.env.OPENCANON_SERVICE_REGISTRY_PATH;
  const previousLease = process.env.OPENCANON_RUNTIME_LEASE_ID;
  process.env.OPENCANON_SERVICE_REGISTRY_PATH = registryPath;
  process.env.OPENCANON_RUNTIME_LEASE_ID = leaseId;
  let server: Awaited<ReturnType<typeof startOpenCanonRuntime>> | undefined;
  try {
    server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const url = new URL(server.url);
    upsertRuntimeEntry({
      rootDir,
      host: url.hostname,
      port: Number(url.port),
      url: server.url,
      pipeEndpoint: server.pipeEndpoint,
      pid: process.pid,
      leaseId,
      startedAt: new Date().toISOString(),
      logPath: path.join(rootDir, "runtime.log"),
      authToken: server.authToken,
      lifecycle: { status: "running", updatedAt: new Date().toISOString(), message: "Runtime health endpoint is ready.", restart: { attempts: 0 } },
      transport: "pipe",
      protocolVersion: 1,
      runtimeVersion: "test",
      runtimeFingerprint: "test",
      cliPath: process.argv[1] ?? "test",
    }, registryPath);

    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "busy-change", "stream");
    assert.equal(readRuntimeRegistry(registryPath)[0]?.lifecycle.status, "busy");
    const events = await readRunEvents(server.url, headers, started.id);
    assert.equal(events.at(-1)?.type, ChangeCheckRunEventType.Passed);
    await waitForRuntimeLifecycle(registryPath, "running");
  } finally {
    await server?.stop();
    restoreEnvironment("OPENCANON_SERVICE_REGISTRY_PATH", previousRegistry);
    restoreEnvironment("OPENCANON_RUNTIME_LEASE_ID", previousLease);
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  }
});

async function waitForRuntimeLifecycle(registryPath: string, expected: "running"): Promise<void> {
  const deadline = Date.now() + LifecycleTransitionTimeoutMs;
  while (Date.now() < deadline) {
    if (readRuntimeRegistry(registryPath)[0]?.lifecycle.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`runtime lifecycle did not become ${expected}`);
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
