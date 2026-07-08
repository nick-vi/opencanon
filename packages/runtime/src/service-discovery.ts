import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveRootDir } from "@opencanon/core";
import { discoveryRootChildLimit } from "./service-types.ts";

export function discoverOpenCanonProject(cwd: string): { rootDir: string } | undefined {
  const rootDir = resolveRootDir(cwd);
  if (isOpenCanonProjectDirectory(rootDir)) return { rootDir };
  return undefined;
}

export function discoverOpenCanonProjectsFromRoots(roots: string[]): Array<{ rootDir: string }> {
  const projects = new Map<string, { rootDir: string }>();
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const rootPath = path.resolve(trimmed);
    if (!directoryExists(rootPath)) continue;
    addDiscoveredOpenCanonProject(projects, rootPath);
    for (const child of discoveryRootChildren(rootPath)) {
      addDiscoveredOpenCanonProject(projects, child);
    }
  }
  return [...projects.values()].sort((left, right) => left.rootDir.localeCompare(right.rootDir));
}

export function directoryExists(rootDir: string): boolean {
  try {
    return statSync(rootDir).isDirectory();
  } catch {
    return false;
  }
}

export function realpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function addDiscoveredOpenCanonProject(projects: Map<string, { rootDir: string }>, candidate: string): void {
  if (!isOpenCanonProjectDirectory(candidate)) return;
  const rootDir = realpath(candidate);
  projects.set(rootDir, { rootDir });
}

function discoveryRootChildren(rootDir: string): string[] {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, discoveryRootChildLimit)
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function isOpenCanonProjectDirectory(rootDir: string): boolean {
  return existsSync(path.join(rootDir, "opencanon.config.json")) || existsSync(path.join(rootDir, "opencanon", "conventions", "index.ts"));
}
