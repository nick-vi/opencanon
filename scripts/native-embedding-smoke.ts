import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultNativeSemanticEmbeddingModelId, createPaths } from "@opencanon/core";
import { openProjectStore } from "@opencanon/runtime";

const SmokeEnv = {
  Model: "OPENCANON_NATIVE_EMBEDDING_MODEL",
} as const;

if (process.argv.includes("--optional")) {
  console.log("Skipping native embedding smoke because --optional was provided.");
  process.exit(0);
}

const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-native-embedding-smoke-"));
const modelId = process.env[SmokeEnv.Model]?.trim() || DefaultNativeSemanticEmbeddingModelId;
let store: ReturnType<typeof openProjectStore> | undefined;

try {
  store = openProjectStore({
    rootDir,
    paths: createPaths(rootDir),
    statePath: path.join(rootDir, ".opencanon", "state.sqlite"),
  });
  const result = store.project.embedSemanticTexts({
    modelId,
    task: "query",
    texts: ["OpenCanon project conventions and specs"],
    showDownloadProgress: true,
  });
  const vector = result.vectors[0] ?? [];
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Native embedding smoke returned an invalid vector for ${modelId}.`);
  }
  console.log(`Native embedding smoke passed with ${result.modelId}: ${vector.length} dimensions.`);
} finally {
  store?.close();
  rmSync(rootDir, { recursive: true, force: true });
}
