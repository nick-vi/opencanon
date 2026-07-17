import { z } from "zod";
import { DiagnosticSeverity, diagnosticSeverityValues } from "./contracts-facts.ts";
import { SymbolRangeSchema } from "./contracts-code-graph.ts";

export const semanticIndexStatusValues = ["missing", "indexing", "ready", "stale", "failed"] as const;
export const SemanticIndexStatusValueSchema = z.enum(semanticIndexStatusValues);
export type SemanticIndexStatusValue = z.infer<typeof SemanticIndexStatusValueSchema>;

export const semanticChunkKindValues = ["file", "section", "symbol", "text"] as const;
export const SemanticChunkKindSchema = z.enum(semanticChunkKindValues);
export type SemanticChunkKind = z.infer<typeof SemanticChunkKindSchema>;

export const semanticDistanceValues = ["cosine"] as const;
export const SemanticDistanceSchema = z.enum(semanticDistanceValues);
export type SemanticDistance = z.infer<typeof SemanticDistanceSchema>;

export const SemanticEmbeddingProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("gguf").default("gguf"),
  displayName: z.string().min(1).optional(),
  modelId: z.string().min(1),
  modelDigest: z.string().min(1).optional(),
  dimensions: z.number().int().min(1),
  distance: SemanticDistanceSchema.default("cosine"),
  configHash: z.string().min(1),
});
export type SemanticEmbeddingProvider = z.infer<typeof SemanticEmbeddingProviderSchema>;

export const SemanticIndexDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues).default(DiagnosticSeverity.Warning),
  path: z.string().min(1).optional(),
});
export type SemanticIndexDiagnostic = z.infer<typeof SemanticIndexDiagnosticSchema>;

export const SemanticIndexSnapshotSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  status: SemanticIndexStatusValueSchema,
  provider: SemanticEmbeddingProviderSchema,
  chunkerVersion: z.string().min(1),
  producerVersion: z.string().min(1),
  sourceInventoryHash: z.string().min(1),
  chunkTreeHash: z.string().min(1),
  identityHash: z.string().min(1),
  chunkCount: z.number().int().min(0),
  vectorCount: z.number().int().min(0),
  staleChunkCount: z.number().int().min(0),
  embeddingStats: z.object({
    totalChunks: z.number().int().min(0),
    embeddedChunks: z.number().int().min(0),
    reusedChunks: z.number().int().min(0),
    filesScanned: z.number().int().min(0).optional(),
    filesChanged: z.number().int().min(0).optional(),
    filesDeleted: z.number().int().min(0).optional(),
    chunksAdded: z.number().int().min(0).optional(),
    chunksChanged: z.number().int().min(0).optional(),
    chunksRemoved: z.number().int().min(0).optional(),
    vectorsWritten: z.number().int().min(0).optional(),
    vectorsReused: z.number().int().min(0).optional(),
  }).optional(),
  indexedAt: z.string().datetime(),
  diagnostics: z.array(SemanticIndexDiagnosticSchema).default([]),
});
export type SemanticIndexSnapshot = z.infer<typeof SemanticIndexSnapshotSchema>;

export const semanticIndexNodeKindValues = ["root", "dir", "file", "chunk"] as const;
export const SemanticIndexNodeKindSchema = z.enum(semanticIndexNodeKindValues);
export type SemanticIndexNodeKind = z.infer<typeof SemanticIndexNodeKindSchema>;

export const SemanticIndexNodeSchema = z.object({
  key: z.string().min(1),
  kind: SemanticIndexNodeKindSchema,
  hash: z.string().min(1),
  parentKey: z.string().min(1).nullable(),
  children: z.array(z.string().min(1)).default([]),
});
export type SemanticIndexNode = z.infer<typeof SemanticIndexNodeSchema>;

export const SemanticChunkMetadataSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  contentHash: z.string().min(1),
  chunkHash: z.string().min(1),
  embeddingHash: z.string().min(1),
  kind: SemanticChunkKindSchema,
  language: z.string().min(1),
  ordinal: z.number().int().min(0),
  range: SymbolRangeSchema,
  heading: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  tokenCount: z.number().int().min(1),
  preview: z.string(),
});
export type SemanticChunkMetadata = z.infer<typeof SemanticChunkMetadataSchema>;

export const SemanticChunkEmbeddingSchema = z.object({
  metadata: SemanticChunkMetadataSchema,
  text: z.string(),
  vector: z.array(z.number()),
});
export type SemanticChunkEmbedding = z.infer<typeof SemanticChunkEmbeddingSchema>;

export const WriteSemanticIndexRequestSchema = z.object({
  index: SemanticIndexSnapshotSchema,
  chunks: z.array(SemanticChunkEmbeddingSchema),
  nodes: z.array(SemanticIndexNodeSchema).optional(),
});
export type WriteSemanticIndexRequest = z.infer<typeof WriteSemanticIndexRequestSchema>;

export const WriteSemanticIndexDeltaRequestSchema = z.object({
  index: SemanticIndexSnapshotSchema,
  chunks: z.array(SemanticChunkEmbeddingSchema).optional(),
  removedPaths: z.array(z.string().min(1)).optional(),
  removedNodeKeys: z.array(z.string().min(1)).optional(),
  nodes: z.array(SemanticIndexNodeSchema).optional(),
});
export type WriteSemanticIndexDeltaRequest = z.infer<typeof WriteSemanticIndexDeltaRequestSchema>;

export const ReadSemanticIndexStatusRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
});
export type ReadSemanticIndexStatusRequest = z.input<typeof ReadSemanticIndexStatusRequestSchema>;

export const ReadSemanticIndexStatusResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
});
export type ReadSemanticIndexStatusResult = z.infer<typeof ReadSemanticIndexStatusResultSchema>;

export const SearchSemanticIndexRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
  query: z.string().min(1).optional(),
  vector: z.array(z.number()).min(1).optional(),
  paths: z.array(z.string().min(1)).default([]),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchSemanticIndexRequest = z.input<typeof SearchSemanticIndexRequestSchema>;

export const SemanticSearchResultSchema = z.object({
  chunk: SemanticChunkMetadataSchema,
  score: z.number(),
  scores: z.object({
    vector: z.number().optional(),
    lexical: z.number().optional(),
    combined: z.number(),
  }).optional(),
});
export type SemanticSearchResult = z.infer<typeof SemanticSearchResultSchema>;

export const SearchSemanticIndexResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  results: z.array(SemanticSearchResultSchema),
});
export type SearchSemanticIndexResult = z.infer<typeof SearchSemanticIndexResultSchema>;

export const ListSemanticChunksRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
  paths: z.array(z.string().min(1)).default([]),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListSemanticChunksRequest = z.input<typeof ListSemanticChunksRequestSchema>;

export const ListSemanticChunksResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  chunks: z.array(SemanticChunkMetadataSchema),
});
export type ListSemanticChunksResult = z.infer<typeof ListSemanticChunksResultSchema>;

export const ProjectContextLinkSchema = z.object({
  kind: z.enum(["area", "spec", "change", "convention", "impact-surface", "task", "check", "finding", "file", "symbol", "doc"]),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});
export type ProjectContextLink = z.infer<typeof ProjectContextLinkSchema>;

export const ProjectContextEvidenceSchema = z.object({
  chunk: SemanticChunkMetadataSchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  preview: z.string(),
  score: z.number().optional(),
  scores: SemanticSearchResultSchema.shape.scores.optional(),
  definitions: z.array(ProjectContextLinkSchema).default([]),
  surfaces: z.array(ProjectContextLinkSchema).default([]),
  checks: z.array(ProjectContextLinkSchema).default([]),
  findings: z.array(ProjectContextLinkSchema).default([]),
});
export type ProjectContextEvidence = z.infer<typeof ProjectContextEvidenceSchema>;

export const ProjectContextSearchResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  query: z.string().min(1),
  results: z.array(ProjectContextEvidenceSchema),
});
export type ProjectContextSearchResult = z.infer<typeof ProjectContextSearchResultSchema>;

export const ProjectContextAskResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  question: z.string().min(1),
  answer: z.string(),
  deterministic: z.literal(true),
  evidence: z.array(ProjectContextEvidenceSchema),
  suggestions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ProjectContextAskResult = z.infer<typeof ProjectContextAskResultSchema>;

export const ProjectContextCoverageFileSchema = z.object({
  file: z.string().min(1),
  areas: z.array(ProjectContextLinkSchema).default([]),
  specs: z.array(ProjectContextLinkSchema).default([]),
  changes: z.array(ProjectContextLinkSchema).default([]),
  conventions: z.array(ProjectContextLinkSchema).default([]),
  surfaces: z.array(ProjectContextLinkSchema).default([]),
  indexedChunks: z.number().int().min(0),
});
export type ProjectContextCoverageFile = z.infer<typeof ProjectContextCoverageFileSchema>;

export const ProjectContextCoverageResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  totals: z.object({
    files: z.number().int().min(0),
    indexedFiles: z.number().int().min(0),
    governedFiles: z.number().int().min(0),
    ungovernedFiles: z.number().int().min(0),
    chunks: z.number().int().min(0),
    staleChunks: z.number().int().min(0),
  }),
  files: z.array(ProjectContextCoverageFileSchema),
  gaps: z.array(z.object({
    kind: z.enum(["ungoverned-file", "unindexed-file", "stale-index"]),
    file: z.string().min(1).optional(),
    message: z.string().min(1),
  })),
});
export type ProjectContextCoverageResult = z.infer<typeof ProjectContextCoverageResultSchema>;

export const ProjectContextBacklinksResultSchema = z.object({
  query: z.string().min(1),
  links: z.array(ProjectContextLinkSchema),
  files: z.array(ProjectContextCoverageFileSchema),
});
export type ProjectContextBacklinksResult = z.infer<typeof ProjectContextBacklinksResultSchema>;
