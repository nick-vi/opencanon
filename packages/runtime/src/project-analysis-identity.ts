import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validationContextFiles, type ProjectContext } from "@opencanon/core";

export type ProjectAnalysisIdentity = {
  hash: string;
  sourceInventoryHash: string;
};

export function projectAnalysisIdentity(input: {
  project: ProjectContext;
  sourceInventoryHash: string;
}): ProjectAnalysisIdentity {
  const { project } = input;
  return {
    sourceInventoryHash: input.sourceInventoryHash,
    hash: stableHash({
      version: 1,
      sourceInventoryHash: input.sourceInventoryHash,
      definitions: {
        areas: project.areaGraph.hash,
        specs: project.specGraph.hash,
        changes: project.changeGraph.hash,
        conventions: project.validatorGraph.hash,
      },
      configuration: {
        projectFilePatterns: project.paths.projectFilePatterns,
        ignore: project.paths.ignore,
        entrypoints: project.paths.entrypoints,
        publicSurfaces: project.paths.publicSurfaces,
        generated: project.paths.generated,
        externalTools: project.paths.externalTools,
        requiredPackageScripts: project.paths.requiredPackageScripts,
        fileDiscovery: project.paths.fileDiscovery,
        maxFiles: project.paths.maxFiles,
        maxFileSizeKb: project.paths.maxFileSizeKb,
        semanticEmbedding: project.paths.semanticEmbedding,
      },
      contextFiles: validationContextFiles(project.paths).map((file) => ({
        path: file,
        contentHash: fileContentHash(project.rootDir, file),
      })),
    }),
  };
}

function fileContentHash(rootDir: string, file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path.join(rootDir, file))).digest("hex");
  } catch {
    return null;
  }
}

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
