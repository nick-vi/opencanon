import { spawn } from "node:child_process";
import { ProjectRefreshModeValue, ProjectRefreshStatusValue, resolveRootDir, type RuntimeHealth } from "@opencanon/core";
import {
  PlatformName,
  type ProcessLifecycleEvent,
  type ProcessLifecycleState,
  type RuntimeInspection,
  type ServiceInspection,
} from "./service-types.ts";

export function renderRuntimeStatusMarkdown(inspection: RuntimeInspection | undefined, rootDir: string): string {
  if (!inspection) {
    return ["# OpenCanon Project Runtime Status", "", `Root: ${resolveRootDir(rootDir)}`, "Status: not-running", "", "Run: opencanon project start"].join("\n");
  }
  const lines = [
    "# OpenCanon Project Runtime Status",
    "",
    `Root: ${inspection.entry.rootDir}`,
    `Status: ${inspection.status}`,
    `Transport: ${inspection.entry.transport}`,
    `Pipe: ${inspection.entry.pipeEndpoint}`,
    `URL: ${inspection.entry.url}`,
    `PID: ${inspection.entry.pid}`,
    `Lease: ${inspection.entry.leaseId}`,
    `Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`,
    `Started: ${inspection.entry.startedAt}`,
    `Log: ${inspection.entry.logPath}`,
    `Message: ${inspection.message}`,
  ];
  if (inspection.health) {
    lines.push(
      `Health: ${inspection.health.status}`,
      `Engine: ${inspection.health.engine.engineVersion} (package ${inspection.health.engine.packageVersion}, NAPI ${inspection.health.engine.napiVersion})`,
      `Refresh: ${formatRefreshStatus(inspection.health.refresh)}`,
    );
    if (refreshNeedsManualAction(inspection.health.refresh)) {
      lines.push("Action: Run opencanon project index to refresh derived project knowledge now; run opencanon project stop, then opencanon project start to restore live file watching.");
    }
    if (inspection.health.validatorGraph) {
      lines.push(
        `Validator graph: ${inspection.health.validatorGraph.validatorCount} validators`,
        `Validator graph inputs: ${inspection.health.validatorGraph.dependencyFiles.length} files`,
        `Validator graph hash: ${inspection.health.validatorGraph.hash.slice(0, 12)}`,
        `Validator graph loaded: ${inspection.health.validatorGraph.loadedAt}`,
      );
    }
  }
  if (inspection.state) {
    lines.push(
      `Files: ${inspection.state.files}`,
      `Findings: ${inspection.state.findings}`,
      `Stale files: ${inspection.state.staleFiles}`,
      `Cache: ${inspection.state.cacheHits} hits, ${inspection.state.cacheMisses} misses`,
    );
  }
  return lines.join("\n");
}

export function renderRuntimeListMarkdown(inspections: RuntimeInspection[], diagnostics: string[] = []): string {
  const lines = ["# OpenCanon Project Runtimes", ""];
  if (inspections.length === 0) {
    lines.push("No project runtimes are registered.");
    if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
    return lines.join("\n");
  }
  for (const inspection of inspections) {
    lines.push(`- [${inspection.status}] ${inspection.entry.rootDir}`);
    lines.push(`  Transport: ${inspection.entry.transport}`);
    lines.push(`  Pipe: ${inspection.entry.pipeEndpoint}`);
    lines.push(`  URL: ${inspection.entry.url}`);
    lines.push(`  PID: ${inspection.entry.pid}`);
    lines.push(`  Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`);
    if (inspection.health) lines.push(`  Health: ${inspection.health.status}; refresh ${formatRefreshStatus(inspection.health.refresh)}`);
    if (inspection.state) lines.push(`  State: ${inspection.state.files} files, ${inspection.state.findings} findings, ${inspection.state.staleFiles} stale`);
  }
  if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
  return lines.join("\n");
}

export function renderServiceStatusMarkdown(inspection: ServiceInspection | undefined): string {
  if (!inspection) return ["# OpenCanon Service", "", "Status: not-running", "", "Run: opencanon service start"].join("\n");
  const lines = [
    "# OpenCanon Service",
    "",
    `Status: ${inspection.status}`,
    `Transport: ${inspection.entry.transport}`,
    `Pipe: ${inspection.entry.pipeEndpoint}`,
    `URL: ${inspection.entry.url}`,
    `PID: ${inspection.entry.pid}`,
    `Lease: ${inspection.entry.leaseId}`,
    `Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`,
    `Started: ${inspection.entry.startedAt}`,
    `Log: ${inspection.entry.logPath}`,
    `Message: ${inspection.message}`,
  ];
  if (inspection.health) {
    const inference = inspection.health.inference;
    lines.push(
      "",
      "## Inference",
      "",
      `Status: ${inference.status}`,
      `Profile: ${inference.profile.id} (${inference.profile.backend})`,
      `Policy: ${inference.configurationSource} (${inference.configurationPath})`,
      `Queue: ${inference.queueRequests} requests, ${inference.queueBytes} bytes`,
      `Resident model: ${inference.residentModel?.modelId ?? "none"}`,
      `Operations: ${inference.metrics.completedOperations} completed, ${inference.metrics.failedOperations} failed, ${inference.metrics.cancelledOperations} cancelled, ${inference.metrics.rejectedOperations} rejected`,
      `Hosts: ${inference.metrics.hostStarts} starts, ${inference.metrics.hostRetirements} retirements, ${inference.metrics.idleEvictions} idle evictions`,
    );
    if (inference.idleEvictionAt) lines.push(`Idle eviction: ${inference.idleEvictionAt}`);
    if (inference.lastFailure) lines.push(`Last failure: ${inference.lastFailure}`);
  }
  return lines.join("\n");
}

export function renderLifecycleEventsMarkdown(events: ProcessLifecycleEvent[], limit = 50): string {
  const lines = ["# OpenCanon Process Events", ""];
  const selected = events.slice(-limit).reverse();
  if (selected.length === 0) {
    lines.push("No process lifecycle events are registered.");
    return lines.join("\n");
  }
  for (const event of selected) {
    const parts = [`${event.at}`, event.scope, event.kind];
    if (event.rootDir) parts.push(event.rootDir);
    if (event.pid) parts.push(`pid ${event.pid}`);
    lines.push(`- ${parts.join(" | ")}${event.message ? `: ${event.message}` : ""}`);
  }
  return lines.join("\n");
}

export function openRuntimeUrl(url: string): void {
  const command = process.platform === PlatformName.Darwin ? "open" : process.platform === PlatformName.Win32 ? "cmd" : "xdg-open";
  const args = process.platform === PlatformName.Win32 ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    // Opening the browser is best-effort; status/open commands still report the runtime URL.
  });
  child.unref();
}

export function formatRefreshStatus(refresh: RuntimeHealth["refresh"]): string {
  const details = [`mode ${refresh.mode}`, `buffered ${refresh.bufferedEvents}`];
  if (refresh.reason) details.push(refresh.reason);
  return `${refresh.status} (${details.join(", ")})`;
}

function formatLifecycle(lifecycle: ProcessLifecycleState): string {
  const details: string[] = [lifecycle.status];
  if (lifecycle.message) details.push(lifecycle.message);
  if (lifecycle.healthConfirmation) details.push(`confirm health after ${lifecycle.healthConfirmation.confirmationDueAt}`);
  if (lifecycle.restart.attempts > 0) details.push(`restart attempts ${lifecycle.restart.attempts}`);
  if (lifecycle.restart.nextRestartAt) details.push(`next restart ${lifecycle.restart.nextRestartAt}`);
  return details.join("; ");
}

function refreshNeedsManualAction(refresh: RuntimeHealth["refresh"]): boolean {
  return refresh.status === ProjectRefreshStatusValue.Stale || refresh.mode === ProjectRefreshModeValue.Manual;
}
