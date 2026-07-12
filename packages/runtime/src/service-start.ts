import { spawn } from "node:child_process";
import { chmodSync, openSync } from "node:fs";
import path from "node:path";
import { resolveRootDir, serializeOpenCanonProblem } from "@opencanon/core";
import { assertSafeRuntimeHost, createRuntimeAuthToken } from "./auth.ts";
import { localPipeEndpoint, localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { formatHttpBaseUrl } from "./runtime.ts";
import { stopProjectRuntime, stopService } from "./service-control.ts";
import { discoverOpenCanonProject } from "./service-discovery.ts";
import { runtimeIdentityForEntrypoint, runtimeIdentityMatches, ownerPidFromEnv, createProcessLeaseId } from "./service-identity.ts";
import { createLifecycle, withLifecycle } from "./service-lifecycle.ts";
import { inspectProjectRuntime, inspectService, runtimeBusyStillWithinBudget, runtimeStartupStillWithinGrace, waitForRuntimeHealth, waitForRuntimeHealthResult, waitForServiceHealthResult } from "./service-monitor.ts";
import {
  chooseAvailablePort,
  portRangeKeyForRegistry,
  repairServiceProcessArtifacts,
  retireConflictingProjectWorkerLease,
  retireMalformedRegistryProcessLeases,
  retireUnsupportedRegistry,
  retireUnusableProjectRuntimeEntry,
  serviceRegistryKeepPids,
  terminateSpawnedProcess,
} from "./service-process.ts";
import { errorMessage, isLocalProtocolTransportFailure, projectNotFoundProblem } from "./service-http.ts";
import { runtimeCliInvocation } from "./service-entrypoint.ts";
import { clearRuntimeStartupResults, readRuntimeStartupFailure, removeRuntimeStartupResult, runtimeStartupResultPath } from "./service-startup-result.ts";
import { runtimeNamespaceForRegistry } from "./service-namespace.ts";
import {
  appendLifecycleEvent,
  closeFileDescriptor,
  ensurePrivateDirectory,
  forgetRuntimeEntry,
  forgetRuntimeEntryIfPid,
  forgetServiceEntry,
  forgetServiceEntryIfPid,
  readRuntimeRegistry,
  runtimeLogPath,
  serviceLogPath,
  serviceRegistryPath,
  startupLockScope,
  updateRuntimeLifecycle,
  upsertRuntimeEntry,
  upsertServiceEntry,
  waitForChildSpawn,
  withStartupLock,
} from "./service-storage.ts";
import {
  AutoPortStartupAttempts,
  HiddenRegistryArg,
  LocalHealthWaitFailure,
  LocalPipeCleanupAgeMs,
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  StartProjectRuntimeStatus,
  ProjectRuntimeEnv,
  RuntimeStatus,
  ServiceApiRoute,
  ServiceArg,
  ServiceEnv,
  defaultProjectRuntimeIdleTimeoutMs,
  defaultRuntimePort,
  defaultServicePort,
  type EnsureProjectRuntimeResult,
  type RuntimeRegistryEntry,
  type ServiceRegistryEntry,
  type StartProjectRuntimeResult,
  type StartServiceResult,
} from "./service-types.ts";

export async function startProjectRuntime(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
  idleTimeoutMs?: number;
}): Promise<StartProjectRuntimeResult> {
  const rootDir = resolveRootDir(input.cwd);
  const host = input.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, input.allowRemote);
  const registryPath = input.registryPath ?? serviceRegistryPath();
  return await withStartupLock(registryPath, startupLockScope("runtime", rootDir), async () => {
    await retireUnsupportedRegistry(registryPath);
    await retireMalformedRegistryProcessLeases(registryPath);
    await retireUnusableProjectRuntimeEntry(rootDir, registryPath);
    const cli = runtimeCliInvocation(rootDir, ["project", "start", "--foreground", "--host", host, "--port", String(input.port ?? defaultRuntimePort)]);
    const runtimeIdentity = runtimeIdentityForEntrypoint(cli.entrypoint);
    const existing = await inspectProjectRuntime(rootDir, registryPath);
    const nowMs = Date.now();
    await retireConflictingProjectWorkerLease(rootDir, registryPath, existing?.entry.pid, {
      allowStaleAllowedPid: existing ? runtimeStartupStillWithinGrace(existing.entry, nowMs) || runtimeBusyStillWithinBudget(existing.entry, nowMs) : false,
    });
    if (existing && !runtimeIdentityMatches(existing.entry, runtimeIdentity)) {
      await stopProjectRuntime(rootDir, registryPath);
    } else if (existing?.status === RuntimeStatus.Starting) {
      const ready = await waitForRuntimeHealth(existing.entry);
      if (ready) {
        const runningEntry = updateRuntimeLifecycle(existing.entry, createLifecycle(ProcessLifecycleStatus.Running, "Runtime health endpoint is ready."), registryPath);
        return {
          status: StartProjectRuntimeStatus.AlreadyRunning,
          entry: runningEntry,
          message: `OpenCanon project runtime already registered for ${rootDir}.`,
        };
      }
      await stopProjectRuntime(rootDir, registryPath);
    } else if (existing?.status === RuntimeStatus.Unhealthy) {
      await stopProjectRuntime(rootDir, registryPath);
    } else if (existing?.status === RuntimeStatus.Busy) {
      return {
        status: StartProjectRuntimeStatus.AlreadyRunning,
        entry: existing.entry,
        message: `OpenCanon project runtime is busy for ${rootDir}.`,
      };
    } else if (existing?.status === RuntimeStatus.Running) {
      return {
        status: StartProjectRuntimeStatus.AlreadyRunning,
        entry: existing.entry,
        message: `OpenCanon project runtime already registered for ${rootDir}.`,
      };
    }
    if (existing?.status === RuntimeStatus.Failed || existing?.status === RuntimeStatus.Stale) forgetRuntimeEntry(rootDir, registryPath);
    await retireConflictingProjectWorkerLease(rootDir, registryPath);
    clearRuntimeStartupResults(rootDir, registryPath);

    const attemptedPorts: number[] = [];
    const startupAttempts = input.port === undefined ? AutoPortStartupAttempts : 1;
    let lastStartupError: Error | undefined;
    for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
      const port = await chooseAvailablePort({
        host,
        preferredPort: input.port,
        defaultPort: defaultRuntimePort,
        usedPorts: [...readRuntimeRegistry(registryPath).map((entry) => entry.port), ...attemptedPorts],
        rangeKey: portRangeKeyForRegistry(registryPath, rootDir),
      });
      attemptedPorts.push(port);
      const logPath = runtimeLogPath(rootDir, registryPath);
      const authToken = createRuntimeAuthToken();
      const leaseId = createProcessLeaseId();
      const startupResultPath = runtimeStartupResultPath(rootDir, leaseId, registryPath);
      const pipeEndpoint = localPipeEndpoint({ scope: "runtime", key: `${registryPath}:${rootDir}` });
      ensurePrivateDirectory(path.dirname(logPath));
      const logFd = openSync(logPath, "a", 0o600);
      chmodSync(logPath, 0o600);
      const cliArgs = [...cli.args];
      cliArgs.splice(cliArgs.indexOf("--port") + 1, 1, String(port));
      const idleTimeoutMs = input.idleTimeoutMs ?? defaultProjectRuntimeIdleTimeoutMs;
      if (idleTimeoutMs > 0) cliArgs.push("--idle-timeout-ms", String(idleTimeoutMs));
      if (input.allowRemote) cliArgs.push(ServiceArg.AllowRemote);
      cliArgs.push(HiddenRegistryArg, registryPath);
      const child = spawn(cli.command, cliArgs, {
        cwd: rootDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          OPENCANON_CLI: cli.entrypoint.path,
          [ProjectRuntimeEnv.AuthToken]: authToken,
          [ProjectRuntimeEnv.LeaseId]: leaseId,
          [ProjectRuntimeEnv.RegistryPath]: registryPath,
          [ProjectRuntimeEnv.PipeEndpoint]: pipeEndpoint,
          [ProjectRuntimeEnv.StartupResultPath]: startupResultPath,
          [ProjectRuntimeEnv.RuntimeNamespace]: runtimeNamespaceForRegistry(registryPath),
        },
      });
      let childPid: number;
      try {
        childPid = await waitForChildSpawn(child, "OpenCanon project runtime");
        child.unref();
      } catch (error) {
        appendLifecycleEvent(registryPath, {
          kind: ProcessLifecycleEventKind.RuntimeStartupFailed,
          scope: ProcessLifecycleScope.Runtime,
          rootDir,
          leaseId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        closeFileDescriptor(logFd);
      }

      const entry: RuntimeRegistryEntry = {
        rootDir,
        host,
        port,
        url: formatHttpBaseUrl(host, port),
        pipeEndpoint,
        pid: childPid,
        leaseId,
        startedAt: new Date().toISOString(),
        logPath,
        authToken,
        lifecycle: createLifecycle(ProcessLifecycleStatus.Starting, "Waiting for runtime health endpoint."),
        ...runtimeIdentity,
      };
      upsertRuntimeEntry(entry, registryPath);
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeStarted,
        scope: ProcessLifecycleScope.Runtime,
        rootDir,
        pid: childPid,
        leaseId,
        message: "OpenCanon project runtime process spawned.",
      });

      const health = await waitForRuntimeHealthResult(entry);
      if (health.ready) {
        removeRuntimeStartupResult(startupResultPath);
        const runningEntry = updateRuntimeLifecycle(entry, createLifecycle(ProcessLifecycleStatus.Running, "Runtime health endpoint is ready."), registryPath);
        return {
          status: StartProjectRuntimeStatus.Started,
          entry: runningEntry,
          message: `OpenCanon project runtime started for ${rootDir}.`,
        };
      }

      forgetRuntimeEntryIfPid(rootDir, childPid, registryPath);
      await terminateSpawnedProcess(childPid);
      const startupProblem = readRuntimeStartupFailure(startupResultPath);
      removeRuntimeStartupResult(startupResultPath);
      lastStartupError = startupProblem
        ? new Error(serializeOpenCanonProblem(startupProblem))
        : new Error(`OpenCanon runtime did not become ready. See ${logPath}.`);
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeStartupFailed,
        scope: ProcessLifecycleScope.Runtime,
        rootDir,
        pid: childPid,
        leaseId,
        message: lastStartupError.message,
      });
      if (startupProblem?.retryable === false || health.reason !== LocalHealthWaitFailure.ProcessExited || attempt === startupAttempts - 1) {
        throw lastStartupError;
      }
    }
    throw lastStartupError ?? new Error("OpenCanon runtime did not become ready.");
  });
}

export async function startService(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
}): Promise<StartServiceResult> {
  const rootDir = resolveRootDir(input.cwd);
  const host = input.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, input.allowRemote);
  const registryPath = input.registryPath ?? serviceRegistryPath();
  return await withStartupLock(registryPath, startupLockScope("service", registryPath), async () => {
    await retireUnsupportedRegistry(registryPath);
    await retireMalformedRegistryProcessLeases(registryPath);
    const cli = runtimeCliInvocation(rootDir, ["service", "run", "--host", host, "--port", String(input.port ?? defaultServicePort)]);
    const runtimeIdentity = runtimeIdentityForEntrypoint(cli.entrypoint);
    await repairServiceProcessArtifacts({
      registryPath,
      keepPids: serviceRegistryKeepPids(registryPath),
      cleanupPipeMaxAgeMs: LocalPipeCleanupAgeMs,
    });
    const existing = await inspectService(registryPath, rootDir);
    if (existing && !runtimeIdentityMatches(existing.entry, runtimeIdentity)) {
      await stopService(registryPath);
    } else if (existing?.status === RuntimeStatus.Running && runtimeIdentityMatches(existing.entry, runtimeIdentity)) {
      return {
        status: StartProjectRuntimeStatus.AlreadyRunning,
        entry: existing.entry,
        message: "OpenCanon service is already running.",
      };
    }
    if (existing?.status === RuntimeStatus.Running) await stopService(registryPath);
    if (existing?.status === RuntimeStatus.Unhealthy) await stopService(registryPath);
    if (existing?.status === RuntimeStatus.Stale) forgetServiceEntry(registryPath);

    const attemptedPorts: number[] = [];
    const startupAttempts = input.port === undefined ? AutoPortStartupAttempts : 1;
    let lastStartupError: Error | undefined;
    for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
      const port = await chooseAvailablePort({
        host,
        preferredPort: input.port,
        defaultPort: defaultServicePort,
        usedPorts: [...readRuntimeRegistry(registryPath).map((entry) => entry.port), ...attemptedPorts],
        rangeKey: portRangeKeyForRegistry(registryPath, registryPath),
      });
      attemptedPorts.push(port);
      const logPath = serviceLogPath(registryPath);
      const authToken = createRuntimeAuthToken();
      const leaseId = createProcessLeaseId();
      const pipeEndpoint = localPipeEndpoint({ scope: "service", key: registryPath });
      ensurePrivateDirectory(path.dirname(logPath));
      const logFd = openSync(logPath, "a", 0o600);
      chmodSync(logPath, 0o600);
      const cliArgs = [...cli.args];
      cliArgs.splice(cliArgs.indexOf("--port") + 1, 1, String(port));
      cliArgs.push(HiddenRegistryArg, registryPath);
      if (input.allowRemote) cliArgs.push(ServiceArg.AllowRemote);
      const child = spawn(cli.command, cliArgs, {
        cwd: rootDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          OPENCANON_CLI: cli.entrypoint.path,
          [ServiceEnv.AuthToken]: authToken,
          [ServiceEnv.LeaseId]: leaseId,
          [ServiceEnv.RegistryPath]: registryPath,
          [ServiceEnv.PipeEndpoint]: pipeEndpoint,
          [ServiceEnv.RuntimeNamespace]: runtimeNamespaceForRegistry(registryPath),
        },
      });
      let childPid: number;
      try {
        childPid = await waitForChildSpawn(child, "OpenCanon service");
        child.unref();
      } catch (error) {
        appendLifecycleEvent(registryPath, {
          kind: ProcessLifecycleEventKind.ServiceStartupFailed,
          scope: ProcessLifecycleScope.Service,
          leaseId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        closeFileDescriptor(logFd);
      }

      const entry: ServiceRegistryEntry = {
        host,
        port,
        url: formatHttpBaseUrl(host, port),
        pipeEndpoint,
        pid: childPid,
        leaseId,
        startedAt: new Date().toISOString(),
        logPath,
        authToken,
        lifecycle: createLifecycle(ProcessLifecycleStatus.Starting, "Waiting for service health endpoint."),
        ...runtimeIdentity,
        ownerPid: ownerPidFromEnv(),
      };
      upsertServiceEntry(entry, registryPath);
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.ServiceStarted,
        scope: ProcessLifecycleScope.Service,
        pid: childPid,
        leaseId,
        message: "OpenCanon service process spawned.",
      });

      const health = await waitForServiceHealthResult(entry);
      if (health.ready) {
        const runningEntry = withLifecycle(entry, ProcessLifecycleStatus.Running, "OpenCanon service health endpoint is ready.");
        upsertServiceEntry(runningEntry, registryPath);
        return {
          status: StartProjectRuntimeStatus.Started,
          entry: runningEntry,
          message: "OpenCanon service started.",
        };
      }

      forgetServiceEntryIfPid(childPid, registryPath);
      await terminateSpawnedProcess(childPid);
      lastStartupError = new Error(`OpenCanon service did not become ready. See ${logPath}.`);
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.ServiceStartupFailed,
        scope: ProcessLifecycleScope.Service,
        pid: childPid,
        leaseId,
        message: lastStartupError.message,
      });
      if (health.reason !== LocalHealthWaitFailure.ProcessExited || attempt === startupAttempts - 1) {
        throw lastStartupError;
      }
    }
    throw lastStartupError ?? new Error("OpenCanon service did not become ready.");
  });
}

export async function ensureProjectRuntimeViaService(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
  idleTimeoutMs?: number;
}): Promise<EnsureProjectRuntimeResult> {
  const project = discoverOpenCanonProject(input.cwd);
  if (!project) {
    throw new Error(
      serializeOpenCanonProblem(
        projectNotFoundProblem({
          rootDir: path.resolve(input.cwd),
          status: 400,
        }),
      ),
    );
  }
  const registryPath = input.registryPath ?? serviceRegistryPath();
  let service = await startService({
    cwd: project.rootDir,
    registryPath,
  });
  const requestEnsureProject = async () => await requestLocalJson<{ project: StartProjectRuntimeResult }>(
    localProtocolEndpointFromEntry(service.entry),
    {
      method: "POST",
      path: ServiceApiRoute.EnsureProject,
      body: {
        rootDir: project.rootDir,
        host: input.host,
        port: input.port,
        allowRemote: input.allowRemote,
        idleTimeoutMs: input.idleTimeoutMs,
      },
    },
  );
  let payload: { project: StartProjectRuntimeResult };
  try {
    payload = await requestEnsureProject();
  } catch (error) {
    if (!isLocalProtocolTransportFailure(error)) throw error;
    await stopService(registryPath).catch(() => undefined);
    service = await startService({ cwd: project.rootDir, registryPath });
    try {
      payload = await requestEnsureProject();
    } catch (retryError) {
      throw new Error(`OpenCanon service request failed after repairing the service: ${errorMessage(retryError)}. Initial failure: ${errorMessage(error)}`);
    }
  }
  return { service: service.entry, project: payload.project };
}
