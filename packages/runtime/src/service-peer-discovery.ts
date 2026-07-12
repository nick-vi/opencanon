import { spawnSync } from "node:child_process";

const PlatformName = {
  Win32: "win32",
} as const;

export const ServiceRunCommandToken = "service run";
export const ProjectRuntimeRunCommandToken = "project start --foreground";
export const HiddenServiceRegistryArg = "--registry";

export type ServiceRunPeer = {
  pid: number;
  source: string;
};

export type ProjectRuntimeRunPeer = ServiceRunPeer;

export function discoverServiceRunPeers(input: {
  registryPath: string;
  currentPid?: number;
}): ServiceRunPeer[] {
  return discoverOpenCanonProcessPeers({
    commandToken: ServiceRunCommandToken,
    registryPath: input.registryPath,
    currentPid: input.currentPid,
  });
}

export function discoverProjectRuntimeRunPeers(input: {
  registryPath: string;
  currentPid?: number;
}): ProjectRuntimeRunPeer[] {
  return discoverOpenCanonProcessPeers({
    commandToken: ProjectRuntimeRunCommandToken,
    registryPath: input.registryPath,
    currentPid: input.currentPid,
  });
}

function discoverOpenCanonProcessPeers(input: {
  commandToken: string;
  registryPath: string;
  currentPid?: number;
}): ServiceRunPeer[] {
  const currentPid = input.currentPid ?? process.pid;
  return processCommandRows().flatMap((row) => {
    if (row.pid === currentPid) return [];
    if (!opencanonRunCommandMatches(row.command, input.commandToken, input.registryPath)) return [];
    return [{ pid: row.pid, source: row.command }];
  });
}

function opencanonRunCommandMatches(command: string, commandToken: string, registryPath: string): boolean {
  if (!command.includes(commandToken)) return false;
  return commandReferencesRegistry(command, registryPath);
}

function commandReferencesRegistry(command: string, registryPath: string): boolean {
  return (
    command.includes(`${HiddenServiceRegistryArg} ${registryPath}`) ||
    command.includes(`${HiddenServiceRegistryArg}=${registryPath}`) ||
    command.includes(`${HiddenServiceRegistryArg} ${JSON.stringify(registryPath)}`)
  );
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
