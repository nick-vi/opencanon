import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicTextFileSync } from "./atomic.ts";
import { explainPatterns, matchesAnyPath, matchesPath } from "./globs.ts";

/** Parse a semver-ish version into comparable parts. The 4th part ranks a stable
 * release (1) ABOVE a prerelease (0) of the same x.y.z, so e.g. 24.12.0-rc.1 does
 * NOT satisfy a >=24.12.0 stable floor. Returns null for unparseable input. */
export function parseVersionParts(value: string): [number, number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1];
}

/** True when `actual` is >= `minimum` (prerelease-aware). Unparseable input is treated
 * as not satisfying the floor. */
export function satisfiesMinimumVersion(actual: string, minimum: string): boolean {
  const actualParts = parseVersionParts(actual);
  const minimumParts = parseVersionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

export function matchesAny(file: string, globs: string[]): boolean {
  return matchesPath(file, globs);
}

export function matchesAnyFile(files: string[], globs: string[]): boolean {
  return matchesAnyPath(files, globs);
}

export function explainGlobMatches(file: string, globs: string[]) {
  return explainPatterns(file, globs);
}

export function intersects(left: string[], right: string[]): boolean {
  const values = new Set(right);
  return left.some((value) => values.has(value));
}

export function splitList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const char of value) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "," && braceDepth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function toRepoRelativePath(rootDir: string, value: string, cwd = process.cwd()): string {
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relativeToRoot = path.relative(rootDir, absolute);
  if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) return normalizePath(relativeToRoot);
  return normalizePath(value.replace(/^\.\//, ""));
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relative(rootDir: string, value: string): string {
  return normalizePath(path.relative(rootDir, value));
}

export function pathToImportUrl(file: string): string {
  return pathToFileURL(file).href;
}

export function writeTextFileIfChangedSync(filePath: string, content: string): void {
  try {
    if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) return;
  } catch {
    // Fall through to an atomic rewrite if an existing cache file cannot be read.
  }
  writeAtomicTextFileSync(filePath, content);
}
