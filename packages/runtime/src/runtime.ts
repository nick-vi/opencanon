import {
  OpenCanonError,
  createOpenCanonDiagnostic,
  formatOpenCanonDiagnostics,
  lazy,
  satisfiesMinimumVersion,
  type OpenCanonDiagnostic,
} from "@opencanon/core";
import { currentNodeVersion, requiredNodeRequirement, requiredNodeVersion } from "@opencanon/distribution";
import { loadEngine, type Engine } from "@opencanon/engine";

export { currentNodeVersion, requiredNodeRequirement, requiredNodeVersion };

const getEngine = lazy(() => loadEngine());

export type RuntimePrerequisites = {
  nodeVersion: string;
  engine: Engine;
};

export function assertRuntimePrerequisites(): RuntimePrerequisites {
  const diagnostics: OpenCanonDiagnostic[] = [];
  const nodeVersion = currentNodeVersion();
  if (!satisfiesMinimumVersion(nodeVersion, requiredNodeVersion)) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: "node-version-mismatch",
        message: "OpenCanon runtime requires the pinned Node runtime.",
        details: [
          `Expected ${requiredNodeRequirement}; found ${nodeVersion}.`,
          "Runtime-backed commands intentionally fail fast on runtime drift.",
        ],
        action: "Run node --version, install a supported Node runtime with your runtime manager, then rerun opencanon project check.",
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
          action: "Run npm run build:engine.",
        }),
      );
    }
  }

  if (diagnostics.length > 0 || !engine) throw new OpenCanonError(diagnostics);
  return { nodeVersion, engine };
}

export function renderPrerequisiteFailure(error: unknown): string {
  if (error instanceof OpenCanonError) return formatOpenCanonDiagnostics(error.diagnostics);
  return error instanceof Error ? error.message : String(error);
}

export function runtimeVersionSummary(): string {
  return `Node ${requiredNodeRequirement}`;
}

/** Build an http base URL, bracketing IPv6 hosts (e.g. `::1` -> `http://[::1]:port`)
 * so the result is a valid URL. IPv4/hostnames pass through unchanged. */
export function formatHttpBaseUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}
