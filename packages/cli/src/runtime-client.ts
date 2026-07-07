import {
  ensureProjectRuntimeViaService,
  inspectProjectRuntime,
  LocalTransportKind,
  localProtocolEndpointFromEntry,
  requestLocalJson,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  serviceRegistryPath,
  stopProjectRuntime,
  RuntimeStatus,
  waitForProjectRuntimeReady,
  type RuntimeRegistryEntry,
} from "@opencanon/runtime";
import { resolveRootDir } from "@opencanon/core";

export const RuntimeApiRoute = {
  CanonRelated: "/api/canon/related",
  Changes: "/api/changes",
  ChangeChecksRun: "/api/changes/checks/run",
  ChangeEvents: "/api/changes/events",
  ChangeReady: "/api/changes/ready",
  ContextPacket: "/api/context/packet",
  ContextAsk: "/api/context/ask",
  ContextBacklinks: "/api/context/backlinks",
  ContextChunks: "/api/context/chunks",
  ContextCoverage: "/api/context/coverage",
  ContextSearch: "/api/context/search",
  ContextStatus: "/api/context/status",
  Doctor: "/api/doctor",
  Feedback: "/api/feedback",
  HookFeedback: "/api/hook-feedback",
  Index: "/api/index",
  Producers: "/api/producers",
  Snapshot: "/api/snapshot",
  Validate: "/api/validate",
  Worktrees: "/api/worktrees",
} as const;

const RunningRuntimeProducerProbeTimeoutMs = 2_000;
const RunningRuntimeProducerWarmTimeoutMs = 35_000;
const SupervisedRuntimeStartupAttempts = 3;

/**
 * Authoritative producer statuses from an ALREADY-running runtime, or undefined
 * if none is running / the query fails. Never lazily starts a runtime — a fresh
 * runtime's lazy producer would be cold, giving a misleading status. Callers
 * (e.g. `doctor`) fall back to a headless resolve when this returns undefined.
 */
export async function fetchRunningRuntimeProducers<T = unknown>(
  cwd: string,
  options: { warm?: boolean; timeoutMs?: number } = {},
): Promise<T | undefined> {
  const rootDir = resolveRootDir(cwd);
  const inspection = await inspectProjectRuntime(rootDir);
  if (inspection?.status !== "running") return undefined;
  try {
    const identity = runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir));
    if (!runtimeProducerProbeIdentityMatches(inspection.entry, identity)) return undefined;
  } catch {
    return undefined;
  }
  try {
    const payload = await requestLocalJson<{ producers: T }>(
      localProtocolEndpointFromEntry(inspection.entry),
      {
        method: "GET",
        path: options.warm ? `${RuntimeApiRoute.Producers}?warm=1` : RuntimeApiRoute.Producers,
        timeoutMs: options.timeoutMs ?? (options.warm ? RunningRuntimeProducerWarmTimeoutMs : RunningRuntimeProducerProbeTimeoutMs),
      },
    );
    return payload.producers;
  } catch {
    return undefined;
  }
}

function runtimeProducerProbeIdentityMatches(
  entry: RuntimeRegistryEntry,
  identity: Pick<RuntimeRegistryEntry, "transport" | "protocolVersion" | "runtimeVersion" | "runtimeFingerprint" | "cliPath">,
): boolean {
  return (
    entry.transport === identity.transport &&
    entry.protocolVersion === identity.protocolVersion &&
    entry.runtimeVersion === identity.runtimeVersion &&
    entry.runtimeFingerprint === identity.runtimeFingerprint &&
    entry.cliPath === identity.cliPath
  );
}

export type RuntimeClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
};

export type RuntimeClientOptions = {
  localTransport?: LocalTransportKind;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
};

export async function withRuntimeClient<T>(
  cwd: string,
  callback: (client: RuntimeClient) => Promise<T>,
  options: RuntimeClientOptions = {},
): Promise<T> {
  const rootDir = resolveRootDir(cwd);
  const registryPath = serviceRegistryPath();
  let supervisedRuntimeRepair: Promise<RuntimeRegistryEntry> | undefined;

  const entry = await ensureSupervisedRuntimeReady(rootDir, registryPath, options.startupTimeoutMs);
  let endpoint = localProtocolEndpointFromEntry(entry, { prefer: options.localTransport });

  const requestWithRepair = async <T>(request: { method: "GET" | "POST"; path: string; body?: unknown }): Promise<T> => {
    if (!endpoint) throw new Error("OpenCanon runtime endpoint was not initialized.");
    let initialError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await requestLocalJson<T>(endpoint, { ...request, timeoutMs: options.requestTimeoutMs });
      } catch (error) {
        if (attempt > 0 || !isLocalTransportFailure(error)) {
          if (initialError) {
            throw new Error(
              `OpenCanon runtime request failed after repairing the project runtime: ${errorMessage(error)}. Initial failure: ${errorMessage(initialError)}`,
            );
          }
          throw error;
        }
        initialError = error;
        const repaired = await repairSupervisedRuntime();
        endpoint = localProtocolEndpointFromEntry(repaired, { prefer: options.localTransport });
      }
    }
    throw new Error("OpenCanon runtime request failed before it returned a response.");
  };

  const repairSupervisedRuntime = async (): Promise<RuntimeRegistryEntry> => {
    if (!supervisedRuntimeRepair) {
      supervisedRuntimeRepair = repairSupervisedRuntimeAfterTransportFailure(rootDir, registryPath, options.startupTimeoutMs);
    }
    try {
      return await supervisedRuntimeRepair;
    } catch (repairError) {
      supervisedRuntimeRepair = undefined;
      throw repairError;
    }
  };

  return await callback({
    async get<T>(path: string) {
      return requestWithRepair<T>({ method: "GET", path });
    },
    async post<T>(path: string, body: unknown) {
      return requestWithRepair<T>({ method: "POST", path, body });
    },
  });
}

async function repairSupervisedRuntimeAfterTransportFailure(rootDir: string, registryPath: string, timeoutMs: number | undefined): Promise<RuntimeRegistryEntry> {
  await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
  return await ensureSupervisedRuntimeReady(rootDir, registryPath, timeoutMs);
}

async function ensureSupervisedRuntimeReady(rootDir: string, registryPath: string, timeoutMs = 180_000): Promise<RuntimeRegistryEntry> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SupervisedRuntimeStartupAttempts; attempt += 1) {
    await ensureProjectRuntimeViaService({ cwd: rootDir, waitForReady: false, registryPath });
    try {
      return (await waitForProjectRuntimeReady(rootDir, { registryPath, timeoutMs })).entry;
    } catch (error) {
      lastError = error;
      if (!(await shouldRetryFailedSupervisedStartup(rootDir, registryPath))) throw error;
      await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    }
  }
  throw lastError;
}

async function shouldRetryFailedSupervisedStartup(rootDir: string, registryPath: string): Promise<boolean> {
  const inspection = await inspectProjectRuntime(rootDir, registryPath);
  return !inspection || inspection.status === RuntimeStatus.Stale || inspection.status === RuntimeStatus.Unhealthy;
}

function isLocalTransportFailure(error: unknown): boolean {
  const message = errorMessages(error).join("\n");
  return (
    message.includes("OpenCanon pipe closed before a complete frame was received") ||
    message.includes("OpenCanon pipe socket is already closed") ||
    message.includes("OpenCanon local request timed out") ||
    message.includes("fetch failed") ||
    message.includes("other side closed") ||
    message.includes("UND_ERR_SOCKET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("ENOENT") ||
    message.includes("No such file or directory")
  );
}

function errorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  const messages = [errorMessage(error)];
  if (typeof error === "object") {
    const record = error as { cause?: unknown; code?: unknown };
    if (typeof record.code === "string" && record.code.trim()) messages.push(record.code);
    messages.push(...errorMessages(record.cause, seen));
  }
  return messages.filter((message) => message.trim().length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
