import {
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  resolveRootDir,
  type ProducerStatus,
  type ReadSemanticIndexStatusResult,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { ApiRoute } from "./routes.ts";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import {
  RuntimeStatus,
  formatRefreshStatus,
  type RuntimeInspection,
  type RuntimeRegistryEntry,
  type ServiceInspection,
  type ServiceRegistryEntry,
} from "./service.ts";

const SemanticIndexStatus = {
  Disabled: "disabled",
  Indexing: "indexing",
  Ready: "ready",
  Stale: "stale",
  Failed: "failed",
} as const;

/** Fetch the running runtime's live producer statuses and render a markdown block. */
export async function renderProducerStatusMarkdown(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<string> {
  const lines = ["## Type Producers", ""];
  const result = await readProducerStatuses(entry);
  if ("error" in result) {
    lines.push(`Could not read producer status: ${result.error}`);
    return lines.join("\n");
  }
  if (result.producers.length === 0) {
    lines.push("No type producers registered.");
    return lines.join("\n");
  }
  for (const status of result.producers) {
    const detail = status.detail ? ` — ${status.detail}` : "";
    lines.push(`- ${status.language}: ${status.kind}${detail}`);
    for (const warning of status.warnings ?? []) lines.push(`  - warning [${warning.code}]: ${warning.message}`);
  }
  return lines.join("\n");
}

export async function readProducerStatuses(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<{ producers: ProducerStatus[] } | { error: string }> {
  try {
    const body = await requestLocalJson<{ producers?: ProducerStatus[] }>(localProtocolEndpointFromEntry(entry), { method: "GET", path: ApiRoute.Producers });
    return { producers: body.producers ?? [] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function renderProjectIndexStatusMarkdown(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<string> {
  const lines = ["## Project Index", ""];
  const result = await readProjectIndexStatus(entry);
  if ("error" in result) {
    lines.push(`Could not read project index status: ${result.error}`);
    return lines.join("\n");
  }
  if (!result.index) {
    lines.push("No context index snapshot has been written.");
    lines.push("");
    lines.push("Action: Run opencanon project index to build Search, Ask, and Context knowledge.");
    return lines.join("\n");
  }
  lines.push(...renderSemanticIndexLines(result.index));
  return lines.join("\n");
}

export async function readProjectIndexStatus(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<ReadSemanticIndexStatusResult | { error: string }> {
  try {
    return await requestLocalJson<ReadSemanticIndexStatusResult>(localProtocolEndpointFromEntry(entry), { method: "GET", path: ApiRoute.ContextStatus });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function renderSemanticIndexLines(index: SemanticIndexSnapshot): string[] {
  const lines = [
    `Status: ${index.status}`,
    `Chunks: ${index.chunkCount}`,
    `Vectors: ${index.vectorCount}`,
    `Stale chunks: ${index.staleChunkCount}`,
    `Provider: ${index.provider.displayName ?? index.provider.id} (${index.provider.modelId})`,
    `Indexed: ${index.indexedAt}`,
  ];
  if (index.embeddingStats) {
    lines.push(`Embeddings: ${index.embeddingStats.embeddedChunks} embedded, ${index.embeddingStats.reusedChunks} reused of ${index.embeddingStats.totalChunks}`);
  }
  if (index.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of index.diagnostics) lines.push(`- ${diagnostic.severity}: ${diagnostic.message}`);
  }
  const action = semanticIndexAction(index);
  if (action) lines.push("", `Action: ${action}`);
  return lines;
}

function semanticIndexAction(index: SemanticIndexSnapshot): string | undefined {
  if (index.status === SemanticIndexStatus.Ready && index.staleChunkCount === 0) return undefined;
  if (index.status === SemanticIndexStatus.Indexing) return "Wait for the current project index rebuild to finish, then rerun opencanon project status.";
  if (index.status === SemanticIndexStatus.Disabled) return "Enable project knowledge indexing in opencanon.config.json before using Search or Ask.";
  if (index.status === SemanticIndexStatus.Failed) return "Fix the listed diagnostics, then run opencanon project index.";
  return "Run opencanon project index to rebuild Search, Ask, and Context knowledge.";
}

export function runtimeInspectionJson(inspection: RuntimeInspection | undefined, cwd: string): Record<string, unknown> {
  if (!inspection) {
    return {
      rootDir: resolveRootDir(cwd),
      status: "not-running",
      actions: ["Run opencanon project start."],
    };
  }
  return {
    entry: runtimeEntryJson(inspection.entry),
    status: inspection.status,
    message: inspection.message,
    health: inspection.health,
    state: inspection.state,
    actions: runtimeStatusActions(inspection),
  };
}

export function serviceInspectionJson(inspection: ServiceInspection | undefined): Record<string, unknown> {
  if (!inspection) {
    return {
      status: "not-running",
      actions: ["Run opencanon service start."],
    };
  }
  return {
    entry: serviceEntryJson(inspection.entry),
    status: inspection.status,
    message: inspection.message,
    health: inspection.health,
    actions: serviceStatusActions(inspection),
  };
}

export function runtimeEntryJson(entry: RuntimeRegistryEntry): Omit<RuntimeRegistryEntry, "authToken"> {
  return {
    rootDir: entry.rootDir,
    host: entry.host,
    port: entry.port,
    url: entry.url,
    pipeEndpoint: entry.pipeEndpoint,
    pid: entry.pid,
    leaseId: entry.leaseId,
    lifecycle: entry.lifecycle,
    startedAt: entry.startedAt,
    logPath: entry.logPath,
    transport: entry.transport,
    protocolVersion: entry.protocolVersion,
    runtimeVersion: entry.runtimeVersion,
    runtimeFingerprint: entry.runtimeFingerprint,
    cliPath: entry.cliPath,
  };
}

export function serviceEntryJson(entry: ServiceRegistryEntry): Omit<ServiceRegistryEntry, "authToken"> {
  const output: Omit<ServiceRegistryEntry, "authToken"> = {
    host: entry.host,
    port: entry.port,
    url: entry.url,
    pipeEndpoint: entry.pipeEndpoint,
    pid: entry.pid,
    leaseId: entry.leaseId,
    lifecycle: entry.lifecycle,
    startedAt: entry.startedAt,
    logPath: entry.logPath,
    transport: entry.transport,
    protocolVersion: entry.protocolVersion,
    runtimeVersion: entry.runtimeVersion,
    runtimeFingerprint: entry.runtimeFingerprint,
    cliPath: entry.cliPath,
  };
  if (entry.ownerPid !== undefined) output.ownerPid = entry.ownerPid;
  return output;
}

function runtimeStatusActions(inspection: RuntimeInspection): string[] {
  if (inspection.status === RuntimeStatus.Starting) return ["Wait for runtime readiness, then rerun opencanon project status."];
  if (inspection.status === RuntimeStatus.Stale) return ["Run opencanon project start to recreate project runtime state."];
  if (inspection.status === RuntimeStatus.Unhealthy) return ["Run opencanon project stop, then opencanon project start."];
  if (!inspection.health) return [];
  return refreshNeedsManualAction(inspection.health.refresh)
    ? ["Run opencanon project index to refresh derived project knowledge now.", "Run opencanon project stop, then opencanon project start to restore live file watching."]
    : [];
}

function serviceStatusActions(inspection: ServiceInspection): string[] {
  if (inspection.status === RuntimeStatus.Stale) return ["Run opencanon service start to recreate service state."];
  if (inspection.status === RuntimeStatus.Unhealthy) return ["Run opencanon service stop, then opencanon service start."];
  return [];
}

export function renderOpenCanonStatusSummary(service: ServiceInspection | undefined, project: RuntimeInspection | undefined, cwd: string): string {
  const lines: string[] = [];
  const serviceStatus = service?.status ?? "not-running";
  const projectStatus = project?.status ?? "not-running";
  lines.push(`Service: ${serviceStatus}`);
  if (service?.message) lines.push(`Service health: ${service.message}`);
  if (!service) lines.push("Service action: opencanon service start");
  for (const action of service ? serviceStatusActions(service) : []) lines.push(`Service action: ${action}`);
  lines.push("");
  lines.push(`Project: ${projectStatus}`);
  lines.push(`Root: ${project?.entry.rootDir ?? resolveRootDir(cwd)}`);
  if (project?.message) lines.push(`Project health: ${project.message}`);
  if (!project) lines.push("Project action: opencanon project start");
  for (const action of project ? runtimeStatusActions(project) : []) lines.push(`Project action: ${action}`);
  if (project?.health) {
    lines.push(`Runtime: ${project.health.status}`);
    lines.push(`Engine: ${project.health.engine.engineVersion}`);
    lines.push(`Refresh: ${formatRefreshStatus(project.health.refresh)}`);
  }
  if (project?.state) {
    lines.push(`Files: ${project.state.files}`);
    lines.push(`Findings: ${project.state.findings}`);
    if (project.state.staleFiles > 0) lines.push(`Stale files: ${project.state.staleFiles}`);
  }
  lines.push("");
  lines.push("Details: opencanon service status, opencanon project status, or opencanon status --format json");
  return lines.join("\n");
}

function refreshNeedsManualAction(refresh: { status: string; mode: string }): boolean {
  return refresh.status === ProjectRefreshStatusValue.Stale || refresh.mode === ProjectRefreshModeValue.Manual;
}
