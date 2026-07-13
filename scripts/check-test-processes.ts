import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

type ProcessRecord = {
  pid: number;
  parentPid: number;
  command: string;
};

const SourceCliPath = path.resolve("packages/cli/src/index.ts");
const TestProcessRetirementTimeoutMs = 3_000;
const TestProcessPollMs = 100;

const deadline = Date.now() + TestProcessRetirementTimeoutMs;
let active = testOwnedOpenCanonProcesses();
while (active.length > 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, TestProcessPollMs));
  active = testOwnedOpenCanonProcesses();
}

if (active.length > 0) {
  const details = active
    .map((entry) => `- pid=${entry.pid} ppid=${entry.parentPid} ${entry.command}`)
    .join("\n");
  throw new Error(`OpenCanon tests left source service processes running:\n${details}`);
}

console.log("OpenCanon test process steady state passed.");

function testOwnedOpenCanonProcesses(): ProcessRecord[] {
  const tempRoot = path.resolve(tmpdir());
  return listProcesses().filter((entry) => {
    if (!entry.command.includes(SourceCliPath)) return false;
    const registryPath = commandOption(entry.command, "--registry");
    if (!registryPath) return false;
    const relative = path.relative(tempRoot, path.resolve(registryPath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function listProcesses(): ProcessRecord[] {
  if (process.platform === "win32") return listWindowsProcesses();
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }];
  });
}

function listWindowsProcesses(): ProcessRecord[] {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as Record<string, unknown> | Array<Record<string, unknown>>;
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
    if (typeof entry.ProcessId !== "number" || typeof entry.ParentProcessId !== "number" || typeof entry.CommandLine !== "string") return [];
    return [{ pid: entry.ProcessId, parentPid: entry.ParentProcessId, command: entry.CommandLine }];
  });
}

function commandOption(command: string, option: string): string | undefined {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
