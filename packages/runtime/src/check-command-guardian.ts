import { statSync } from "node:fs";
import { isProcessRunning, isSpawnedProcessTreeRunning, terminateSpawnedProcess } from "./process-tree.ts";

const GuardianPollIntervalMs = 250;

const [commandPidValue, ownerPidValue, heartbeatPath, deadlineValue, staleAfterValue] = process.argv.slice(2);
const commandPid = positiveInteger(commandPidValue, "command pid");
const ownerPid = positiveInteger(ownerPidValue, "owner pid");
const deadlineMs = timestamp(deadlineValue, "deadline");
const staleAfterMs = positiveInteger(staleAfterValue, "heartbeat budget");
if (!heartbeatPath) throw new Error("Check command guardian requires a heartbeat path.");

while (isSpawnedProcessTreeRunning(commandPid)) {
  const nowMs = Date.now();
  if (!isProcessRunning(ownerPid) || heartbeatIsStale(heartbeatPath, nowMs, staleAfterMs) || nowMs >= deadlineMs) {
    await terminateSpawnedProcess(commandPid);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, GuardianPollIntervalMs));
}

function heartbeatIsStale(file: string, nowMs: number, staleAfterMs: number): boolean {
  try {
    return nowMs - statSync(file).mtimeMs > staleAfterMs;
  } catch {
    return true;
  }
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Check command guardian received an invalid ${name}.`);
  return parsed;
}

function timestamp(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Check command guardian received an invalid ${name}.`);
  return parsed;
}
