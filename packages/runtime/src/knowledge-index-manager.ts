import {
  DefaultSemanticIndexId,
  DiagnosticSeverity,
  discoverProjectFiles,
  isEngineExtractableFile,
  loadProjectContext,
  type FactKind,
  type ScanAndDiffResult,
  type SemanticIndexDiagnostic,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { buildProjectSemanticIndex, buildProjectSemanticIndexDelta } from "./semantic-index.ts";
import { listPreviousSemanticChunks } from "./semantic-index-snapshot.ts";
import { applyChangeHint, extractRuntimeFacts, factFilesFromSnapshots, snapshotFiles } from "./project-source-snapshot.ts";
import { collectRuntimeKnowledgeChunks, type RuntimeKnowledgeChunk } from "./knowledge-producers.ts";
import type { ProjectStore } from "./state.ts";
import type { ServiceInferenceClient } from "./service-inference-client.ts";

export const KnowledgeIndexPhase = {
  Scan: "scan",
  Diff: "diff",
  Chunk: "chunk",
  Embed: "embed",
  Write: "write",
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
  changedPaths?: string[];
  onProgress?: (progress: KnowledgeIndexProgress) => void;
  signal?: AbortSignal;
};

export type KnowledgeIndexRunResult = {
  index: SemanticIndexSnapshot;
  scan: ScanAndDiffResult;
  mode: "full" | "delta";
};

export type KnowledgeIndexManager = {
  index(options?: KnowledgeIndexRunOptions): Promise<KnowledgeIndexRunResult>;
};

const SemanticIndexStatus = {
  Ready: "ready",
} as const;
export const KnowledgeSourceBatchSize = 64;
const KnowledgeFactKinds: FactKind[] = ["imports", "exports", "symbols", "declarations", "calls", "literals"];

export function createKnowledgeIndexManager(input: {
  rootDir: string;
  store: ProjectStore;
  inference: ServiceInferenceClient;
}): KnowledgeIndexManager {
  return {
    async index(options = {}) {
      const emit = options.onProgress ?? (() => undefined);
      emit({ phase: KnowledgeIndexPhase.Scan, label: "Scanning project files" });
      const project = await loadProjectContext(input.rootDir);
      const discovery = discoverProjectFiles(project.paths);
      if (discovery.failed) throw new Error(discovery.diagnostics.join("\n"));
      const scan = applyChangeHint(input.store.scanAndDiff(discovery.files), options.changedPaths);
      emit({
        phase: KnowledgeIndexPhase.Diff,
        label: "Diffing Project Knowledge inventory",
        current: scan.changedFiles.length + scan.deletedFiles.length,
        total: scan.files.length,
        unit: "files",
      });
      const previousIndex = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
      const canApplyDelta = !options.force && previousIndex?.status === SemanticIndexStatus.Ready;
      const previousChunks = canApplyDelta ? listPreviousSemanticChunks(input.store) : [];
      const sourcePaths = canApplyDelta ? scan.changedFiles : scan.files.map((file) => file.path);
      const collected = collectKnowledgeChunksInBatches({
        rootDir: project.paths.rootDir,
        store: input.store,
        scan,
        sourcePaths,
        emit,
      });
      let mode: KnowledgeIndexRunResult["mode"];
      if (options.force || !previousIndex || previousIndex.status !== SemanticIndexStatus.Ready) {
        mode = "full";
        const request = await buildProjectSemanticIndex({
          rootDir: project.paths.rootDir,
          scan,
          facts: [],
          runtimeChunks: collected.chunks,
          diagnostics: collected.diagnostics,
          onEmbeddingProgress(current, total) {
            emit({ phase: KnowledgeIndexPhase.Embed, label: "Embedding Project Knowledge", current, total, unit: "chunks" });
          },
          inference: input.inference,
          signal: options.signal,
          semanticEmbedding: project.paths.semanticEmbedding,
          previousChunks,
        });
        if (request.index.status === "failed") {
          const failure = request.index.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message;
          throw new Error(failure ?? "Project Knowledge full index build failed.");
        }
        emit({ phase: KnowledgeIndexPhase.Write, label: "Writing Project Knowledge index", current: request.chunks.length, total: request.index.chunkCount, unit: "chunks" });
        input.store.writeSemanticIndex(request);
      } else {
        mode = "delta";
        const request = await buildProjectSemanticIndexDelta({
          rootDir: project.paths.rootDir,
          scan,
          facts: [],
          runtimeChunks: collected.chunks,
          diagnostics: collected.diagnostics,
          onEmbeddingProgress(current, total) {
            emit({ phase: KnowledgeIndexPhase.Embed, label: "Embedding changed Project Knowledge", current, total, unit: "chunks" });
          },
          inference: input.inference,
          signal: options.signal,
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
      if (index.status !== SemanticIndexStatus.Ready) {
        throw new Error(
          `Project Knowledge index write completed with status ${index.status}; the published index is not ready. Run a full rebuild.`,
        );
      }
      emit({ phase: KnowledgeIndexPhase.Ready, label: "Project Knowledge ready", current: index.chunkCount, total: index.chunkCount, unit: "chunks" });
      return { index, scan, mode };
    },
  };
}

export function collectKnowledgeChunksInBatches(input: {
  rootDir: string;
  store: ProjectStore;
  scan: ScanAndDiffResult;
  sourcePaths: string[];
  emit(progress: KnowledgeIndexProgress): void;
}): { chunks: RuntimeKnowledgeChunk[]; diagnostics: SemanticIndexDiagnostic[] } {
  const eligiblePaths = input.sourcePaths.filter(isKnowledgeSourcePath).sort();
  const chunks: RuntimeKnowledgeChunk[] = [];
  const diagnostics: SemanticIndexDiagnostic[] = [];
  if (eligiblePaths.length === 0) {
    input.emit({ phase: KnowledgeIndexPhase.Chunk, label: "Chunking Project Knowledge sources", current: 0, total: 0, unit: "files" });
    return { chunks, diagnostics };
  }

  const filesByPath = new Map(input.scan.files.map((file) => [file.path, file]));
  for (let offset = 0; offset < eligiblePaths.length; offset += KnowledgeSourceBatchSize) {
    const batchPaths = eligiblePaths.slice(offset, offset + KnowledgeSourceBatchSize);
    const factSnapshots = snapshotFiles(input.rootDir, batchPaths.filter(isEngineExtractableFile));
    const extracted = extractRuntimeFacts({
      store: input.store,
      factFiles: factFilesFromSnapshots(factSnapshots),
      facts: KnowledgeFactKinds,
    });
    const batchFiles = batchPaths.map((file) => filesByPath.get(file)).filter((file): file is NonNullable<typeof file> => file !== undefined);
    chunks.push(...collectRuntimeKnowledgeChunks({
      rootDir: input.rootDir,
      scan: { ...input.scan, files: batchFiles },
      facts: extracted.files,
    }, diagnostics));
    input.emit({
      phase: KnowledgeIndexPhase.Chunk,
      label: "Chunking Project Knowledge sources",
      current: Math.min(offset + batchPaths.length, eligiblePaths.length),
      total: eligiblePaths.length,
      unit: "files",
    });
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === DiagnosticSeverity.Error) throw new Error(diagnostic.message);
  }
  return { chunks, diagnostics };
}

function isKnowledgeSourcePath(file: string): boolean {
  return isEngineExtractableFile(file) || /\.(md|markdown)$/iu.test(file);
}
