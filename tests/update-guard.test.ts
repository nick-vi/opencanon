import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createRuntimeUpdateSafetyGuard, renderRuntimeUpdateApplyMarkdown } from "../packages/cli/src/update.ts";
import { currentEngineTarget, runtimeUpdateProjectRefreshAction } from "@opencanon/distribution";
import {
  LocalControlProtocolVersion,
  LocalTransportKind,
  ProcessLifecycleStatus,
  localPipeEndpoint,
  upsertRuntimeEntry,
  upsertServiceEntry,
} from "@opencanon/runtime";

const ambientRegistryPath = process.env.OPENCANON_SERVICE_REGISTRY_PATH;
let isolatedRegistryRoot = "";

beforeEach(() => {
  isolatedRegistryRoot = mkdtempSync(path.join(tmpdir(), "opencanon-update-guard-registry-"));
  process.env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(isolatedRegistryRoot, "service.json");
});

afterEach(() => {
  if (ambientRegistryPath === undefined) delete process.env.OPENCANON_SERVICE_REGISTRY_PATH;
  else process.env.OPENCANON_SERVICE_REGISTRY_PATH = ambientRegistryPath;
  rmSync(isolatedRegistryRoot, { recursive: true, force: true });
});

test("CLI update safety guard refuses while the global service is registered", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-update-guard-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    process.env.OPENCANON_SERVICE_REGISTRY_PATH = registryPath;
    upsertServiceEntry(
      {
        host: "127.0.0.1",
        port: 9,
        url: "http://127.0.0.1:9",
        pipeEndpoint: localPipeEndpoint({ scope: "service", key: registryPath }),
        pid: process.pid,
        leaseId: "update-test-service-lease",
        startedAt: "2026-05-01T00:00:00.000Z",
        logPath: path.join(rootDir, "global", "service.log"),
        authToken: "service-token",
        lifecycle: {
          status: ProcessLifecycleStatus.Running,
          updatedAt: "2026-05-01T00:00:00.000Z",
          restart: { attempts: 0 },
        },
        ...testRuntimeIdentity,
      },
      registryPath,
    );

    await assert.rejects(
      async () => {
        await createRuntimeUpdateSafetyGuard().assertSafeToUpdate();
      },
      /all OpenCanon processes to be stopped/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CLI update safety guard refuses while any project runtime is registered", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-update-guard-runtime-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    process.env.OPENCANON_SERVICE_REGISTRY_PATH = registryPath;
    upsertRuntimeEntry(
      {
        rootDir,
        host: "127.0.0.1",
        port: 9,
        url: "http://127.0.0.1:9",
        pipeEndpoint: localPipeEndpoint({ scope: "runtime", key: rootDir }),
        pid: process.pid,
        leaseId: "update-test-runtime-lease",
        startedAt: "2026-05-01T00:00:00.000Z",
        logPath: path.join(rootDir, ".opencanon", "runtime.log"),
        authToken: "runtime-token",
        lifecycle: {
          status: ProcessLifecycleStatus.Running,
          updatedAt: "2026-05-01T00:00:00.000Z",
          restart: { attempts: 0 },
        },
        ...testRuntimeIdentity,
      },
      registryPath,
    );

    await assert.rejects(
      async () => {
        await createRuntimeUpdateSafetyGuard().assertSafeToUpdate();
      },
      /all OpenCanon processes to be stopped/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CLI update apply output includes managed project artifact refresh action", () => {
  const markdown = renderRuntimeUpdateApplyMarkdown({
    status: "installed",
    check: {
      status: "current",
      manifestSource: "/tmp/manifest.json",
      channel: "stable",
      runtimeVersion: "0.4.0-test",
      requiredNode: ">=24.12.0",
      target: currentEngineTarget(),
      bundleUrl: "bundle.tar.gz",
      resolvedBundleSource: "/tmp/bundle.tar.gz",
      runtimeRoot: "/tmp/runtime",
      runtimePath: "/tmp/runtime/engine/opencanon.node",
      expectedSha256: "0".repeat(64),
      currentSha256: "0".repeat(64),
    },
    projectActions: [runtimeUpdateProjectRefreshAction()],
  });

  assert.match(markdown, /Project actions:/);
  assert.match(markdown, /Refresh managed project artifacts/);
  assert.match(markdown, /`opencanon doctor --fix`/);
});

const testRuntimeIdentity = {
  transport: LocalTransportKind.Pipe,
  protocolVersion: LocalControlProtocolVersion,
  runtimeVersion: "0.4.0-test",
  runtimeFingerprint: "sha256:test-runtime",
  cliPath: process.execPath,
};
