import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const RuntimeNamespaceEnv = "OPENCANON_RUNTIME_NAMESPACE";
export const StableRuntimeNamespace = "stable";

const RuntimeNamespacePattern = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const SourceCliSuffix = "/packages/cli/src/index.ts";

export function defaultRuntimeNamespace(cliPath = process.argv[1] ?? ""): string {
  const configured = process.env[RuntimeNamespaceEnv]?.trim();
  if (configured) return validateRuntimeNamespace(configured);
  const sourceRoot = sourceCheckoutRoot(cliPath);
  return sourceRoot ? `dev-${shortHash(sourceRoot)}` : StableRuntimeNamespace;
}

export function runtimeNamespaceForRegistry(registryPath: string): string {
  const resolved = path.resolve(registryPath);
  const namespace = path.basename(path.dirname(resolved));
  const namespaceParent = path.basename(path.dirname(path.dirname(resolved)));
  if (path.basename(resolved) === "service.json" && namespaceParent === "namespaces" && RuntimeNamespacePattern.test(namespace)) {
    return namespace;
  }
  return `custom-${shortHash(resolved)}`;
}

export function defaultServiceRegistryPath(homeDir = homedir(), namespace = defaultRuntimeNamespace()): string {
  return path.join(homeDir, ".opencanon", "namespaces", validateRuntimeNamespace(namespace), "service.json");
}

export function validateRuntimeNamespace(namespace: string): string {
  if (!RuntimeNamespacePattern.test(namespace)) {
    throw new Error("OpenCanon runtime namespace must contain 1-63 lowercase letters, digits, or hyphens and must start with a letter or digit.");
  }
  return namespace;
}

export function projectProcessStateDirectory(rootDir: string, namespace: string): string {
  return path.join(rootDir, ".opencanon", "processes", validateRuntimeNamespace(namespace));
}

function sourceCheckoutRoot(cliPath: string): string | undefined {
  const normalized = path.resolve(cliPath || ".").replace(/\\/g, "/");
  if (!normalized.endsWith(SourceCliSuffix)) return undefined;
  return normalized.slice(0, -SourceCliSuffix.length);
}

function shortHash(value: string): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 12);
}
