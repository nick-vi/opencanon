import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalTransportKind } from "./local-protocol.ts";
import { RuntimeCliInvocationKind, ancestorPaths, nodeCommandForCliInvocation, nonEmptyString, type RuntimeCliEntrypoint } from "./service-entrypoint.ts";
import { LocalControlProtocolVersion, ServiceEnv, type RuntimeRegistryEntry } from "./service-types.ts";

export type RuntimeIdentity = Pick<RuntimeRegistryEntry, "transport" | "protocolVersion" | "runtimeVersion" | "runtimeFingerprint" | "cliPath">;

export function openCanonRuntimeVersion(): string {
  const configured = nonEmptyString(process.env.OPENCANON_RUNTIME_VERSION);
  if (configured) return configured;
  const packageVersion = packageVersionFromAncestors(path.dirname(fileURLToPath(import.meta.url)));
  return packageVersion ?? "0.0.0-dev";
}

export function runtimeIdentityForEntrypoint(entrypoint: RuntimeCliEntrypoint): RuntimeIdentity {
  return {
    transport: LocalTransportKind.Pipe,
    protocolVersion: LocalControlProtocolVersion,
    runtimeVersion: openCanonRuntimeVersion(),
    runtimeFingerprint: runtimeFingerprintForEntrypoint(entrypoint),
    cliPath: entrypoint.path,
  };
}

export function runtimeIdentityMatches(entry: Pick<RuntimeRegistryEntry, keyof RuntimeIdentity>, identity: RuntimeIdentity): boolean {
  return (
    entry.transport === identity.transport &&
    entry.protocolVersion === identity.protocolVersion &&
    entry.runtimeVersion === identity.runtimeVersion &&
    entry.runtimeFingerprint === identity.runtimeFingerprint &&
    entry.cliPath === identity.cliPath
  );
}

export function ownerPidFromEnv(): number | undefined {
  const value = Number(process.env[ServiceEnv.OwnerPid]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function createProcessLeaseId(): string {
  return randomUUID();
}

function runtimeFingerprintForEntrypoint(entrypoint: RuntimeCliEntrypoint): string {
  const hash = createHash("sha256");
  hash.update("opencanon-runtime-v1\0");
  hash.update(`${openCanonRuntimeVersion()}\0`);
  hash.update(`${entrypoint.kind}\0`);
  hash.update("cli\0");
  hashPathIdentity(hash, entrypoint.path);
  if (entrypoint.kind === RuntimeCliInvocationKind.NodeScript) {
    hash.update("\0node\0");
    hashPathIdentity(hash, nodeCommandForCliInvocation());
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashPathIdentity(hash: ReturnType<typeof createHash>, entrypointPath: string): void {
  try {
    const resolved = realpathSync(entrypointPath);
    const stat = statSync(resolved);
    hash.update(`${resolved}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`);
  } catch {
    hash.update(entrypointPath);
  }
}

function packageVersionFromAncestors(startDir: string): string | undefined {
  for (const dir of ancestorPaths(startDir)) {
    const packageJsonPath = path.join(dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
      if ((parsed.name === "@opencanon/runtime" || parsed.name === "opencanon") && typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version;
      }
    } catch {
      // Ignore malformed package metadata; the runtime remains usable with a dev marker.
    }
  }
  return undefined;
}
