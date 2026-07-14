import { spawnSync } from "node:child_process";
import path from "node:path";

type TestPhase = {
  name: string;
  files: string[];
  filter?: string;
};

const PhaseTimeoutMs = 5 * 60_000;
const rootDir = process.cwd();
const vitestPath = path.join(rootDir, "node_modules", "vitest", "vitest.mjs");
const processCheckPath = path.join(rootDir, "scripts", "check-test-processes.ts");

const phases: TestPhase[] = [
  {
    name: "CLI ready-work reporting",
    files: ["tests/cli-reporting.test.ts"],
    filter: "changes ready and brief expose agent-ready task work",
  },
  {
    name: "CLI reporting",
    files: ["tests/cli-reporting.test.ts"],
    filter: "^(?!changes ready and brief expose agent-ready task work$).*",
  },
  { name: "Service lifecycle", files: ["packages/runtime/test/service.test.ts"] },
  { name: "Semantic index", files: ["packages/runtime/test/semantic-index.test.ts"] },
  { name: "Validator runtime", files: ["tests/validator-runtime.test.ts"] },
  { name: "Change runs", files: ["packages/runtime/test/change-runs.test.ts"] },
  { name: "Runtime client", files: ["packages/runtime/test/client.test.ts"] },
  { name: "Runtime supervision", files: ["packages/runtime/test/runtime-supervision.test.ts"] },
  { name: "Type producer", files: ["packages/runtime/test/type-producer.test.ts"] },
  { name: "Validation fast path", files: ["tests/validate-cli-fast-path.test.ts"] },
  { name: "Worktree coordination", files: ["tests/worktree.test.ts"] },
];

for (const [index, phase] of phases.entries()) {
  const label = `[runtime-integration ${index + 1}/${phases.length}] ${phase.name}`;
  console.log(`\n${label}`);

  const args = [
    vitestPath,
    "run",
    "--maxWorkers=1",
    "--fileParallelism=false",
    "--testTimeout=120000",
    ...phase.files,
  ];
  if (phase.filter) args.push("-t", phase.filter);

  runBounded(label, process.execPath, args);
  runBounded(`${label} process steady state`, process.execPath, [processCheckPath]);
}

console.log(`\nRuntime integration passed (${phases.length} isolated phases).`);

function runBounded(label: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    timeout: PhaseTimeoutMs,
    killSignal: "SIGKILL",
  });

  if (result.error) {
    const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT";
    throw new Error(timedOut ? `${label} exceeded ${PhaseTimeoutMs / 60_000} minutes.` : `${label} failed to start: ${result.error.message}`);
  }
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
}
