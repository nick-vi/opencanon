import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { daemonAuthHeaders, inspectProjectDaemon, startOpenCanonDaemon, type DaemonServer } from "@opencanon/daemon";
import { createOpenCanonDiagnostic, formatOpenCanonDiagnostics, resolveRootDir, type OpenCanonDiagnostic } from "@opencanon/core";

export const DaemonApiRoute = {
  CanonRelated: "/api/canon/related",
  Feedback: "/api/feedback",
  HookFeedback: "/api/hook-feedback",
  Snapshot: "/api/snapshot",
  Validate: "/api/validate",
} as const;

const EphemeralDaemonState = {
  Prefix: "opencanon-ephemeral-",
  StateFile: "state.sqlite",
} as const;

export type DaemonClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
};

type DaemonResponse<T> = {
  ok: boolean;
  data?: T;
  diagnostics?: unknown[];
};

export async function withDaemonClient<T>(cwd: string, callback: (client: DaemonClient) => Promise<T>): Promise<T> {
  const rootDir = resolveRootDir(cwd);
  const inspection = await inspectProjectDaemon(rootDir);
  let server: DaemonServer | undefined;
  let ephemeralStateDir: string | undefined;

  try {
    let url = inspection?.status === "running" ? inspection.entry.url : undefined;
    let authToken = inspection?.status === "running" ? inspection.entry.authToken : undefined;
    if (!url) {
      ephemeralStateDir = mkdtempSync(path.join(tmpdir(), EphemeralDaemonState.Prefix));
      server = await startOpenCanonDaemon({
        cwd: rootDir,
        port: 0,
        serveUi: false,
        statePath: path.join(ephemeralStateDir, EphemeralDaemonState.StateFile),
      });
      url = server.url;
      authToken = server.authToken;
    }
    const headers = authToken ? daemonAuthHeaders(authToken) : undefined;

    return await callback({
      async get<T>(path: string) {
        const response = await fetch(`${url}${path}`, { headers });
        return parseDaemonResponse<T>(response);
      },
      async post<T>(path: string, body: unknown) {
        const response = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        });
        return parseDaemonResponse<T>(response);
      },
    });
  } finally {
    if (server) await server.stop();
    if (ephemeralStateDir) rmSync(ephemeralStateDir, { recursive: true, force: true });
  }
}

async function parseDaemonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as DaemonResponse<T>;
  if (!response.ok || !payload.ok) {
    const diagnostics =
      payload.diagnostics && payload.diagnostics.length > 0
        ? payload.diagnostics
        : [
            createOpenCanonDiagnostic({
              code: "daemon-not-running",
              message: `OpenCanon daemon request failed: ${response.status} ${response.statusText}.`,
              action: "Run bun run opencanon daemon start, or rerun the command to use an ephemeral daemon.",
            }),
          ];
    throw new Error(formatOpenCanonDiagnostics(diagnostics as OpenCanonDiagnostic[]));
  }
  return payload.data as T;
}
