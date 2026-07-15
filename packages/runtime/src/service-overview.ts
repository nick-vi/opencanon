import { localPipeEndpoint, localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { ServiceActionCategory, ServiceActionId, ServiceActionScope, ServiceActionStatusValue, ServiceActionSurface, ServiceEffectKind, ServiceProjectStatusValue, type ServiceActionDefinition, type ServiceActionResult, type ServiceClientEffect, type ServiceProjectStatus } from "@opencanon/service-contracts";
import { formatHttpBaseUrl } from "./runtime.ts";
import { ApiRoute, ProjectIndexResponseMode } from "./routes.ts";
import { discoverOpenCanonProject, discoverOpenCanonProjectsFromRoots } from "./service-discovery.ts";
import { defaultServicePort, ProcessLifecycleScope, type ProcessLifecycleEvent, type RuntimeInspection, type ServiceActivityItem, type ServiceInspection, type ServiceOverview, type ServiceOverviewRequest, type ServiceProjectSummary, type ServiceSummary } from "./service-types.ts";
import { inspectAllRuntimes, inspectService } from "./service-monitor.ts";
import { reconcileProjectRuntimes } from "./service-reconcile.ts";
import { readRuntimeLifecycleEvents, readRuntimeRegistry, readRuntimeRegistryDiagnostics, runtimeLogPath, serviceLogPath, serviceRegistryPath } from "./service-storage.ts";
import { startProjectRuntime } from "./service-start.ts";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export async function buildServiceOverview(input: ServiceOverviewRequest & { registryPath?: string } = {}): Promise<ServiceOverview> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const currentRootDir = canonicalOverviewRootDir(input.currentRootDir);
  const diagnostics = [...readRuntimeRegistryDiagnostics(registryPath)];
  try {
    await reconcileProjectRuntimes({ registryPath });
  } catch (error) {
    diagnostics.push(`Project runtime reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const projects: ServiceProjectSummary[] = [];
  const seen = new Set<string>();
  const pushProject = (project: ServiceProjectSummary) => {
    if (seen.has(project.rootDir)) return;
    seen.add(project.rootDir);
    projects.push(project);
  };

  const service = await inspectService(registryPath);
  for (const inspection of await inspectAllRuntimes(registryPath)) {
    pushProject(serviceProjectSummaryFromInspection(inspection, currentRootDir));
  }
  for (const project of discoverOpenCanonProjectsFromRoots(input.discoveryRoots ?? [])) {
    pushProject(serviceProjectSummaryFromRoot(project.rootDir, ServiceProjectStatusValue.Discovered, currentRootDir));
  }
  for (const project of input.recentProjects ?? []) {
    const rootDir = canonicalOverviewRootDir(project.rootDir) ?? path.resolve(project.rootDir);
    pushProject(serviceProjectSummaryFromRoot(rootDir, discoverOpenCanonProject(rootDir) ? ServiceProjectStatusValue.Recent : ServiceProjectStatusValue.Stale, currentRootDir));
  }

  projects.sort((left, right) => Number(right.selected) - Number(left.selected) || projectStatusRank(left.status) - projectStatusRank(right.status) || left.rootDir.localeCompare(right.rootDir));
  return {
    service: service ? serviceSummaryFromInspection(service) : unavailableServiceSummary(registryPath),
    ...(currentRootDir ? { currentRootDir } : {}),
    projects,
    activity: readRuntimeLifecycleEvents(registryPath).slice(-10).reverse().map(serviceActivityItemFromLifecycleEvent),
    actions: serviceActionDefinitions(Boolean(currentRootDir)),
    diagnostics,
  };
}

export async function invokeServiceAction(input: { id: string; rootDir?: string; registryPath?: string }): Promise<ServiceActionResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const rootDir = canonicalOverviewRootDir(input.rootDir);
  switch (input.id) {
    case ServiceActionId.OpenProject:
      return serviceActionOk("Open project", "Choose an OpenCanon project folder.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.PickFolder }]);
    case ServiceActionId.SwitchProject:
      return serviceActionOk("Switch project", "Open the project switcher.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.Navigate, view: "command-palette" }]);
    case ServiceActionId.Settings:
      return serviceActionOk("Settings", "Open OpenCanon settings.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.Navigate, view: "settings" }]);
    case ServiceActionId.QuitClient:
      return serviceActionOk("Quit OpenCanon", "Quit the OpenCanon client.", [{ kind: ServiceEffectKind.QuitClient }]);
    case ServiceActionId.CheckUpdates:
      return serviceActionOk("Check updates", "Check runtime updates.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.CheckUpdates }]);
    case ServiceActionId.ExportDiagnostics:
      return serviceActionOk("Export diagnostics", "Write a local diagnostics report.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.ExportDiagnostics, ...(rootDir ? { rootDir } : {}) }]);
    case ServiceActionId.OpenLogs:
      return openLogsActionResult(rootDir, registryPath);
    case ServiceActionId.ProjectSelect:
      if (!rootDir) return serviceActionWarning("Project required", "Select a project before running this action.");
      return serviceActionOk("Select project", `Open ${path.basename(rootDir)}.`, [{ kind: ServiceEffectKind.SelectProject, rootDir }, { kind: ServiceEffectKind.ShowClient }]);
    case ServiceActionId.ProjectReindex:
      if (!rootDir) return serviceActionWarning("Project required", "Open a project before reindexing.");
      return invokeProjectRuntimeAction(rootDir, registryPath, ApiRoute.Index, "POST", "Project reindexed", "Refreshed project knowledge.", {
        response: ProjectIndexResponseMode.SemanticIndex,
      });
    case ServiceActionId.ProjectDoctor:
      if (!rootDir) return serviceActionWarning("Project required", "Open a project before running Doctor.");
      return invokeProjectRuntimeAction(rootDir, registryPath, ApiRoute.Doctor, "GET", "Doctor completed", "Refreshed project health.");
    default:
      return {
        status: ServiceActionStatusValue.Error,
        title: "Unknown action",
        message: `Unknown OpenCanon action: ${input.id}.`,
      };
  }
}

function serviceSummaryFromInspection(inspection: ServiceInspection): ServiceSummary {
  return {
    url: inspection.entry.url,
    status: inspection.status,
    pipeEndpoint: inspection.entry.pipeEndpoint,
    transport: inspection.entry.transport,
    protocolVersion: inspection.entry.protocolVersion,
    runtimeVersion: inspection.entry.runtimeVersion,
    runtimeFingerprint: inspection.entry.runtimeFingerprint,
    cliPath: inspection.entry.cliPath,
  };
}

function unavailableServiceSummary(registryPath: string): ServiceSummary {
  return {
    url: formatHttpBaseUrl("127.0.0.1", defaultServicePort),
    status: "unavailable",
    pipeEndpoint: localPipeEndpoint({ scope: "service", key: registryPath }),
  };
}

function serviceProjectSummaryFromInspection(inspection: RuntimeInspection, currentRootDir: string | undefined): ServiceProjectSummary {
  const rootDir = canonicalOverviewRootDir(inspection.entry.rootDir) ?? inspection.entry.rootDir;
  return {
    id: rootDir,
    rootDir,
    url: inspection.entry.url,
    status: inspection.status,
    selected: currentRootDir === rootDir,
    ...(inspection.state?.lifecycle ? { lifecycle: inspection.state.lifecycle } : {}),
    pid: inspection.entry.pid,
    port: inspection.entry.port,
    pipeEndpoint: inspection.entry.pipeEndpoint,
    transport: inspection.entry.transport,
    protocolVersion: inspection.entry.protocolVersion,
    runtimeVersion: inspection.entry.runtimeVersion,
    runtimeFingerprint: inspection.entry.runtimeFingerprint,
    cliPath: inspection.entry.cliPath,
    files: inspection.state?.files,
    findings: inspection.state?.findings,
  };
}

function serviceProjectSummaryFromRoot(rootDir: string, status: ServiceProjectStatus, currentRootDir: string | undefined): ServiceProjectSummary {
  return {
    id: rootDir,
    rootDir,
    url: "",
    status,
    selected: currentRootDir === rootDir,
  };
}

function canonicalOverviewRootDir(rootDir: string | undefined): string | undefined {
  const trimmed = rootDir?.trim();
  if (!trimmed) return undefined;
  const resolved = path.resolve(trimmed);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function projectStatusRank(status: ServiceProjectStatus): number {
  if (status === ServiceProjectStatusValue.Running) return 0;
  if (status === ServiceProjectStatusValue.Starting) return 1;
  if (status === ServiceProjectStatusValue.Failed) return 2;
  if (status === ServiceProjectStatusValue.Discovered) return 3;
  if (status === ServiceProjectStatusValue.Recent) return 4;
  if (status === ServiceProjectStatusValue.Unhealthy) return 5;
  return 6;
}

function serviceActivityItemFromLifecycleEvent(event: ProcessLifecycleEvent): ServiceActivityItem {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    title: lifecycleEventTitle(event),
    ...(event.message ? { detail: event.message } : {}),
    ...(event.rootDir ? { rootDir: event.rootDir } : {}),
  };
}

function lifecycleEventTitle(event: ProcessLifecycleEvent): string {
  const target = event.scope === ProcessLifecycleScope.Service ? "Service" : "Project runtime";
  return `${target} ${event.kind.replace(/-/g, " ")}`;
}

function serviceActionDefinitions(hasCurrentProject: boolean): ServiceActionDefinition[] {
  const projectDisabledReason = hasCurrentProject ? undefined : "Open a project first.";
  return [
    serviceActionDefinition(ServiceActionId.OpenProject, "Open Project...", ServiceActionCategory.Navigation, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.SwitchProject, "Switch Project...", ServiceActionCategory.Navigation, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.Settings, "Settings", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ProjectSelect, "Select Project", ServiceActionCategory.Project, ServiceActionScope.Project, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ProjectReindex, "Reindex Project", ServiceActionCategory.Project, ServiceActionScope.Project, hasCurrentProject, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu], projectDisabledReason),
    serviceActionDefinition(ServiceActionId.ProjectDoctor, "Run Doctor", ServiceActionCategory.Diagnostics, ServiceActionScope.Project, hasCurrentProject, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu], projectDisabledReason),
    serviceActionDefinition(ServiceActionId.OpenLogs, "Open Logs", ServiceActionCategory.Diagnostics, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ExportDiagnostics, "Export Diagnostics", ServiceActionCategory.Diagnostics, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette]),
    serviceActionDefinition(ServiceActionId.CheckUpdates, "Check Updates", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette]),
    serviceActionDefinition(ServiceActionId.QuitClient, "Quit OpenCanon", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.StatusMenu]),
  ];
}

function serviceActionDefinition(
  id: ServiceActionId,
  label: string,
  category: ServiceActionCategory,
  scope: ServiceActionScope,
  enabled: boolean,
  surfaces: ServiceActionSurface[],
  disabledReason?: string,
): ServiceActionDefinition {
  return {
    id,
    label,
    category,
    scope,
    enabled,
    ...(disabledReason && !enabled ? { disabledReason } : {}),
    surfaces,
  };
}

function serviceActionOk(title: string, message: string, effects?: ServiceClientEffect[]): ServiceActionResult {
  return {
    status: ServiceActionStatusValue.Ok,
    title,
    message,
    ...(effects?.length ? { effects } : {}),
  };
}

function serviceActionWarning(title: string, message: string): ServiceActionResult {
  return {
    status: ServiceActionStatusValue.Warning,
    title,
    message,
  };
}

function openLogsActionResult(rootDir: string | undefined, registryPath: string): ServiceActionResult {
  const logPath = firstExistingLogPath(rootDir, registryPath);
  if (!logPath) {
    return serviceActionWarning("No logs yet", "OpenCanon has not written local logs for this project or service yet.");
  }
  return {
    status: ServiceActionStatusValue.Ok,
    title: "Opened logs",
    message: `Open ${logPath}.`,
    path: logPath,
    effects: [{ kind: ServiceEffectKind.RevealPath, path: logPath }],
  };
}

function firstExistingLogPath(rootDir: string | undefined, registryPath: string): string | undefined {
  const candidates: string[] = [];
  if (rootDir) {
    candidates.push(runtimeLogPath(rootDir, registryPath));
    candidates.push(...readRuntimeRegistry(registryPath).filter((entry) => entry.rootDir === rootDir).map((entry) => entry.logPath));
  } else {
    candidates.push(serviceLogPath(registryPath));
    candidates.push(...readRuntimeRegistry(registryPath).map((entry) => entry.logPath));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

async function invokeProjectRuntimeAction(
  rootDir: string,
  registryPath: string,
  route: string,
  method: "GET" | "POST",
  title: string,
  message: string,
  body?: Record<string, unknown>,
): Promise<ServiceActionResult> {
  const project = discoverOpenCanonProject(rootDir);
  if (!project) {
    return {
      status: ServiceActionStatusValue.Error,
      title: "OpenCanon project not found",
      message: `No OpenCanon project was discovered for ${rootDir}.`,
    };
  }
  try {
    const started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
    const details = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(started.entry), { method, path: route, body: method === "POST" ? body ?? {} : undefined });
    return {
      status: ServiceActionStatusValue.Ok,
      title,
      message,
      details,
    };
  } catch (error) {
    return {
      status: ServiceActionStatusValue.Error,
      title: `${title} failed`,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
