import {
  DoctorKnowledgeInspectionKind,
  ReadSemanticIndexStatusResultSchema,
  createDomainProtocolClient,
  protocolInputFromSearchParams,
  resolveRootDir,
  type DoctorKnowledgeInspection,
  type ProtocolExecutionOptions,
  type ProtocolInput,
  type ProtocolOperationId,
  type ProtocolStreamOptions,
} from "@opencanon/core";
import {
  ensureProjectRuntimeViaService,
  inspectProjectRuntime,
  localProtocolEndpointFromEntry,
  localProtocolTransport,
  RuntimeStatus,
  streamLocalText,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  serviceRegistryPath,
  stopProjectRuntime,
  type LocalProtocolEndpoint,
  type RuntimeRegistryEntry,
} from "@opencanon/runtime";

const RunningRuntimeProducerProbeTimeoutMs = 2_000;
const RunningRuntimeKnowledgeProbeTimeoutMs = 2_000;

export type RuntimeClient = {
  query<T>(operationId: ProtocolOperationId, input?: ProtocolInput, options?: ProtocolExecutionOptions): Promise<T>;
  command<T>(operationId: ProtocolOperationId, input?: ProtocolInput, options?: ProtocolExecutionOptions): Promise<T>;
  stream(operationId: ProtocolOperationId, input: ProtocolInput | undefined, options: ProtocolStreamOptions): Promise<void>;
};

export type RuntimeClientOptions = {
  requestTimeoutMs?: number;
};

export { protocolInputFromSearchParams };

/** Query producer state only when the already-running process matches this CLI. */
export async function fetchRunningRuntimeProducers<T = unknown>(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<T | undefined> {
  const rootDir = resolveRootDir(cwd);
  const inspection = await inspectProjectRuntime(rootDir);
  if (inspection?.status !== RuntimeStatus.Running) return undefined;
  try {
    const identity = runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir));
    if (!runtimeProbeIdentityMatches(inspection.entry, identity)) return undefined;
    const client = domainClientForEndpoint(() => localProtocolEndpointFromEntry(inspection.entry));
    const projection = await client.query<{ producers: T }>("producers.list", {}, {
      timeoutMs: options.timeoutMs ?? RunningRuntimeProducerProbeTimeoutMs,
    });
    return projection.data.producers;
  } catch {
    return undefined;
  }
}

export async function inspectRunningRuntimeKnowledge(cwd: string): Promise<DoctorKnowledgeInspection> {
  const rootDir = resolveRootDir(cwd);
  const inspection = await inspectProjectRuntime(rootDir);
  if (inspection?.status !== RuntimeStatus.Running) return { kind: DoctorKnowledgeInspectionKind.NotInspected };
  try {
    const identity = runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir));
    if (!runtimeProbeIdentityMatches(inspection.entry, identity)) {
      return {
        kind: DoctorKnowledgeInspectionKind.Failed,
        error: "The running project runtime identity does not match this OpenCanon CLI.",
      };
    }
    const client = domainClientForEndpoint(() => localProtocolEndpointFromEntry(inspection.entry));
    const projection = await client.query<unknown>("knowledge.status", {}, {
      timeoutMs: RunningRuntimeKnowledgeProbeTimeoutMs,
    });
    return {
      kind: DoctorKnowledgeInspectionKind.Available,
      index: ReadSemanticIndexStatusResultSchema.parse(projection.data).index,
    };
  } catch (error) {
    return { kind: DoctorKnowledgeInspectionKind.Failed, error: errorMessage(error) };
  }
}

export async function withRuntimeClient<T>(
  cwd: string,
  callback: (client: RuntimeClient) => Promise<T>,
  options: RuntimeClientOptions = {},
): Promise<T> {
  const rootDir = resolveRootDir(cwd);
  const registryPath = serviceRegistryPath();
  let supervisedRuntimeRepair: Promise<RuntimeRegistryEntry> | undefined;
  let endpoint = localProtocolEndpointFromEntry(await ensureSupervisedRuntimeReady(rootDir, registryPath));

  const repair = async (): Promise<void> => {
    if (!supervisedRuntimeRepair) {
      supervisedRuntimeRepair = repairSupervisedRuntimeAfterTransportFailure(rootDir, registryPath);
    }
    try {
      endpoint = localProtocolEndpointFromEntry(await supervisedRuntimeRepair);
      supervisedRuntimeRepair = undefined;
    } catch (error) {
      supervisedRuntimeRepair = undefined;
      throw error;
    }
  };
  const client = domainClientForEndpoint(() => endpoint, repair, options.requestTimeoutMs);

  return await callback({
    async query<TResult>(operationId: ProtocolOperationId, input?: ProtocolInput, executionOptions?: ProtocolExecutionOptions) {
      return (await client.query<TResult>(operationId, input, executionOptions)).data;
    },
    async command<TResult>(operationId: ProtocolOperationId, input?: ProtocolInput, executionOptions?: ProtocolExecutionOptions) {
      return await client.command<TResult>(operationId, input, executionOptions);
    },
    async stream(operationId, input, streamOptions) {
      await client.stream(operationId, input, streamOptions);
    },
  });
}

function domainClientForEndpoint(
  endpoint: () => LocalProtocolEndpoint,
  repair?: () => Promise<void>,
  defaultTimeoutMs?: number,
) {
  return createDomainProtocolClient({
    transport: {
      async request(request) {
        return await localProtocolTransport.request(endpoint(), {
          method: request.method,
          path: request.path,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
        });
      },
      async stream(request) {
        await streamLocalText(endpoint(), {
          method: request.method,
          path: request.path,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          onOpen: request.onOpen,
          onChunk: request.onChunk,
        });
      },
    },
    ...(repair ? { repair: async () => repair() } : {}),
  });
}

function runtimeProbeIdentityMatches(
  entry: RuntimeRegistryEntry,
  identity: Pick<RuntimeRegistryEntry, "transport" | "protocolVersion" | "runtimeVersion" | "runtimeFingerprint" | "cliPath">,
): boolean {
  return (
    entry.transport === identity.transport
    && entry.protocolVersion === identity.protocolVersion
    && entry.runtimeVersion === identity.runtimeVersion
    && entry.runtimeFingerprint === identity.runtimeFingerprint
    && entry.cliPath === identity.cliPath
  );
}

async function repairSupervisedRuntimeAfterTransportFailure(rootDir: string, registryPath: string): Promise<RuntimeRegistryEntry> {
  await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
  return await ensureSupervisedRuntimeReady(rootDir, registryPath);
}

async function ensureSupervisedRuntimeReady(rootDir: string, registryPath: string): Promise<RuntimeRegistryEntry> {
  return (await ensureProjectRuntimeViaService({ cwd: rootDir, registryPath })).project.entry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
