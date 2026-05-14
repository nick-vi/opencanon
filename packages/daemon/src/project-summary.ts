import path from "node:path";
import { daemonAuthHeaders } from "./auth.ts";
import type { DaemonSnapshot } from "./snapshot.ts";
import { inspectAllDaemons, inspectProjectDaemon } from "./supervisor.ts";
import type { ApiSuccess } from "./routes.ts";

export type ProjectSummary = {
  id: string;
  rootDir: string;
  url: string;
  status: "running" | "unhealthy" | "stale" | "current";
  pid?: number;
  port?: number;
  files?: number;
  findings?: number;
};

export async function listProjects(cwd: string, snapshot: DaemonSnapshot): Promise<ProjectSummary[]> {
  const root = path.resolve(cwd);
  const inspections = await inspectAllDaemons().catch(() => []);
  const authTokens = new Map(inspections.map((inspection) => [inspection.entry.rootDir, inspection.entry.authToken]));
  const summaries: ProjectSummary[] = inspections.map((inspection) => ({
    id: inspection.entry.rootDir,
    rootDir: inspection.entry.rootDir,
    url: inspection.entry.url,
    status: inspection.entry.rootDir === root ? "current" : inspection.status,
    pid: inspection.entry.pid,
    port: inspection.entry.port,
  }));
  const hasCurrent = summaries.some((p) => p.rootDir === root);
  if (!hasCurrent) {
    const self = await inspectProjectDaemon(root).catch(() => undefined);
    summaries.unshift({
      id: root,
      rootDir: root,
      url: self?.entry.url ?? "",
      status: "current",
      pid: self?.entry.pid,
      port: self?.entry.port,
    });
  }
  for (const summary of summaries) {
    if (summary.rootDir === root) {
      summary.files = snapshot.state.files;
      summary.findings = snapshot.state.findings;
      continue;
    }
    await hydrateProjectSummary(summary, authTokens.get(summary.rootDir));
  }
  return summaries;
}

async function hydrateProjectSummary(summary: ProjectSummary, authToken: string | undefined): Promise<void> {
  if (summary.status !== "running" || !authToken) return;
  try {
    const response = await fetch(`${summary.url}/api/snapshot`, { headers: daemonAuthHeaders(authToken), signal: AbortSignal.timeout(1000) });
    if (!response.ok) return;
    const payload = (await response.json()) as ApiSuccess<DaemonSnapshot> | { ok: false };
    if (!payload.ok) return;
    summary.files = payload.data.state.files;
    summary.findings = payload.data.state.findings;
  } catch {
    return;
  }
}
