import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ChangeCheckTimeout } from "@opencanon/core";
import { stopService } from "./service-control.ts";
import {
  isProcessRunning,
  readRuntimeRegistry,
  readServiceEntry,
} from "./service-storage.ts";
import { ProjectRuntimeEnv, ServiceEnv } from "./service-types.ts";

const CheckRuntimeDirectoryPrefix = "check-";
const CheckRuntimeOwnerFile = "owner.json";
const CheckRuntimeOwnerVersion = 1;
const CheckRuntimeOwnerCleanupGraceMs = 60_000;

type CheckRuntimeOwner = {
  version: typeof CheckRuntimeOwnerVersion;
  ownerPid: number;
  createdAt: string;
};

export type IsolatedCheckRuntime = {
  dir: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
};

const IsolatedRuntimeEnvKeys = [
  ServiceEnv.AuthToken,
  ServiceEnv.LeaseId,
  ServiceEnv.OwnerPid,
  ServiceEnv.PipeEndpoint,
  ProjectRuntimeEnv.AuthToken,
  ProjectRuntimeEnv.LeaseId,
  ProjectRuntimeEnv.PipeEndpoint,
] as const;

export async function createIsolatedCheckRuntime(rootDir: string): Promise<IsolatedCheckRuntime> {
  const parentDir = path.join(rootDir, ".opencanon");
  mkdirSync(parentDir, { recursive: true });
  await pruneOrphanedCheckRuntimes(parentDir);

  const dir = mkdtempSync(path.join(parentDir, CheckRuntimeDirectoryPrefix));
  writeFileSync(
    path.join(dir, CheckRuntimeOwnerFile),
    `${JSON.stringify({
      version: CheckRuntimeOwnerVersion,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    } satisfies CheckRuntimeOwner, null, 2)}\n`,
    { mode: 0o600 },
  );
  const registryPath = path.join(dir, "service.json");
  const env: NodeJS.ProcessEnv = { ...process.env, [ServiceEnv.RegistryPath]: registryPath };
  for (const key of IsolatedRuntimeEnvKeys) delete env[key];
  env[ServiceEnv.OwnerPid] = String(process.pid);
  return { dir, registryPath, env };
}

export async function cleanupIsolatedCheckRuntime(runtime: IsolatedCheckRuntime): Promise<void> {
  await retireCheckRuntimeDirectory(runtime.dir, runtime.registryPath);
}

export async function pruneOrphanedCheckRuntimes(parentDir: string): Promise<number> {
  if (!existsSync(parentDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(CheckRuntimeDirectoryPrefix)) continue;
    const dir = path.join(parentDir, entry.name);
    const registryPath = path.join(dir, "service.json");
    const owner = readCheckRuntimeOwner(dir);
    if (owner && checkRuntimeOwnerIsActive(owner)) continue;
    await retireCheckRuntimeDirectory(dir, registryPath);
    removed += 1;
  }
  return removed;
}

async function retireCheckRuntimeDirectory(dir: string, registryPath: string): Promise<void> {
  await stopService(registryPath);
  const activePids = [
    readServiceEntry(registryPath)?.pid,
    ...readRuntimeRegistry(registryPath).map((entry) => entry.pid),
  ].filter((pid): pid is number => pid !== undefined && isProcessRunning(pid));
  if (activePids.length > 0) {
    throw new Error(`Could not retire isolated check runtime processes: ${activePids.join(", ")}.`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function readCheckRuntimeOwner(dir: string): CheckRuntimeOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, CheckRuntimeOwnerFile), "utf8")) as Partial<CheckRuntimeOwner>;
    if (
      parsed.version !== CheckRuntimeOwnerVersion ||
      !Number.isInteger(parsed.ownerPid) ||
      (parsed.ownerPid ?? 0) <= 0 ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) return undefined;
    return parsed as CheckRuntimeOwner;
  } catch {
    return undefined;
  }
}

function checkRuntimeOwnerIsActive(owner: CheckRuntimeOwner): boolean {
  const ageMs = Date.now() - Date.parse(owner.createdAt);
  return ageMs <= ChangeCheckTimeout.MaximumMs + CheckRuntimeOwnerCleanupGraceMs && isProcessRunning(owner.ownerPid);
}
