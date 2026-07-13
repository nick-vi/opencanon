import { isProcessRunning, isSpawnedProcessTreeRunning, terminateSpawnedProcess } from "./process-tree.ts";

const GuardianPollIntervalMs = 250;

const [commandPidValue, ownerPidValue, deadlineValue] = process.argv.slice(2);
const commandPid = positiveInteger(commandPidValue, "command pid");
const ownerPid = positiveInteger(ownerPidValue, "owner pid");
const deadlineMs = timestamp(deadlineValue, "deadline");

while (isSpawnedProcessTreeRunning(commandPid)) {
  const nowMs = Date.now();
  if (!isProcessRunning(ownerPid) || nowMs >= deadlineMs) {
    await terminateSpawnedProcess(commandPid);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, GuardianPollIntervalMs));
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
