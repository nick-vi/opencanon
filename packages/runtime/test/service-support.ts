import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LocalControlProtocolVersion,
  LocalTransportKind,
  ProcessLifecycleStatus,
  localPipeEndpoint,
  projectWorkerLeasePath,
} from "@opencanon/runtime";

export const testRuntimeIdentity = {
  transport: LocalTransportKind.Pipe,
  protocolVersion: LocalControlProtocolVersion,
  runtimeVersion: "0.4.0-test",
  runtimeFingerprint: "sha256:test-runtime",
  cliPath: process.execPath,
};

export function testLifecycle(status: ProcessLifecycleStatus = ProcessLifecycleStatus.Running) {
  return {
    status,
    updatedAt: "2026-05-01T00:00:00.000Z",
    restart: { attempts: 0 },
  };
}

export function testRuntimeLease(leaseId = "test-runtime-lease") {
  return {
    leaseId,
    lifecycle: testLifecycle(),
  };
}

export function testServiceLease(leaseId = "test-service-lease") {
  return {
    leaseId,
    lifecycle: testLifecycle(),
  };
}

export function testRuntimePipeEndpoint(rootDir: string, registryPath: string): string {
  return localPipeEndpoint({ scope: "runtime", key: `${registryPath}:${rootDir}` });
}

export function testStartupLockPath(registryPath: string, kind: "service" | "runtime", key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(path.dirname(registryPath), `opencanon-${kind}-${hash}.start.lock`);
}

export function writeStartupLock(registryPath: string, kind: "service" | "runtime", key: string, pid: number): string {
  const lockPath = testStartupLockPath(registryPath, kind, key);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(lockPath, JSON.stringify({ pid, scope: `opencanon-${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, startedAt: now, heartbeatAt: now }, null, 2));
  return lockPath;
}

export function testServicePipeEndpoint(registryPath: string): string {
  return localPipeEndpoint({ scope: "service", key: registryPath });
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilProcessStops(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsRunning(pid);
}

export async function waitForSpawnedPid(child: ReturnType<typeof spawn>, description: string): Promise<number> {
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

export function writeProjectWorkerLease(rootDir: string, pid: number, leaseId = "test-worker-lease", registryPath?: string): void {
  const lockPath = projectWorkerLeasePath(rootDir, registryPath);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(lockPath, JSON.stringify({ rootDir, pid, leaseId, acquiredAt: now, heartbeatAt: now }, null, 2));
}

export function readyFakeServiceCliSource(options: { exitOnceMarkerPath?: string; pidPathEnv?: string } = {}): string {
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

export function readyFakeRuntimeCliSource(options: { exitOnceMarkerPath?: string; pidPathEnv?: string; startupDelayMs?: number; writeStateMarker?: boolean } = {}): string {
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
    ...(options.writeStateMarker
      ? [
          "const statePath = process.env.OPENCANON_PROJECT_STATE_PATH;",
          'if (!statePath) throw new Error("Project State path is missing.");',
          "mkdirSync(path.dirname(statePath), { recursive: true });",
          "writeFileSync(statePath, String(process.pid));",
        ]
      : []),
    ...(options.startupDelayMs ? [`await new Promise((resolve) => setTimeout(resolve, ${options.startupDelayMs}));`] : []),
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
