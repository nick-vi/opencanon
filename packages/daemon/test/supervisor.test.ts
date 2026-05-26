import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { inspectAllDaemons, readDaemonRegistry, readDaemonRegistryDiagnostics, removeDaemonEntry, renderDaemonListMarkdown, renderDaemonStatusMarkdown, upsertDaemonEntry, writeDaemonRegistry } from "@opencanon/daemon";

test("daemon supervisor stores project daemon registry entries", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-supervisor-"));
  const registryPath = path.join(rootDir, "global", "daemons.json");
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "daemon.log"),
    authToken: "test-token",
  };

  try {
    writeDaemonRegistry([entry], registryPath);
    assert.deepEqual(readDaemonRegistry(registryPath), [entry]);

    upsertDaemonEntry({ ...entry, port: 4768, url: "http://127.0.0.1:4768" }, registryPath);
    assert.equal(readDaemonRegistry(registryPath)[0].port, 4768);
    assert(renderDaemonListMarkdown([{ entry, status: "running", message: "ready" }]).includes(rootDir));

    removeDaemonEntry(rootDir, registryPath);
    assert.deepEqual(readDaemonRegistry(registryPath), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon supervisor reports malformed registry state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-supervisor-malformed-"));
  const registryPath = path.join(rootDir, "global", "daemons.json");
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "daemon.log"),
    authToken: "test-token",
  };

  try {
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ version: 1, daemons: [entry, { ...entry, authToken: "" }] }));

    assert(readDaemonRegistryDiagnostics(registryPath).some((diagnostic) => diagnostic.includes("malformed daemon registry entry 2")));
    assert.deepEqual(readDaemonRegistry(registryPath), [entry]);

    const inspections = await inspectAllDaemons(registryPath);
    assert.equal(inspections.length, 1);
    assert.deepEqual(readDaemonRegistry(registryPath), [entry]);

    writeFileSync(registryPath, "{");
    assert(readDaemonRegistryDiagnostics(registryPath).some((diagnostic) => diagnostic.includes("malformed daemon registry")));
    assert.deepEqual(readDaemonRegistry(registryPath), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon status renders runtime health and state details", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-supervisor-status-"));
  const entry = {
    rootDir,
    host: "127.0.0.1",
    port: 4767,
    url: "http://127.0.0.1:4767",
    pid: process.pid,
    startedAt: "2026-05-01T00:00:00.000Z",
    logPath: path.join(rootDir, ".opencanon", "daemon.log"),
    authToken: "test-token",
  };

  try {
    const markdown = renderDaemonStatusMarkdown(
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
          watcher: { running: true, bufferedEvents: 2, stale: false },
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
            watcher: { running: true, bufferedEvents: 2, stale: false },
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
    assert(markdown.includes("Watcher: running (buffered 2, fresh)"));
    assert(markdown.includes("Files: 3"));
    assert(markdown.includes("Findings: 1"));
    assert(markdown.includes("Cache: 4 hits, 5 misses"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
