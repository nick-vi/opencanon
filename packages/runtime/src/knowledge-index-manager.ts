import {
  DefaultSemanticIndexId,
  loadProjectContext,
  type ScanAndDiffResult,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { buildProjectSemanticIndex, buildProjectSemanticIndexDelta, semanticSearchVectorForProvider } from "./semantic-index.ts";
import { listPreviousSemanticChunks } from "./semantic-index-snapshot.ts";
import { captureRuntimeSourceSnapshot } from "./project-source-snapshot.ts";
import type { ProjectStore } from "./state.ts";

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
  changedPaths?: string[];
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
      const sourceSnapshot = captureRuntimeSourceSnapshot({ rootDir: project.paths.rootDir, paths: project.paths, store: input.store, changedPaths: options.changedPaths });
      const { scan, facts } = sourceSnapshot;
      emit({
        phase: KnowledgeIndexPhase.Diff,
        label: "Diffing Project Knowledge inventory",
        current: scan.changedFiles.length + scan.deletedFiles.length,
        total: scan.files.length,
        unit: "files",
      });
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
