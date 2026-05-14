import path from "node:path";
import { pathToFileURL } from "node:url";
import { explainPatterns, matchesAnyPath, matchesPath } from "./globs.ts";

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
