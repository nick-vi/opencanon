import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const PlatformName = {
  Win32: "win32",
} as const;

export const ServiceRunCommandToken = "service run";
export const ProjectRuntimeRunCommandToken = "project start --foreground";
export const HiddenServiceRegistryArg = "--registry";

export type ServicePeerEntrypoint = {
  path: string;
};

export type ServiceRunPeer = {
  pid: number;
  source: string;
};

export type ProjectRuntimeRunPeer = ServiceRunPeer;

export function discoverServiceRunPeers(input: {
  registryPath: string;
  entrypoint: ServicePeerEntrypoint;
  currentPid?: number;
}): ServiceRunPeer[] {
  return discoverOpenCanonProcessPeers({
    commandToken: ServiceRunCommandToken,
    registryPath: input.registryPath,
    entrypoint: input.entrypoint,
    currentPid: input.currentPid,
  });
}

export function discoverProjectRuntimeRunPeers(input: {
  registryPath: string;
  entrypoint: ServicePeerEntrypoint;
  currentPid?: number;
}): ProjectRuntimeRunPeer[] {
  return discoverOpenCanonProcessPeers({
    commandToken: ProjectRuntimeRunCommandToken,
    registryPath: input.registryPath,
    entrypoint: input.entrypoint,
    currentPid: input.currentPid,
  });
}

function discoverOpenCanonProcessPeers(input: {
  commandToken: string;
  registryPath: string;
  entrypoint: ServicePeerEntrypoint;
  currentPid?: number;
}): ServiceRunPeer[] {
  const currentPid = input.currentPid ?? process.pid;
  return processCommandRows().flatMap((row) => {
    if (row.pid === currentPid) return [];
    if (!opencanonRunCommandMatches(row.command, input.commandToken, input.registryPath, input.entrypoint)) return [];
    return [{ pid: row.pid, source: row.command }];
  });
}

function opencanonRunCommandMatches(command: string, commandToken: string, registryPath: string, entrypoint: ServicePeerEntrypoint): boolean {
  if (!command.includes(commandToken)) return false;
  if (commandReferencesRegistry(command, registryPath)) return true;
  return commandReferencesEntrypoint(command, entrypoint.path) && isDefaultUserServiceRegistry(registryPath);
}

function commandReferencesEntrypoint(command: string, entrypointPath: string): boolean {
  return command.includes(entrypointPath) || command.includes(JSON.stringify(entrypointPath));
}

function commandReferencesRegistry(command: string, registryPath: string): boolean {
  return (
    command.includes(`${HiddenServiceRegistryArg} ${registryPath}`) ||
    command.includes(`${HiddenServiceRegistryArg}=${registryPath}`) ||
    command.includes(`${HiddenServiceRegistryArg} ${JSON.stringify(registryPath)}`)
  );
}

function isDefaultUserServiceRegistry(registryPath: string): boolean {
  return path.resolve(registryPath) === path.resolve(path.join(homedir(), ".opencanon", "service.json"));
}

function processCommandRows(): Array<{ pid: number; command: string }> {
  if (process.platform === PlatformName.Win32) return windowsProcessCommandRows();
  return posixProcessCommandRows();
}

function posixProcessCommandRows(): Array<{ pid: number; command: string }> {
  const output = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (output.status !== 0 || !output.stdout) return [];
  return output.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

function windowsProcessCommandRows(): Array<{ pid: number; command: string }> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const output = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (output.status !== 0 || !output.stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const pid = typeof record.ProcessId === "number" ? record.ProcessId : Number(record.ProcessId);
    const command = typeof record.CommandLine === "string" ? record.CommandLine : "";
    if (!Number.isInteger(pid) || pid <= 0 || !command) return [];
    return [{ pid, command }];
  });
}
