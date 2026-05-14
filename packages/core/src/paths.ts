import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type SafeRelativePathResult = { ok: true; path: string } | { ok: false; message: string };

export type ResolvedInsideRootResult = { ok: true; path: string; absolutePath: string } | { ok: false; message: string };

export function safeRelativePath(input: string, options: { allowEmpty?: boolean } = {}): SafeRelativePathResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    if (options.allowEmpty) return { ok: true, path: "" };
    return { ok: false, message: "Path is required." };
  }
  if (path.isAbsolute(trimmed)) return { ok: false, message: "Absolute paths are not allowed." };

  const slashPath = trimmed.replace(/\\/g, "/");
  if (/^[^/]+:/.test(slashPath)) return { ok: false, message: "Drive-qualified paths are not allowed." };
  if (slashPath.split("/").includes("..")) return { ok: false, message: "Path traversal is not allowed." };

  const normalized = path.posix.normalize(slashPath);
  if (normalized.startsWith("..") || normalized.split("/").includes("..")) return { ok: false, message: "Path traversal is not allowed." };

  const withoutCurrentDirectory = normalized === "." ? "" : normalized.replace(/^\.\//, "");
  const cleaned = withoutCurrentDirectory.replace(/\/$/, "");
  if (cleaned === "" && !options.allowEmpty) return { ok: false, message: "Path is required." };
  return { ok: true, path: cleaned };
}

export function resolveInsideRoot(rootDir: string, input: string, options: { allowEmpty?: boolean } = {}): ResolvedInsideRootResult {
  const safe = safeRelativePath(input, options);
  if (!safe.ok) return safe;

  const root = path.resolve(rootDir);
  const realRoot = realPathOrResolved(root);
  const absolutePath = path.resolve(root, safe.path);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    return { ok: false, message: "Path must resolve inside the target root." };
  }
  const existingPath = nearestExistingPath(absolutePath);
  if (existingPath) {
    const realExistingPath = realPathOrResolved(existingPath);
    if (realExistingPath !== realRoot && !realExistingPath.startsWith(`${realRoot}${path.sep}`)) {
      return { ok: false, message: "Path must not resolve through a symlink outside the target root." };
    }
  }

  return { ok: true, path: safe.path, absolutePath };
}

function nearestExistingPath(filePath: string): string | undefined {
  let current = filePath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function realPathOrResolved(filePath: string): string {
  return existsSync(filePath) ? realpathSync(filePath) : path.resolve(filePath);
}
