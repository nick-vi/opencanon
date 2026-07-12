import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createOpenCanonProblem,
  OpenCanonProblemCode,
  OpenCanonProblemSource,
  parseOpenCanonProblem,
  parseOpenCanonProblemFromError,
  writeAtomicJsonFileSync,
  type OpenCanonProblem,
} from "@opencanon/core";

const StartupResultDirectory = "startup";

export function runtimeStartupResultPath(rootDir: string, leaseId: string): string {
  return path.join(rootDir, ".opencanon", StartupResultDirectory, `${leaseId}.json`);
}

export function clearRuntimeStartupResults(rootDir: string): void {
  rmSync(path.join(rootDir, ".opencanon", StartupResultDirectory), { recursive: true, force: true });
}

export function removeRuntimeStartupResult(resultPath: string): void {
  rmSync(resultPath, { force: true });
  rmSync(path.dirname(resultPath), { recursive: true, force: true });
}

export function writeRuntimeStartupFailure(rootDir: string, resultPath: string, problem: OpenCanonProblem): boolean {
  const resolvedResultPath = path.resolve(resultPath);
  const startupDir = path.dirname(resolvedResultPath);
  const stateDir = path.dirname(startupDir);
  if (path.basename(startupDir) !== StartupResultDirectory || !/^[A-Za-z0-9-]+\.json$/.test(path.basename(resolvedResultPath))) return false;
  try {
    if (realpathSync(stateDir) !== realpathSync(path.join(rootDir, ".opencanon"))) return false;
  } catch {
    return false;
  }
  mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  writeAtomicJsonFileSync(resultPath, problem);
  chmodSync(resultPath, 0o600);
  return true;
}

export function readRuntimeStartupFailure(resultPath: string): OpenCanonProblem | undefined {
  try {
    return parseOpenCanonProblem(JSON.parse(readFileSync(resultPath, "utf8")));
  } catch {
    return undefined;
  }
}

export function runtimeStartupProblem(rootDir: string, error: unknown): OpenCanonProblem {
  return parseOpenCanonProblemFromError(error) ?? createOpenCanonProblem({
    code: OpenCanonProblemCode.RuntimePreflightFailed,
    title: "Project runtime startup failed",
    detail: error instanceof Error ? error.message : String(error),
    source: OpenCanonProblemSource.Runtime,
    path: rootDir,
    action: "Inspect OpenCanon project logs, correct the startup failure, then start the project again.",
    retryable: true,
    status: 500,
  });
}
