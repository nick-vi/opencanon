import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeCheckTimeout, writeAtomicJsonFileSync } from "@opencanon/core";
import { isSpawnedProcessTreeRunning, terminateSpawnedProcess } from "./process-tree.ts";
import { stopService } from "./service-control.ts";
import {
  isProcessRunning,
  readRuntimeRegistry,
  readServiceEntry,
  waitForChildSpawn,
} from "./service-storage.ts";
import { ProjectRuntimeEnv, ServiceEnv } from "./service-types.ts";

const CheckRuntimeDirectoryPrefix = "check-";
const CheckRuntimeOwnerFile = "owner.json";
const CheckRuntimeOwnerVersion = 3;
const CheckRuntimeOwnerCleanupGraceMs = 60_000;
const CheckCommandTerminationGraceMs = 10_000;

type CheckCommandLease = {
  pid: number;
  guardianPid: number;
  startedAt: string;
  deadlineAt: string;
};

type CheckRuntimeOwner = {
  version: typeof CheckRuntimeOwnerVersion;
  ownerPid: number;
  createdAt: string;
  command?: CheckCommandLease;
};

export type IsolatedCheckRuntime = {
  dir: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
  ownCommand(commandPid: number, timeoutMs: number): Promise<void>;
  releaseCommand(commandPid: number): Promise<void>;
};

const IsolatedRuntimeEnvKeys = [
  ServiceEnv.AuthToken,
  ServiceEnv.LeaseId,
  ServiceEnv.OwnerPid,
  ServiceEnv.PipeEndpoint,
  ProjectRuntimeEnv.AuthToken,
  ProjectRuntimeEnv.LeaseId,
  ProjectRuntimeEnv.PipeEndpoint,
  ProjectRuntimeEnv.StateOwnerRegistryPath,
  ProjectRuntimeEnv.StateRoot,
  ProjectRuntimeEnv.StatePath,
] as const;

export async function createIsolatedCheckRuntime(rootDir: string): Promise<IsolatedCheckRuntime> {
  const parentDir = path.join(rootDir, ".opencanon");
  mkdirSync(parentDir, { recursive: true });
  await pruneOrphanedCheckRuntimes(parentDir);

  const dir = mkdtempSync(path.join(parentDir, CheckRuntimeDirectoryPrefix));
  chmodSync(dir, 0o700);
  let owner: CheckRuntimeOwner = {
    version: CheckRuntimeOwnerVersion,
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
  };
  writeCheckRuntimeOwner(dir, owner);
  const registryPath = path.join(dir, "service.json");
  const env: NodeJS.ProcessEnv = { ...process.env, [ServiceEnv.RegistryPath]: registryPath };
  for (const key of IsolatedRuntimeEnvKeys) delete env[key];
  env[ServiceEnv.OwnerPid] = String(process.pid);
  env[ProjectRuntimeEnv.StateOwnerRegistryPath] = registryPath;
  env[ProjectRuntimeEnv.StateRoot] = path.join(dir, "state");
  return {
    dir,
    registryPath,
    env,
    async ownCommand(commandPid, timeoutMs) {
      if (!Number.isInteger(commandPid) || commandPid <= 0) throw new Error("Cannot own a check command without a valid process id.");
      if (owner.command) throw new Error("An isolated check runtime can own only one active command.");
      const startedAt = new Date();
      const deadlineMs = startedAt.getTime() + timeoutMs + CheckCommandTerminationGraceMs;
      const guardian = spawn(process.execPath, [
        checkCommandGuardianEntrypoint(),
        String(commandPid),
        String(process.pid),
        String(deadlineMs),
      ], {
        cwd: rootDir,
        detached: true,
        stdio: "ignore",
        env: checkCommandGuardianEnvironment(),
      });
      let guardianPid: number;
      try {
        guardianPid = await waitForChildSpawn(guardian, "OpenCanon check command guardian");
        guardian.unref();
      } catch (error) {
        await terminateSpawnedProcess(commandPid);
        throw error;
      }
      owner = {
        ...owner,
        command: {
          pid: commandPid,
          guardianPid,
          startedAt: startedAt.toISOString(),
          deadlineAt: new Date(deadlineMs).toISOString(),
        },
      };
      writeCheckRuntimeOwner(dir, owner);
    },
    async releaseCommand(commandPid) {
      if (owner.command?.pid !== commandPid) return;
      const guardianPid = owner.command.guardianPid;
      await terminateSpawnedProcess(commandPid);
      if (isProcessRunning(guardianPid)) await terminateSpawnedProcess(guardianPid);
      owner = { version: owner.version, ownerPid: owner.ownerPid, createdAt: owner.createdAt };
      writeCheckRuntimeOwner(dir, owner);
    },
  };
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
  const owner = readCheckRuntimeOwner(dir);
  if (owner?.command && checkCommandLeaseMayStillOwnProcess(owner.command)) {
    if (isSpawnedProcessTreeRunning(owner.command.pid)) await terminateSpawnedProcess(owner.command.pid);
    if (isProcessRunning(owner.command.guardianPid)) await terminateSpawnedProcess(owner.command.guardianPid);
  }
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
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      (parsed.command !== undefined && !isCheckCommandLease(parsed.command))
    ) return undefined;
    return parsed as CheckRuntimeOwner;
  } catch {
    return undefined;
  }
}

function isCheckCommandLease(value: unknown): value is CheckCommandLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid) && Number(record.pid) > 0 &&
    Number.isInteger(record.guardianPid) && Number(record.guardianPid) > 0 &&
    typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt)) &&
    typeof record.deadlineAt === "string" && Number.isFinite(Date.parse(record.deadlineAt));
}

function checkRuntimeOwnerIsActive(owner: CheckRuntimeOwner): boolean {
  const ageMs = Date.now() - Date.parse(owner.createdAt);
  return ageMs <= ChangeCheckTimeout.MaximumMs + CheckRuntimeOwnerCleanupGraceMs && isProcessRunning(owner.ownerPid);
}

function checkCommandLeaseMayStillOwnProcess(lease: CheckCommandLease): boolean {
  return Date.now() <= Date.parse(lease.deadlineAt) + CheckRuntimeOwnerCleanupGraceMs;
}

function writeCheckRuntimeOwner(dir: string, owner: CheckRuntimeOwner): void {
  const file = path.join(dir, CheckRuntimeOwnerFile);
  writeAtomicJsonFileSync(file, owner);
  chmodSync(file, 0o600);
}

function checkCommandGuardianEntrypoint(): string {
  const source = fileURLToPath(new URL("./check-command-guardian.ts", import.meta.url));
  if (existsSync(source)) return source;
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-command-guardian.js");
  if (existsSync(bundled)) return bundled;
  throw new Error("OpenCanon check command guardian is missing from the runtime.");
}

function checkCommandGuardianEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of IsolatedRuntimeEnvKeys) delete env[key];
  delete env[ServiceEnv.RegistryPath];
  return env;
}
