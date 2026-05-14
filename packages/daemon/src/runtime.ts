import {
  OpenCanonError,
  createOpenCanonDiagnostic,
  formatOpenCanonDiagnostics,
  lazy,
  type OpenCanonDiagnostic,
} from "@opencanon/core";
import { loadEngine, type Engine } from "@opencanon/engine";

export const requiredBunVersion = "1.3.13";
export const daemonSchemaVersion = 1;
const getEngine = lazy(() => loadEngine());

export type DaemonPrerequisites = {
  bunVersion: string;
  engine: Engine;
};

export function currentBunVersion(): string {
  return typeof Bun === "undefined" ? "<not-bun>" : Bun.version;
}

export function assertDaemonPrerequisites(): DaemonPrerequisites {
  const diagnostics: OpenCanonDiagnostic[] = [];
  const bunVersion = currentBunVersion();
  if (bunVersion !== requiredBunVersion) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: "bun-version-mismatch",
        message: "OpenCanon daemon requires the pinned Bun runtime.",
        details: [
          `Expected ${requiredBunVersion}; found ${bunVersion}.`,
          "Daemon-backed commands intentionally fail fast on runtime drift.",
        ],
        action: "Run bun --version, install the pinned Bun runtime with your runtime manager, then rerun bun run opencanon daemon check.",
      }),
    );
  }

  let engine: Engine | undefined;
  try {
    engine = getEngine();
  } catch (error) {
    if (error instanceof OpenCanonError) diagnostics.push(...error.diagnostics);
    else {
      diagnostics.push(
        createOpenCanonDiagnostic({
          code: "engine-binary-missing",
          message: "OpenCanon engine could not be loaded.",
          details: [error instanceof Error ? error.message : String(error)],
          action: "Run bun run build:engine.",
        }),
      );
    }
  }

  if (diagnostics.length > 0 || !engine) throw new OpenCanonError(diagnostics);
  return { bunVersion, engine };
}

export function renderPrerequisiteFailure(error: unknown): string {
  if (error instanceof OpenCanonError) return formatOpenCanonDiagnostics(error.diagnostics);
  return error instanceof Error ? error.message : String(error);
}

export function daemonVersionSummary(): string {
  return `Bun ${requiredBunVersion}, engine schema ${daemonSchemaVersion}`;
}
