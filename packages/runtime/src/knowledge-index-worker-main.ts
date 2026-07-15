#!/usr/bin/env node
import { runKnowledgeIndexWorkerCommand } from "./knowledge-index-worker.ts";

try {
  await runKnowledgeIndexWorkerCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
