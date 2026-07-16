import {
  DoctorKnowledgeInspectionKind,
  ReadSemanticIndexStatusResultSchema,
  protocolInputFromSearchParams,
  resolveRootDir,
  type DoctorKnowledgeInspection,
  type ProtocolCommandOperationId,
  type ProtocolExecutionOptions,
  type ProtocolOperationInput,
  type ProtocolOperationOutput,
  type ProtocolQueryOperationId,
  type ProtocolStreamOperationId,
  type ProtocolStreamOptions,
} from "@opencanon/core";
import {
  ensureProjectRuntimeViaService,
  createLocalDomainProtocolClient,
  inspectProjectRuntime,
  localProtocolEndpointFromEntry,
  RuntimeStatus,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  serviceRegistryPath,
  stopProjectRuntime,
  type RuntimeRegistryEntry,
} from "@opencanon/runtime";

const RunningRuntimeProducerProbeTimeoutMs = 2_000;
const RunningRuntimeKnowledgeProbeTimeoutMs = 2_000;

export type RuntimeClient = {
  query<TId extends ProtocolQueryOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, options?: ProtocolExecutionOptions): Promise<ProtocolOperationOutput<TId>>;
  command<TId extends ProtocolCommandOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, options?: ProtocolExecutionOptions): Promise<ProtocolOperationOutput<TId>>;
  stream<TId extends ProtocolStreamOperationId>(operationId: TId, input: ProtocolOperationInput<TId> | undefined, options: ProtocolStreamOptions): Promise<void>;
};

export type RuntimeClientOptions = {
  requestTimeoutMs?: number;
};

export { protocolInputFromSearchParams };

/** Query producer state only when the already-running process matches this CLI. */
export async function fetchRunningRuntimeProducers(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<ProtocolOperationOutput<"producers.list">["producers"] | undefined> {
  const rootDir = resolveRootDir(cwd);
  const inspection = await inspectProjectRuntime(rootDir);
  if (inspection?.status !== RuntimeStatus.Running) return undefined;
  try {
    const identity = runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir));
    if (!runtimeProbeIdentityMatches(inspection.entry, identity)) return undefined;
    const client = domainClientForEndpoint(() => localProtocolEndpointFromEntry(inspection.entry));
    const projection = await client.query("producers.list", {}, {
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
    const projection = await client.query("knowledge.status", {}, {
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
    async query<TId extends ProtocolQueryOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, executionOptions?: ProtocolExecutionOptions) {
      return (await client.query(operationId, input, executionOptions)).data;
    },
    async command<TId extends ProtocolCommandOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, executionOptions?: ProtocolExecutionOptions) {
      return await client.command(operationId, input, executionOptions);
    },
    async stream<TId extends ProtocolStreamOperationId>(operationId: TId, input: ProtocolOperationInput<TId> | undefined, streamOptions: ProtocolStreamOptions) {
      await client.stream(operationId, input, streamOptions);
    },
  });
}

function domainClientForEndpoint(
  endpoint: () => ReturnType<typeof localProtocolEndpointFromEntry>,
  repair?: () => Promise<void>,
  defaultTimeoutMs?: number,
) {
  return createLocalDomainProtocolClient({
    endpoint,
    ...(repair ? { repair: async () => repair() } : {}),
    ...(defaultTimeoutMs ? { defaultTimeoutMs } : {}),
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
