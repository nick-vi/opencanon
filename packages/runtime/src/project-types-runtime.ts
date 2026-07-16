import path from "node:path";
import { generateProjectTypes, ProjectAuthoringGeneratedDirPath, ProtocolDomain, relative, type ContextPaths } from "@opencanon/core";
import { progressEvent, type EventBroadcaster } from "./server-events.ts";

const ProjectTypesDebounceMs = 500;

export type ProjectTypesRuntime = {
  generateNow(reason: string): void;
  scheduleForFiles(files: string[], reason: string): void;
  stop(): void;
};

export function createProjectTypesRuntime(input: {
  rootDir: string;
  paths(): ContextPaths;
  events: EventBroadcaster;
}): ProjectTypesRuntime {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  return {
    generateNow,
    scheduleForFiles(files, reason) {
      if (!files.some((file) => isProjectTypesGenerationInput(normalizeChangedPath(input.rootDir, file), fixturePrefix(input.rootDir, input.paths())))) return;
      schedule(reason);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };

  function schedule(reason: string): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      generateNow(reason);
    }, ProjectTypesDebounceMs);
  }

  function generateNow(reason: string): void {
    if (stopped) return;
    try {
      generateProjectTypes(input.rootDir, input.paths());
      reportGenerationMessage(reason);
    } catch (error) {
      reportGenerationMessage(`Project authoring type generation failed: ${errorMessage(error)}`);
    }
  }

  function reportGenerationMessage(summary: string): void {
    input.events.broadcast(progressEvent({
      domain: ProtocolDomain.Canon,
      operation: "project-types",
      phase: "definitions",
      summary,
    }));
  }
}

export function isProjectTypesGenerationInput(file: string, fixturePrefix: string): boolean {
  if (file === ProjectAuthoringGeneratedDirPath || file.startsWith(`${ProjectAuthoringGeneratedDirPath}/`)) return false;
  if (file.includes("/node_modules/") || file.startsWith("node_modules/")) return false;
  if (file.includes("/.git/") || file.startsWith(".git/")) return false;

  const name = path.posix.basename(file);
  if (name === "package.json" || name === "Cargo.toml" || name === "pyproject.toml") return true;
  if (/^requirements(?:[-_.A-Za-z0-9]*)?\.txt$/.test(name)) return true;
  if (/^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/.test(name)) return true;
  if (["bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock"].includes(name)) return true;
  return file.startsWith(fixturePrefix) && file.endsWith(".ts");
}

function fixturePrefix(rootDir: string, paths: Pick<ContextPaths, "fixturesDir">): string {
  return `${normalizePath(relative(rootDir, paths.fixturesDir))}/`;
}

function normalizeChangedPath(rootDir: string, file: string): string {
  return normalizePath(path.isAbsolute(file) ? relative(rootDir, file) : file);
}

function normalizePath(file: string): string {
  return file.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
