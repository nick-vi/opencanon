import path from "node:path";
import type { RuntimeSnapshot } from "./snapshot.ts";
import { RuntimeStatus, inspectAllRuntimes, type RuntimeRegistryEntry, type RuntimeStatus as RuntimeStatusType } from "./service.ts";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";

export type ProjectSummary = {
  id: string;
  rootDir: string;
  url: string;
  status: RuntimeStatusType;
  selected: boolean;
  pid?: number;
  port?: number;
  files?: number;
  findings?: number;
};

export async function listProjects(cwd: string, snapshot: RuntimeSnapshot): Promise<ProjectSummary[]> {
  const root = path.resolve(cwd);
  const inspections = await inspectAllRuntimes().catch(() => []);
  const entries = new Map(inspections.map((inspection) => [inspection.entry.rootDir, inspection.entry]));
  const summaries: ProjectSummary[] = inspections.map((inspection) => ({
    id: inspection.entry.rootDir,
    rootDir: inspection.entry.rootDir,
    url: inspection.entry.url,
    status: inspection.status,
    selected: inspection.entry.rootDir === root,
    pid: inspection.entry.pid,
    port: inspection.entry.port,
  }));
  const hasCurrent = summaries.some((p) => p.rootDir === root);
  if (!hasCurrent) {
    summaries.unshift({
      id: root,
      rootDir: root,
      url: "",
      status: RuntimeStatus.Running,
      selected: true,
    });
  }
  for (const summary of summaries) {
    if (summary.rootDir === root) {
      summary.files = snapshot.state.files;
      summary.findings = snapshot.state.findings;
      continue;
    }
    await hydrateProjectSummary(summary, entries.get(summary.rootDir));
  }
  return summaries;
}

async function hydrateProjectSummary(summary: ProjectSummary, entry: RuntimeRegistryEntry | undefined): Promise<void> {
  if (summary.status !== RuntimeStatus.Running || !entry) return;
  try {
    const payload = await requestLocalJson<RuntimeSnapshot>(localProtocolEndpointFromEntry(entry), { method: "GET", path: "/api/snapshot" });
    summary.files = payload.state.files;
    summary.findings = payload.state.findings;
  } catch {
    return;
  }
}
