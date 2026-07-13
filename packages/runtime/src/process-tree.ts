import { spawn } from "node:child_process";

const ProcessPlatform = {
  Win32: "win32",
} as const;

const ProcessTerminationGraceMs = 1_500;
const ProcessExitPollIntervalMs = 50;

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isSpawnedProcessTreeRunning(pid: number): boolean {
  if (process.platform === ProcessPlatform.Win32) return isProcessRunning(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return isProcessRunning(pid);
  }
}

export async function terminateSpawnedProcess(pid: number): Promise<void> {
  if (process.platform === ProcessPlatform.Win32) {
    await terminateWindowsProcessTree(pid);
    return;
  }
  signalPosixProcessTree(pid, "SIGTERM");
  const stopped = await waitForProcessTreeExit(pid, ProcessTerminationGraceMs);
  if (stopped || !isSpawnedProcessTreeRunning(pid)) return;
  signalPosixProcessTree(pid, "SIGKILL");
  await waitForProcessTreeExit(pid, ProcessTerminationGraceMs);
}

async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isSpawnedProcessTreeRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, ProcessExitPollIntervalMs));
  }
  return !isSpawnedProcessTreeRunning(pid);
}

function signalPosixProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Embedded callers and tests may pass a process that is not a process-group leader.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process exited before the signal was delivered.
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) return;
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    child.once("exit", () => resolve());
    child.once("error", () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited or the platform rejected the signal.
      }
      resolve();
    });
  });
  if (!isProcessRunning(pid)) return;
  await waitForProcessTreeExit(pid, ProcessTerminationGraceMs);
}
