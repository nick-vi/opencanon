import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createSemanticChunkId,
  DefaultSemanticIndexId,
  DiagnosticSeverity,
  engineSourceLanguage,
  estimateSemanticTokens,
  isEngineExtractableFile,
  semanticChunkTreeHash,
  DefaultSemanticEmbeddingConfig,
  semanticEmbeddingModel,
  semanticEmbeddingConfigHash,
  semanticEmbeddingIdentityHash,
  semanticEmbeddingRecordHash,
  SemanticEmbeddingProviderKind,
  semanticEmbeddingModelIds,
  SemanticChunkerVersion,
  SemanticEmbeddingProducerVersion,
  SemanticIndexVersion,
  semanticPreview,
  semanticTextHash,
  type FileFacts,
  type ScanAndDiffResult,
  type SemanticChunkEmbedding,
  type SemanticChunkMetadata,
  type SemanticEmbeddingConfig,
  type SemanticEmbeddingModelId,
  type SemanticEmbeddingProvider,
  type SemanticIndexDiagnostic,
  type SemanticIndexSnapshot,
  type WriteSemanticIndexRequest,
} from "@opencanon/core";
import type { EngineProject } from "@opencanon/engine";

const MaxChunkChars = 2_400;
const MinChunkChars = 800;
const MaxEmbeddingBatchTexts = 128;
const MaxEmbeddingBatchChars = 256_000;
// Code embeddings provide file-level navigation; exact declarations live in the symbol graph.
const MaxCodeSymbolChunksPerFile = 0;
const MaxInternalSymbolChunksPerFile = 4;
const HeadingPattern = /^\s{0,3}#{1,6}\s+(.+)$/u;
const KnowledgeExcludePattern = /^\s*OpenCanon-Knowledge:\s*exclude\s*$/imu;
const HistoricalStatusPattern = /^\s*Status:\s*historical\b/imu;

export type ProjectSemanticIndexBuildInput = {
  rootDir: string;
  scan: ScanAndDiffResult;
  facts: FileFacts[];
  project?: EngineProject | undefined;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  previousChunks?: SemanticChunkMetadata[] | undefined;
};

export function buildProjectSemanticIndex(input: ProjectSemanticIndexBuildInput): WriteSemanticIndexRequest {
  const backend = createSemanticEmbeddingBackend(input.project, input.semanticEmbedding);
  const provider = backend.provider;
  const diagnostics: SemanticIndexDiagnostic[] = [];
  diagnostics.push(...backend.diagnostics);
  const runtimeChunks: RuntimeSemanticChunk[] = [];
  const factsByPath = new Map(input.facts.map((file) => [file.path, file]));
  for (const file of input.scan.files) {
    const fileFacts = factsByPath.get(file.path);
    if (!isSemanticIndexableFile(file.path, fileFacts)) continue;
    const absolutePath = path.join(input.rootDir, file.path);
    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch (error) {
      diagnostics.push({
        code: "semantic-read-failed",
        message: `Could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Warning,
        path: file.path,
      });
      continue;
    }
    if (isMarkdownFile(file.path) && markdownExcludedFromProjectContext(content)) {
      diagnostics.push({
        code: "semantic-markdown-excluded",
        message: `Skipped ${file.path}: markdown declares itself historical or excluded from Project Context.`,
        severity: DiagnosticSeverity.Info,
        path: file.path,
      });
      continue;
    }
    const fileChunks = semanticChunksForFile({
      path: file.path,
      content,
      contentHash: file.contentHash,
      facts: fileFacts,
    });
    if (fileChunks.length === 0 && isEngineExtractableFile(file.path)) {
      diagnostics.push({
        code: "semantic-no-structured-chunks",
        message: `No structured facts were available for ${file.path}; semantic indexing skipped whole-file fallback.`,
        severity: DiagnosticSeverity.Info,
        path: file.path,
      });
    }
    for (const chunk of fileChunks) {
      runtimeChunks.push(chunk);
    }
  }

  const chunksWithEmbeddingHash = uniquifySemanticChunkIds(runtimeChunks).map((chunk) => ({
    metadata: {
      ...chunk.metadata,
      embeddingHash: semanticEmbeddingRecordHash({
        chunkHash: chunk.metadata.chunkHash,
        providerId: provider.id,
        modelId: provider.modelId,
        modelDigest: provider.modelDigest,
        dimensions: provider.dimensions,
        configHash: provider.configHash,
        chunkerVersion: SemanticChunkerVersion,
        producerVersion: SemanticEmbeddingProducerVersion,
      }),
    },
    text: chunk.text,
  }));
  const previousEmbeddingHashes = new Map((input.previousChunks ?? []).map((chunk) => [chunk.id, chunk.embeddingHash]));
  const chunksNeedingEmbedding = chunksWithEmbeddingHash.filter((chunk) => previousEmbeddingHashes.get(chunk.metadata.id) !== chunk.metadata.embeddingHash);
  const reusedChunkCount = chunksWithEmbeddingHash.length - chunksNeedingEmbedding.length;
  const vectorsByChunkId = new Map<string, number[]>();
  let vectors: number[][] = [];
  if (chunksNeedingEmbedding.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      vectors = embedDocumentsInBatches(backend, chunksNeedingEmbedding.map((chunk) => chunk.text));
    } catch (error) {
      diagnostics.push({
        code: "semantic-embedding-failed",
        message: `Could not embed semantic chunks with ${provider.modelId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Error,
      });
    }
  }
  if (chunksNeedingEmbedding.length > 0 && vectors.length !== chunksNeedingEmbedding.length) {
    diagnostics.push({
      code: "semantic-vector-count-mismatch",
      message: `Semantic embedding provider returned ${vectors.length} vectors for ${chunksNeedingEmbedding.length} changed chunks.`,
      severity: DiagnosticSeverity.Error,
    });
    vectors = [];
  }
  for (const [index, chunk] of chunksNeedingEmbedding.entries()) {
    const vector = vectors[index];
    if (vector) vectorsByChunkId.set(chunk.metadata.id, vector);
  }

  const chunks: SemanticChunkEmbedding[] =
    hasSemanticIndexError(diagnostics)
      ? []
      : chunksWithEmbeddingHash.map((chunk) => {
        const canReuseVector = previousEmbeddingHashes.get(chunk.metadata.id) === chunk.metadata.embeddingHash;
        return {
          metadata: chunk.metadata,
          text: chunk.text,
          vector: canReuseVector ? [] : (vectorsByChunkId.get(chunk.metadata.id) ?? []),
        };
      });
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: provider.id,
    modelId: provider.modelId,
    modelDigest: provider.modelDigest,
    dimensions: provider.dimensions,
    configHash: provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion: SemanticEmbeddingProducerVersion,
  });
  const index: SemanticIndexSnapshot = {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: hasSemanticIndexError(diagnostics) ? "failed" : "ready",
    provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion: SemanticEmbeddingProducerVersion,
    sourceInventoryHash: input.scan.inventoryHash,
    chunkTreeHash: semanticChunkTreeHash(chunks),
    identityHash,
    chunkCount: chunks.length,
    vectorCount: chunks.length,
    staleChunkCount: 0,
    embeddingStats: {
      totalChunks: chunksWithEmbeddingHash.length,
      embeddedChunks: chunksNeedingEmbedding.length,
      reusedChunks: reusedChunkCount,
    },
    indexedAt: new Date().toISOString(),
    diagnostics,
  };
  return { index, chunks };
}

function embedDocumentsInBatches(backend: SemanticEmbeddingBackend, texts: string[]): number[][] {
  const vectors: number[][] = [];
  let batch: string[] = [];
  let batchChars = 0;
  for (const text of texts) {
    const textChars = text.length;
    const nextWouldExceedCount = batch.length >= MaxEmbeddingBatchTexts;
    const nextWouldExceedChars = batch.length > 0 && batchChars + textChars > MaxEmbeddingBatchChars;
    if (nextWouldExceedCount || nextWouldExceedChars) {
      vectors.push(...backend.embedDocuments(batch));
      batch = [];
      batchChars = 0;
    }
    batch.push(text);
    batchChars += textChars;
  }
  if (batch.length > 0) vectors.push(...backend.embedDocuments(batch));
  return vectors;
}

function uniquifySemanticChunkIds(chunks: RuntimeSemanticChunk[]): RuntimeSemanticChunk[] {
  const seenIds = new Set<string>();
  const duplicateCounts = new Map<string, number>();
  return chunks.map((chunk) => {
    if (!seenIds.has(chunk.metadata.id)) {
      seenIds.add(chunk.metadata.id);
      return chunk;
    }

    const duplicateIndex = (duplicateCounts.get(chunk.metadata.id) ?? 0) + 1;
    duplicateCounts.set(chunk.metadata.id, duplicateIndex);
    let nextId = createSemanticChunkId({
      path: chunk.metadata.path,
      key: `${chunk.metadata.id}:duplicate:${duplicateIndex}`,
      chunkHash: chunk.metadata.chunkHash,
      startByte: chunk.metadata.range.start.byte,
      endByte: chunk.metadata.range.end.byte,
    });
    let collisionIndex = duplicateIndex;
    while (seenIds.has(nextId)) {
      collisionIndex += 1;
      nextId = createSemanticChunkId({
        path: chunk.metadata.path,
        key: `${chunk.metadata.id}:duplicate:${collisionIndex}`,
        chunkHash: chunk.metadata.chunkHash,
        startByte: chunk.metadata.range.start.byte,
        endByte: chunk.metadata.range.end.byte,
      });
    }
    seenIds.add(nextId);
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        id: nextId,
      },
    };
  });
}

export function semanticSearchVectorForProvider(input: {
  query: string;
  provider?: SemanticEmbeddingProvider | null | undefined;
  project?: EngineProject | undefined;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
}): number[] {
  if (!input.provider) {
    throw new Error("Semantic search requires a ready Project Context index. Run opencanon project index.");
  }
  if (input.provider.kind === SemanticEmbeddingProviderKind.Native) {
    if (!input.project) {
      throw new Error(`Semantic search index uses ${input.provider.modelId}, but no native engine project is available.`);
    }
    return nativeEmbeddingBackend(input.project, nativeSemanticEmbeddingConfig(input.provider, input.semanticEmbedding)).embedQuery(input.query);
  }
  throw new Error(`Unsupported semantic search provider ${input.provider.kind}.`);
}

export type SemanticEmbeddingBackend = {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
  embedDocuments(texts: string[]): number[][];
  embedQuery(text: string): number[];
};

export function configuredSemanticEmbeddingProvider(inputConfig?: SemanticEmbeddingConfig | undefined): {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
} {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    return { provider: nativeEmbeddingProvider(DefaultSemanticEmbeddingConfig), diagnostics: selection.diagnostics };
  }
  return { provider: nativeEmbeddingProvider(selection.config), diagnostics: selection.diagnostics };
}

export function createSemanticEmbeddingBackend(project?: EngineProject | undefined, inputConfig?: SemanticEmbeddingConfig | undefined): SemanticEmbeddingBackend {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    const provider = configuredSemanticEmbeddingProvider(inputConfig).provider;
    return unavailableEmbeddingBackend(provider, selection.diagnostics);
  }
  const modelId = selection.config.modelId;
  const model = semanticEmbeddingModel(modelId);
  if (model.providerKind === SemanticEmbeddingProviderKind.Native && project) {
    const backend = nativeEmbeddingBackend(project, selection.config);
    return { ...backend, diagnostics: selection.diagnostics };
  }
  return unavailableEmbeddingBackend(nativeEmbeddingProvider(selection.config), [
    ...selection.diagnostics,
    {
      code: "semantic-native-provider-unavailable",
      message: `Semantic embedding model ${modelId} requires a native engine project.`,
      severity: DiagnosticSeverity.Error,
    },
  ]);
}

function nativeEmbeddingBackend(project: EngineProject, config: SemanticEmbeddingConfig): SemanticEmbeddingBackend {
  const provider = nativeEmbeddingProvider(config);
  const requestOptions = nativeEmbeddingOptions(config);
  return {
    provider,
    diagnostics: [],
    embedDocuments(texts) {
      const result = project.embedSemanticTexts({
        modelId: config.modelId,
        task: "document",
        texts,
        ...requestOptions,
      });
      assertEmbeddingResult(provider, result.vectors);
      return result.vectors;
    },
    embedQuery(text) {
      const result = project.embedSemanticTexts({
        modelId: config.modelId,
        task: "query",
        texts: [text],
        ...requestOptions,
      });
      assertEmbeddingResult(provider, result.vectors);
      return result.vectors[0] ?? [];
    },
  };
}

function nativeEmbeddingProvider(config: SemanticEmbeddingConfig): SemanticEmbeddingProvider {
  const model = semanticEmbeddingModel(config.modelId);
  const options = nativeEmbeddingOptions(config);
  const modelDigest = semanticEmbeddingConfigHash(model.config);
  const configHash = semanticEmbeddingConfigHash({
    ...model.config,
    nCtx: options.nCtx ?? model.contextLength,
  });
  return {
    id: `opencanon-native-${model.id}`,
    kind: model.providerKind,
    displayName: model.displayName,
    modelId: model.id,
    modelDigest,
    dimensions: model.dimensions,
    distance: model.distance,
    configHash,
  };
}

function unavailableEmbeddingBackend(provider: SemanticEmbeddingProvider, diagnostics: SemanticIndexDiagnostic[]): SemanticEmbeddingBackend {
  const message = diagnostics.map((diagnostic) => diagnostic.message).join(" ");
  return {
    provider,
    diagnostics,
    embedDocuments() {
      throw new Error(message);
    },
    embedQuery() {
      throw new Error(message);
    },
  };
}

function resolveSemanticEmbeddingConfig(input?: SemanticEmbeddingConfig | undefined): (
  | { ok: true; config: SemanticEmbeddingConfig; diagnostics: SemanticIndexDiagnostic[] }
  | { ok: false; diagnostics: SemanticIndexDiagnostic[] }
) {
  const config = input ?? DefaultSemanticEmbeddingConfig;
  const ids = semanticEmbeddingModelIds();
  if (!ids.includes(config.modelId as SemanticEmbeddingModelId)) {
    return {
      ok: false,
      diagnostics: [{
        code: "semantic-embedding-config-invalid",
        message: `Unknown semantic embedding model ${String(config.modelId)}. Set semanticEmbedding.modelId to one of: ${ids.join(", ")}.`,
        severity: DiagnosticSeverity.Error,
      }],
    };
  }
  const model = semanticEmbeddingModel(config.modelId);
  if (config.mode !== model.providerKind) {
    return {
      ok: false,
      diagnostics: [{
        code: "semantic-embedding-config-invalid",
        message: `Semantic embedding mode ${config.mode} does not match model ${config.modelId}.`,
        severity: DiagnosticSeverity.Error,
      }],
    };
  }
  return { ok: true, config, diagnostics: [] };
}

function nativeSemanticEmbeddingConfig(provider: SemanticEmbeddingProvider, input?: SemanticEmbeddingConfig | undefined): SemanticEmbeddingConfig {
  const config = input ?? DefaultSemanticEmbeddingConfig;
  const ids = semanticEmbeddingModelIds();
  if (config.mode !== SemanticEmbeddingProviderKind.Native) {
    throw new Error(`Semantic search index uses native model ${provider.modelId}, but project semanticEmbedding is not native.`);
  }
  if (!ids.includes(config.modelId)) {
    throw new Error(`Unknown semantic embedding model ${config.modelId}.`);
  }
  if (config.modelId !== provider.modelId) {
    throw new Error(`Semantic search index uses ${provider.modelId}, but project config requires ${config.modelId}. Run opencanon project index.`);
  }
  return config;
}

function nativeEmbeddingOptions(config: SemanticEmbeddingConfig): {
  nGpuLayers?: number | undefined;
  nThreads?: number | undefined;
  nCtx?: number | undefined;
  showDownloadProgress: boolean;
} {
  return {
    nGpuLayers: config.nGpuLayers,
    nThreads: config.nThreads,
    nCtx: config.nCtx,
    showDownloadProgress: config.showDownloadProgress,
  };
}

function assertEmbeddingResult(provider: SemanticEmbeddingProvider, vectors: number[][]): void {
  for (const vector of vectors) {
    if (vector.length !== provider.dimensions) {
      throw new Error(`Expected ${provider.dimensions} dimensions from ${provider.modelId}, got ${vector.length}.`);
    }
  }
}

function hasSemanticIndexError(diagnostics: SemanticIndexDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
}

type RuntimeSemanticChunk = {
  text: string;
  metadata: Omit<SemanticChunkEmbedding["metadata"], "embeddingHash">;
};

function isSemanticIndexableFile(filePath: string, facts: FileFacts | undefined): boolean {
  if (isMarkdownFile(filePath)) return true;
  return isEngineExtractableFile(filePath) && facts !== undefined;
}

function semanticChunksForFile(input: { path: string; content: string; contentHash: string; facts?: FileFacts | undefined }): RuntimeSemanticChunk[] {
  if (input.facts) return factChunksForFile(input as { path: string; content: string; contentHash: string; facts: FileFacts });
  if (isMarkdownFile(input.path)) return markdownChunksForFile(input);
  return [];
}

function factChunksForFile(input: { path: string; content: string; contentHash: string; facts: FileFacts }): RuntimeSemanticChunk[] {
  const chunks: RuntimeSemanticChunk[] = [];
  const ranges = contentLineRanges(input.content);
  const imports = input.facts.imports.map((item) => item.source).slice(0, 16);
  const summary = factSummaryText(input);
  if (summary) {
    chunks.push(
      createRuntimeSemanticChunk({
        path: input.path,
        contentHash: input.contentHash,
        content: input.content,
        ranges,
        key: "facts:summary",
        kind: "text",
        ordinal: 0,
        startLine: 1,
        endLine: Math.max(1, ranges.lines.length),
        text: summary,
      }),
    );
  }
  const candidates = semanticCodeSymbolCandidates(input, ranges, imports);
  const exported = candidates.filter((candidate) => candidate.exported).slice(0, MaxCodeSymbolChunksPerFile);
  const fallbackSymbols = summary || exported.length > 0
    ? []
    : candidates.slice(0, MaxInternalSymbolChunksPerFile);
  for (const candidate of [...exported, ...fallbackSymbols].sort((left, right) => left.startLine - right.startLine)) {
    chunks.push(
      createRuntimeSemanticChunk({
        path: input.path,
        contentHash: input.contentHash,
        content: input.content,
        ranges,
        key: candidate.key,
        kind: "symbol",
        ordinal: chunks.length,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        symbol: candidate.name,
        text: candidate.text,
      }),
    );
  }

  return chunks;
}

type SemanticCodeSymbolCandidate = {
  key: string;
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  text: string;
};

function semanticCodeSymbolCandidates(
  input: { path: string; content: string; facts: FileFacts },
  ranges: ContentLineRanges,
  imports: string[],
): SemanticCodeSymbolCandidate[] {
  const candidates: SemanticCodeSymbolCandidate[] = [];
  const emittedKeys = new Set<string>();

  for (const declaration of input.facts.declarations) {
    const startLine = clampLine(declaration.line, ranges);
    const endLine = clampLine(Math.max(declaration.endLine, declaration.line), ranges);
    const sourceText = linesForRange(input.content, ranges, startLine, endLine).trim() || declaration.text.trim();
    emittedKeys.add(`${declaration.name}:${declaration.line}:${declaration.endLine}`);
    candidates.push({
      key: `declaration:${declaration.kind}:${declaration.name}:${declaration.line}`,
      name: declaration.name,
      exported: declaration.exported === true,
      startLine,
      endLine,
      text: semanticCodeText({
        path: input.path,
        language: input.facts.language,
        kind: declaration.kind,
        name: declaration.name,
        exported: declaration.exported === true,
        params: [],
        imports,
        sourceText,
      }),
    });
  }

  for (const symbol of input.facts.symbols) {
    const endLine = clampLine(Math.max(symbol.endLine ?? symbol.line, symbol.line), ranges);
    const symbolKey = `${symbol.name}:${symbol.line}:${endLine}`;
    if (emittedKeys.has(symbolKey)) continue;
    const startLine = clampLine(symbol.line, ranges);
    const sourceText = linesForRange(input.content, ranges, startLine, endLine).trim();
    if (!sourceText) continue;
    candidates.push({
      key: `symbol:${symbol.kind}:${symbol.name}:${symbol.line}`,
      name: symbol.name,
      exported: symbol.exported === true,
      startLine,
      endLine,
      text: semanticCodeText({
        path: input.path,
        language: input.facts.language,
        kind: symbol.kind,
        name: symbol.name,
        exported: symbol.exported === true,
        params: symbol.params ?? [],
        imports,
        sourceText,
      }),
    });
  }

  return candidates.sort((left, right) => Number(right.exported) - Number(left.exported) || left.startLine - right.startLine);
}

function markdownChunksForFile(input: { path: string; content: string; contentHash: string }): RuntimeSemanticChunk[] {
  const lines = input.content.split(/\r?\n/u);
  const newlineBytes = input.content.includes("\r\n") ? 2 : 1;
  const chunks: RuntimeSemanticChunk[] = [];
  let startLine = 1;
  let startByte = 0;
  let currentLines: string[] = [];
  let currentChars = 0;
  let currentHeading: string | undefined;
  let byteCursor = 0;

  const flush = (endLine: number, endByte: number): void => {
    const text = currentLines.join("\n").trim();
    if (!text) {
      currentLines = [];
      currentChars = 0;
      currentHeading = undefined;
      startLine = endLine + 1;
      startByte = endByte;
      return;
    }
    const chunkHash = semanticTextHash(text);
    const ordinal = chunks.length;
    const startColumn = 1;
    const endColumn = Math.max(1, currentLines[currentLines.length - 1]?.length ?? 1);
    const metadata: Omit<SemanticChunkEmbedding["metadata"], "embeddingHash"> = {
      id: createSemanticChunkId({ path: input.path, key: currentHeading ? `section:${currentHeading}` : `section:${ordinal}`, chunkHash, startByte, endByte }),
      path: input.path,
      contentHash: input.contentHash,
      chunkHash,
      kind: "section",
      language: "markdown",
      ordinal,
      range: {
        start: { line: startLine, column: startColumn, byte: startByte },
        end: { line: endLine, column: endColumn, byte: endByte },
      },
      tokenEstimate: estimateSemanticTokens(text),
      preview: semanticPreview(text),
      ...(currentHeading ? { heading: currentHeading } : {}),
    };
    chunks.push({ text, metadata });
    currentLines = [];
    currentChars = 0;
    currentHeading = undefined;
    startLine = endLine + 1;
    startByte = endByte;
  };

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (currentLines.length === 0) {
      startLine = lineNo;
      startByte = byteCursor;
    }
    const heading = line.match(HeadingPattern)?.[1]?.trim();
    if (heading && currentLines.length > 0 && currentChars >= MinChunkChars) {
      flush(lineNo - 1, byteCursor);
      startLine = lineNo;
      startByte = byteCursor;
    }
    if (heading && !currentHeading) currentHeading = heading;
    currentLines.push(line);
    currentChars += line.length + 1;
    byteCursor += Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? newlineBytes : 0);
    if (currentChars >= MaxChunkChars) flush(lineNo, byteCursor);
  }
  if (currentLines.length > 0) flush(lines.length, byteCursor);
  return chunks;
}

function createRuntimeSemanticChunk(input: {
  path: string;
  contentHash: string;
  content: string;
  ranges: ContentLineRanges;
  key: string;
  kind: SemanticChunkEmbedding["metadata"]["kind"];
  ordinal: number;
  startLine: number;
  endLine: number;
  text: string;
  symbol?: string | undefined;
}): RuntimeSemanticChunk {
  const text = input.text.trim();
  const start = lineStart(input.ranges, input.startLine);
  const end = lineEnd(input.ranges, input.endLine);
  const chunkHash = semanticTextHash(text);
  return {
    text,
    metadata: {
      id: createSemanticChunkId({
        path: input.path,
        key: input.key,
        chunkHash,
        startByte: start.byte,
        endByte: end.byte,
      }),
      path: input.path,
      contentHash: input.contentHash,
      chunkHash,
      kind: input.kind,
      language: semanticLanguage(input.path),
      ordinal: input.ordinal,
      range: { start, end },
      tokenEstimate: estimateSemanticTokens(text),
      preview: semanticPreview(text),
      ...(input.symbol ? { symbol: input.symbol } : {}),
    },
  };
}

function semanticCodeText(input: {
  path: string;
  language: string;
  kind: string;
  name: string;
  exported: boolean;
  params: string[];
  imports: string[];
  sourceText: string;
}): string {
  return [
    `Path: ${input.path}`,
    `Language: ${input.language}`,
    `${input.exported ? "Exported" : "Internal"} ${input.kind}: ${input.name}`,
    input.params.length > 0 ? `Parameters: ${input.params.join(", ")}` : "",
    input.imports.length > 0 ? `Imports: ${input.imports.join(", ")}` : "",
    input.sourceText,
  ]
    .filter(Boolean)
    .join("\n");
}

function factSummaryText(input: { path: string; facts: FileFacts }): string {
  const imports = input.facts.imports.map((item) => item.source);
  const exports = input.facts.exports.map((item) => `${item.kind} ${item.name}`);
  const calls = input.facts.calls.map((item) => item.callee);
  const literals = input.facts.literals.map((item) => String(item.value)).filter((item) => item.length > 0);
  if (imports.length === 0 && exports.length === 0 && calls.length === 0 && literals.length === 0) return "";
  return [
    `Path: ${input.path}`,
    `Language: ${input.facts.language}`,
    imports.length > 0 ? `Imports: ${unique(imports).slice(0, 24).join(", ")}` : "",
    exports.length > 0 ? `Exports: ${unique(exports).slice(0, 24).join(", ")}` : "",
    calls.length > 0 ? `Calls: ${unique(calls).slice(0, 32).join(", ")}` : "",
    literals.length > 0 ? `Literals: ${unique(literals).slice(0, 32).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type ContentLineRanges = {
  lines: string[];
  starts: number[];
  ends: number[];
};

function contentLineRanges(content: string): ContentLineRanges {
  const lines = content.split(/\r?\n/u);
  const newlineBytes = content.includes("\r\n") ? 2 : 1;
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const [index, line] of lines.entries()) {
    starts.push(cursor);
    cursor += Buffer.byteLength(line, "utf8");
    ends.push(cursor);
    if (index < lines.length - 1) cursor += newlineBytes;
  }
  return { lines, starts, ends };
}

function linesForRange(content: string, ranges: ContentLineRanges, startLine: number, endLine: number): string {
  const start = lineStart(ranges, startLine).byte;
  const end = lineEnd(ranges, endLine).byte;
  return content.slice(start, end);
}

function lineStart(ranges: ContentLineRanges, line: number): SemanticChunkEmbedding["metadata"]["range"]["start"] {
  const index = clampLine(line, ranges) - 1;
  return { line: index + 1, column: 1, byte: ranges.starts[index] ?? 0 };
}

function lineEnd(ranges: ContentLineRanges, line: number): SemanticChunkEmbedding["metadata"]["range"]["end"] {
  const index = clampLine(line, ranges) - 1;
  return { line: index + 1, column: Math.max(1, (ranges.lines[index] ?? "").length + 1), byte: ranges.ends[index] ?? 0 };
}

function clampLine(line: number, ranges: ContentLineRanges): number {
  return Math.min(Math.max(1, line), Math.max(1, ranges.lines.length));
}

function semanticLanguage(file: string): string {
  if (isMarkdownFile(file)) return "markdown";
  if (/\.json$/iu.test(file)) return "json";
  if (isEngineExtractableFile(file)) return engineSourceLanguage(file);
  return "text";
}

function isMarkdownFile(file: string): boolean {
  return /\.(md|markdown)$/iu.test(file);
}

function markdownExcludedFromProjectContext(content: string): boolean {
  const header = content.split(/\r?\n/u).slice(0, 12).join("\n");
  return KnowledgeExcludePattern.test(header) || HistoricalStatusPattern.test(header);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
