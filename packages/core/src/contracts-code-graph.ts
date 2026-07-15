import { z } from "zod";
import {
  FactDiagnosticSchema,
  FactKindSchema,
  FileFactsSchema,
  LanguageSchema,
  RepoGraphSchema,
} from "./contracts-facts.ts";

export const ExtractFactsRequestSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      language: LanguageSchema,
      content: z.string().optional(),
    }),
  ),
  facts: z.array(FactKindSchema),
  parserVersion: z.string().min(1),
});
export type ExtractFactsRequest = z.infer<typeof ExtractFactsRequestSchema>;

export const ExtractFactsResultSchema = z.object({
  files: z.array(FileFactsSchema),
  diagnostics: z.array(FactDiagnosticSchema).default([]),
});
export type ExtractFactsResult = z.infer<typeof ExtractFactsResultSchema>;

export const BuildRepoGraphRequestSchema = z.object({
  facts: z.array(FileFactsSchema),
  packageManifests: z.array(z.string().min(1)).default([]),
});
export type BuildRepoGraphRequest = z.infer<typeof BuildRepoGraphRequestSchema>;

export const BuildRepoGraphResultSchema = z.object({
  graph: RepoGraphSchema,
});
export type BuildRepoGraphResult = z.infer<typeof BuildRepoGraphResultSchema>;

export const IndexCodeGraphRequestSchema = z.object({
  generation: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      language: LanguageSchema,
      content: z.string().optional(),
    }),
  ),
  parserVersion: z.string().default(""),
  extractorVersion: z.string().default(""),
});
export type IndexCodeGraphRequest = Omit<z.input<typeof IndexCodeGraphRequestSchema>, "generation">;

export const IndexCodeGraphResultSchema = z.object({
  generation: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  indexed: z.array(
    z.object({
      path: z.string().min(1),
      nodes: z.number().int().min(0),
      unresolved: z.number().int().min(0),
      supported: z.boolean(),
    }),
  ),
  deleted: z.array(z.string().min(1)).default([]),
  diagnostics: z
    .array(
      z.object({
        path: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
        severity: z.string().min(1),
      }),
    )
    .default([]),
  parserVersion: z.string().min(1),
  extractorVersion: z.string().min(1),
});
export type IndexCodeGraphResult = z.infer<typeof IndexCodeGraphResultSchema>;

export const SearchSymbolsRequestSchema = z.object({
  query: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type SearchSymbolsRequest = z.input<typeof SearchSymbolsRequestSchema>;

export const codeSymbolKindValues = ["function", "class", "variable", "type", "interface", "enum", "export-default"] as const;
export const CodeSymbolKindSchema = z.enum(codeSymbolKindValues);
export type CodeSymbolKind = z.infer<typeof CodeSymbolKindSchema>;

export const SymbolRangePositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  byte: z.number().int().min(0),
});
export const SymbolRangeSchema = z.object({
  start: SymbolRangePositionSchema,
  end: SymbolRangePositionSchema,
});
export const CodeSymbolSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1),
  kind: CodeSymbolKindSchema,
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  exported: z.boolean(),
  signature: z.string().nullable().optional(),
  range: SymbolRangeSchema,
  score: z.number().nullable().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const SearchSymbolsResultSchema = z.object({
  symbols: z.array(CodeSymbolSchema),
});
export type SearchSymbolsResult = z.infer<typeof SearchSymbolsResultSchema>;

export const SearchReferencesRequestSchema = z.object({
  query: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type SearchReferencesRequest = z.input<typeof SearchReferencesRequestSchema>;

export const CodeReferenceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().nullable().optional(),
  range: SymbolRangeSchema,
  provenance: z.string().min(1),
  confidence: z.string().min(1),
});
export type CodeReference = z.infer<typeof CodeReferenceSchema>;

export const SearchReferencesResultSchema = z.object({
  references: z.array(CodeReferenceSchema),
});
export type SearchReferencesResult = z.infer<typeof SearchReferencesResultSchema>;

export const SearchGraphEdgesRequestSchema = z.object({
  query: z.string().min(1).optional(),
  symbolId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type SearchGraphEdgesRequest = z.input<typeof SearchGraphEdgesRequestSchema>;

export const CodeGraphEdgeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  provenance: z.string().min(1),
  confidence: z.string().min(1),
  path: z.string().min(1),
  range: z.object({
    start: SymbolRangePositionSchema,
  }),
  source: CodeSymbolSchema,
  target: CodeSymbolSchema,
});
export type CodeGraphEdge = z.infer<typeof CodeGraphEdgeSchema>;

export const SearchGraphEdgesResultSchema = z.object({
  edges: z.array(CodeGraphEdgeSchema),
});
export type SearchGraphEdgesResult = z.infer<typeof SearchGraphEdgesResultSchema>;
