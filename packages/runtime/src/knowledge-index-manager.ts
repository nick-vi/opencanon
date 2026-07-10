import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DefaultSemanticIndexId,
  discoverProjectFiles,
  engineSourceLanguage,
  isEngineExtractableFile,
  loadProjectContext,
  type FactDiagnostic,
  type FactKind,
  type ScanAndDiffResult,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { ENGINE_PARSER_VERSION } from "./ast-facts-provider.ts";
import { buildProjectSemanticIndex, buildProjectSemanticIndexDelta, semanticSearchVectorForProvider } from "./semantic-index.ts";
import { listPreviousSemanticChunks } from "./semantic-index-snapshot.ts";
import type { ProjectStore } from "./state.ts";

const allFactKinds: FactKind[] = ["imports", "exports", "symbols", "calls", "literals", "comments"];
const ErrorSeverity = "error";

export const KnowledgeIndexPhase = {
  Scan: "scan",
  Diff: "diff",
  Chunk: "chunk",
  Embed: "embed",
  Write: "write",
  Prewarm: "prewarm",
  Ready: "ready",
} as const;
export type KnowledgeIndexPhase = (typeof KnowledgeIndexPhase)[keyof typeof KnowledgeIndexPhase];

export type KnowledgeIndexProgress = {
  phase: KnowledgeIndexPhase;
  label: string;
  current?: number;
  total?: number;
  unit?: string;
};

export type KnowledgeIndexRunOptions = {
  force?: boolean;
  onProgress?: (progress: KnowledgeIndexProgress) => void;
};

export type KnowledgeIndexRunResult = {
  index: SemanticIndexSnapshot;
  scan: ScanAndDiffResult;
  mode: "full" | "delta";
};

export type KnowledgeIndexManager = {
  index(options?: KnowledgeIndexRunOptions): Promise<KnowledgeIndexRunResult>;
};

export function createKnowledgeIndexManager(input: {
  rootDir: string;
  store: ProjectStore;
}): KnowledgeIndexManager {
  return {
    async index(options = {}) {
      const emit = options.onProgress ?? (() => undefined);
      emit({ phase: KnowledgeIndexPhase.Scan, label: "Scanning project files" });
      const project = await loadProjectContext(input.rootDir);
      const discovery = discoverProjectFiles(project.paths);
      if (discovery.failed) {
        throw new Error(discovery.diagnostics.join("\n"));
      }
      const scan = input.store.scanAndDiff(discovery.files);
      emit({
        phase: KnowledgeIndexPhase.Diff,
        label: "Diffing Project Knowledge inventory",
        current: scan.changedFiles.length + scan.deletedFiles.length,
        total: scan.files.length,
        unit: "files",
      });
      const facts = extractKnowledgeFacts(input.store, project.paths.rootDir, scan);
      emit({
        phase: KnowledgeIndexPhase.Chunk,
        label: "Chunking changed Knowledge sources",
        current: options.force ? scan.files.length : scan.changedFiles.length,
        total: scan.files.length,
        unit: "files",
      });
      const previousIndex = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
      const previousChunks = options.force || !previousIndex ? [] : listPreviousSemanticChunks(input.store);
      let mode: KnowledgeIndexRunResult["mode"];
      if (options.force || !previousIndex) {
        mode = "full";
        emit({ phase: KnowledgeIndexPhase.Embed, label: "Embedding Project Knowledge", current: 0, total: scan.files.length, unit: "files" });
        const request = buildProjectSemanticIndex({
          rootDir: project.paths.rootDir,
          scan,
          facts,
          project: input.store.project,
          semanticEmbedding: project.paths.semanticEmbedding,
          previousChunks,
        });
        emit({ phase: KnowledgeIndexPhase.Write, label: "Writing Project Knowledge index", current: request.chunks.length, total: request.index.chunkCount, unit: "chunks" });
        input.store.writeSemanticIndex(request);
      } else {
        mode = "delta";
        emit({ phase: KnowledgeIndexPhase.Embed, label: "Embedding changed Project Knowledge", current: 0, total: scan.changedFiles.length, unit: "files" });
        const request = buildProjectSemanticIndexDelta({
          rootDir: project.paths.rootDir,
          scan,
          facts,
          project: input.store.project,
          semanticEmbedding: project.paths.semanticEmbedding,
          previousIndex,
          previousChunks,
        });
        if (request.index.status === "failed") {
          const message = request.index.diagnostics.map((diagnostic) => diagnostic.message).join("\n") || "Project Knowledge indexing failed.";
          throw new Error(message);
        }
        emit({ phase: KnowledgeIndexPhase.Write, label: "Writing Project Knowledge delta", current: request.chunks?.length ?? 0, total: request.index.chunkCount, unit: "chunks" });
        input.store.writeSemanticIndexDelta(request);
      }
      const index = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
      if (!index) throw new Error("Project Knowledge index write completed without a readable index snapshot.");
      emit({ phase: KnowledgeIndexPhase.Prewarm, label: "Prewarming Project Knowledge query model" });
      semanticSearchVectorForProvider({
        query: "Project Knowledge",
        provider: index.provider,
        project: input.store.project,
        semanticEmbedding: project.paths.semanticEmbedding,
      });
      emit({ phase: KnowledgeIndexPhase.Ready, label: "Project Knowledge ready", current: index.chunkCount, total: index.chunkCount, unit: "chunks" });
      return { index, scan, mode };
    },
  };
}

function extractKnowledgeFacts(store: ProjectStore, rootDir: string, scan: ScanAndDiffResult) {
  const factFiles = scan.files
    .filter((file) => isEngineExtractableFile(file.path))
    .map((file) => {
      try {
        const content = readFileSync(path.join(rootDir, file.path), "utf8");
        return { path: file.path, contentHash: createHash("sha256").update(content).digest("hex"), language: engineSourceLanguage(file.path), content };
      } catch {
        return undefined;
      }
    })
    .filter((file): file is NonNullable<typeof file> => file !== undefined);
  const facts = store.project.extractFacts({
    files: factFiles,
    facts: allFactKinds,
    parserVersion: ENGINE_PARSER_VERSION,
  });
  const diagnostics = [
    ...facts.diagnostics,
    ...facts.files.flatMap((file) => file.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${file.path}: ${diagnostic.message}` }))),
  ] satisfies FactDiagnostic[];
  if (diagnostics.some((diagnostic) => diagnostic.severity === ErrorSeverity)) {
    throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return facts.files;
}
