import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createSemanticChunkId,
  DiagnosticSeverity,
  engineSourceLanguage,
  estimateSemanticTokens,
  isEngineExtractableFile,
  semanticPreview,
  semanticTextHash,
  type FileFacts,
  type ScanAndDiffResult,
  type SemanticChunkEmbedding,
  type SemanticIndexDiagnostic,
} from "@opencanon/core";

const MaxChunkChars = 2_400;
const MinChunkChars = 800;
// Code embeddings provide file-level navigation; exact declarations live in the symbol graph.
const MaxCodeSymbolChunksPerFile = 0;
const MaxInternalSymbolChunksPerFile = 4;
const HeadingPattern = /^\s{0,3}#{1,6}\s+(.+)$/u;
const KnowledgeExcludePattern = /^\s*OpenCanon-Knowledge:\s*exclude\s*$/imu;
const HistoricalStatusPattern = /^\s*Status:\s*historical\b/imu;

export const KnowledgeProducerVersion = "opencanon-knowledge-producers-v1";

export type KnowledgeSourceFile = {
  path: string;
  contentHash: string;
};

export type RuntimeKnowledgeChunk = {
  text: string;
  metadata: Omit<SemanticChunkEmbedding["metadata"], "embeddingHash">;
};

export type KnowledgeProducerContext = {
  rootDir: string;
  factsByPath: Map<string, FileFacts>;
  diagnostics: SemanticIndexDiagnostic[];
};

export type KnowledgeProducer = {
  language: string;
  producerVersion: string;
  supports(path: string, facts?: FileFacts | undefined): boolean;
  chunk(file: KnowledgeSourceFile, context: KnowledgeProducerContext): RuntimeKnowledgeChunk[];
};

export const markdownKnowledgeProducer: KnowledgeProducer = {
  language: "markdown",
  producerVersion: KnowledgeProducerVersion,
  supports(filePath) {
    return isMarkdownFile(filePath);
  },
  chunk(file, context) {
    const content = readKnowledgeSource(file, context);
    if (content === undefined) return [];
    if (markdownExcludedFromProjectKnowledge(content)) {
      context.diagnostics.push({
        code: "semantic-markdown-excluded",
        message: `Skipped ${file.path}: markdown declares itself historical or excluded from Project Knowledge.`,
        severity: DiagnosticSeverity.Info,
        path: file.path,
      });
      return [];
    }
    return markdownChunksForFile({ ...file, content });
  },
};

export const typeScriptKnowledgeProducer: KnowledgeProducer = {
  language: "typescript",
  producerVersion: KnowledgeProducerVersion,
  supports(filePath, facts) {
    return isEngineExtractableFile(filePath) && facts !== undefined;
  },
  chunk(file, context) {
    const facts = context.factsByPath.get(file.path);
    if (!facts) return [];
    const content = readKnowledgeSource(file, context);
    if (content === undefined) return [];
    return factChunksForFile({ ...file, content, facts });
  },
};

const knowledgeProducers = [markdownKnowledgeProducer, typeScriptKnowledgeProducer] as const;

export function collectRuntimeKnowledgeChunks(
  input: Pick<CollectKnowledgeChunkInput, "rootDir" | "scan" | "facts"> & { onlyPaths?: Set<string> | undefined },
  diagnostics: SemanticIndexDiagnostic[],
): RuntimeKnowledgeChunk[] {
  const runtimeChunks: RuntimeKnowledgeChunk[] = [];
  const factsByPath = new Map(input.facts.map((file) => [file.path, file]));
  const context: KnowledgeProducerContext = {
    rootDir: input.rootDir,
    factsByPath,
    diagnostics,
  };

  for (const file of input.scan.files) {
    if (input.onlyPaths && !input.onlyPaths.has(file.path)) continue;
    const facts = factsByPath.get(file.path);
    const producer = knowledgeProducers.find((candidate) => candidate.supports(file.path, facts));
    if (!producer) {
      if (isEngineExtractableFile(file.path)) {
        diagnostics.push({
          code: "semantic-no-structured-chunks",
          message: `No structured facts were available for ${file.path}; Project Knowledge skipped unstructured whole-file chunking.`,
          severity: DiagnosticSeverity.Info,
          path: file.path,
        });
      }
      continue;
    }
    runtimeChunks.push(...producer.chunk(file, context));
  }

  return runtimeChunks;
}

export function knowledgeProducerIdentity(): string {
  return knowledgeProducers.map((producer) => `${producer.language}:${producer.producerVersion}`).sort().join("|");
}

type CollectKnowledgeChunkInput = {
  rootDir: string;
  scan: ScanAndDiffResult;
  facts: FileFacts[];
};

function readKnowledgeSource(file: KnowledgeSourceFile, context: KnowledgeProducerContext): string | undefined {
  try {
    return readFileSync(path.join(context.rootDir, file.path), "utf8");
  } catch (error) {
    context.diagnostics.push({
      code: "semantic-read-failed",
      message: `Could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      severity: DiagnosticSeverity.Warning,
      path: file.path,
    });
    return undefined;
  }
}

function factChunksForFile(input: { path: string; content: string; contentHash: string; facts: FileFacts }): RuntimeKnowledgeChunk[] {
  const chunks: RuntimeKnowledgeChunk[] = [];
  const ranges = contentLineRanges(input.content);
  const imports = input.facts.imports.map((item) => item.source).slice(0, 16);
  const summary = factSummaryText(input);
  if (summary) {
    chunks.push(
      createRuntimeKnowledgeChunk({
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
      createRuntimeKnowledgeChunk({
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

function markdownChunksForFile(input: { path: string; content: string; contentHash: string }): RuntimeKnowledgeChunk[] {
  const lines = input.content.split(/\r?\n/u);
  const newlineBytes = input.content.includes("\r\n") ? 2 : 1;
  const chunks: RuntimeKnowledgeChunk[] = [];
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
    chunks.push({
      text,
      metadata: {
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
      },
    });
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

function createRuntimeKnowledgeChunk(input: {
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
}): RuntimeKnowledgeChunk {
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

function markdownExcludedFromProjectKnowledge(content: string): boolean {
  const header = content.split(/\r?\n/u).slice(0, 12).join("\n");
  return KnowledgeExcludePattern.test(header) || HistoricalStatusPattern.test(header);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
