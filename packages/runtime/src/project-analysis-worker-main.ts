#!/usr/bin/env node
import { runProjectAnalysisWorkerCommand } from "./project-analysis-worker.ts";

try {
  await runProjectAnalysisWorkerCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
