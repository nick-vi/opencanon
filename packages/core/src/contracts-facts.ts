import { z } from "zod";

export const validatorScopeValues = ["file", "folder", "import-edge", "package", "project"] as const;
export const ValidatorScopeSchema = z.enum(validatorScopeValues);
export type ValidatorScope = z.infer<typeof ValidatorScopeSchema>;

export const factKindValues = ["imports", "exports", "symbols", "declarations", "calls", "literals", "comments", "references", "annotations", "diagnostics", "duplicates"] as const;
export const FactKindSchema = z.enum(factKindValues);
export type FactKind = z.infer<typeof FactKindSchema>;

const SharedFactKind = {
  Text: "text",
  Type: "type",
  Unknown: "unknown",
} as const;

export const languageValues = ["typescript", "tsx", "javascript", "jsx", "svelte", "python", "json", "markdown", SharedFactKind.Text] as const;
export const LanguageSchema = z.enum(languageValues);
export type Language = z.infer<typeof LanguageSchema>;

export const DiagnosticSeverity = {
  Error: "error",
  Warning: "warning",
  Info: "info",
} as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];
export const diagnosticSeverityValues = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Info] as const;
export const validatorSeverityValues = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning] as const;

export const PositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1).optional(),
});
export type Position = z.infer<typeof PositionSchema>;

export const ImportFactSchema = PositionSchema.extend({
  source: z.string().min(1),
  specifiers: z.array(z.string()),
  kind: z.enum(["import", "export", "dynamic"]),
  resolution: z.enum(["relative", "alias", "workspace", "external", "unresolved"]),
  resolvedPath: z.string().min(1).optional(),
  fromPackage: z.string().min(1).optional(),
  toPackage: z.string().min(1).optional(),
});
export type ImportFact = z.infer<typeof ImportFactSchema>;

export const ExportFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["function", "class", SharedFactKind.Type, "interface", "const", "let", "var", "enum", "default", "reexport", "star-reexport"]),
  source: z.string().min(1).optional(),
  importedName: z.string().min(1).optional(),
  typeOnly: z.boolean().optional(),
});
export type ExportFact = z.infer<typeof ExportFactSchema>;

export const SymbolFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["function", "class", "method", "variable", SharedFactKind.Type, "interface", "enum", "property", SharedFactKind.Unknown]),
  exported: z.boolean().default(false),
  endLine: z.number().int().min(1).optional(),
  params: z.array(z.string()).optional(),
});
export type SymbolFact = z.infer<typeof SymbolFactSchema>;

export const EnumMemberFactSchema = z.object({
  line: z.number().int().min(1),
  name: z.string().min(1),
  value: z.string().optional(),
  valueKind: z.enum(["string", "number", SharedFactKind.Unknown]),
});
export type EnumMemberFact = z.infer<typeof EnumMemberFactSchema>;

export const ObjectPropertyFactSchema = z.object({
  line: z.number().int().min(1),
  key: z.string().min(1),
  quoted: z.boolean(),
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean", SharedFactKind.Unknown]),
});
export type ObjectPropertyFact = z.infer<typeof ObjectPropertyFactSchema>;

export const InitializerFactSchema = z.object({
  kind: z.enum(["object", "array", "literal", "call", SharedFactKind.Unknown]),
  asConst: z.boolean(),
  satisfies: z.string().min(1).optional(),
  properties: z.array(ObjectPropertyFactSchema).default([]),
});
export type InitializerFact = z.infer<typeof InitializerFactSchema>;

export const DeclarationFactSchema = z.object({
  line: z.number().int().min(1),
  endLine: z.number().int().min(1),
  name: z.string().min(1),
  kind: z.enum(["enum", "variable", SharedFactKind.Type, "function", "class", "interface"]),
  exported: z.boolean().default(false),
  text: z.string(),
  constEnum: z.boolean().optional(),
  members: z.array(EnumMemberFactSchema).default([]),
  declarationKind: z.enum(["const", "let", "var"]).optional(),
  initializer: InitializerFactSchema.optional(),
  async: z.boolean().optional(),
});
export type DeclarationFact = z.infer<typeof DeclarationFactSchema>;

export const CallFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  receiver: z.string().min(1).optional(),
  callee: z.string().min(1),
  tryDepth: z.number().int().min(0).default(0),
  argumentCalls: z.array(z.object({ callee: z.string().min(1), name: z.string().min(1), awaited: z.boolean() })).default([]),
});
export type CallFact = z.infer<typeof CallFactSchema>;

export const LiteralFactSchema = PositionSchema.extend({
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean"]),
  context: z.string().min(1),
  declarationSourceId: z.string().min(1).optional(),
});
export type LiteralFact = z.infer<typeof LiteralFactSchema>;

export const CommentFactSchema = PositionSchema.extend({
  text: z.string(),
  kind: z.enum(["line", "block"]),
});
export type CommentFact = z.infer<typeof CommentFactSchema>;

export const ReferenceFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["identifier", "import", "export", "call", SharedFactKind.Type, SharedFactKind.Text, SharedFactKind.Unknown]),
  targetPath: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
});
export type ReferenceFact = z.infer<typeof ReferenceFactSchema>;

export const AnnotationFactSchema = PositionSchema.extend({
  tag: z.string().min(1),
  value: z.string().default(""),
  raw: z.string().min(1),
  ownerName: z.string().min(1).optional(),
});
export type AnnotationFact = z.infer<typeof AnnotationFactSchema>;

export const DiagnosticFactSchema = PositionSchema.extend({
  source: z.string().min(1),
  code: z.string().min(1).optional(),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues),
});
export type DiagnosticFact = z.infer<typeof DiagnosticFactSchema>;

export const DuplicateFactSchema = PositionSchema.extend({
  kind: z.enum(["literal", "object-shape", "schema-shape", "sql-fragment", "ast-block", SharedFactKind.Text]),
  key: z.string().min(1),
  value: z.string(),
  occurrences: z.number().int().min(2),
  files: z.array(z.string().min(1)).min(1),
});
export type DuplicateFact = z.infer<typeof DuplicateFactSchema>;

export const FactDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues),
  position: PositionSchema.optional(),
});
export type FactDiagnostic = z.infer<typeof FactDiagnosticSchema>;

export const FileFactsSchema = z.object({
  path: z.string().min(1),
  contentHash: z.string().min(1),
  language: LanguageSchema,
  parser: z.string().min(1),
  parserVersion: z.string().min(1),
  imports: z.array(ImportFactSchema).default([]),
  exports: z.array(ExportFactSchema).default([]),
  symbols: z.array(SymbolFactSchema).default([]),
  declarations: z.array(DeclarationFactSchema).default([]),
  calls: z.array(CallFactSchema).default([]),
  literals: z.array(LiteralFactSchema).default([]),
  comments: z.array(CommentFactSchema).default([]),
  references: z.array(ReferenceFactSchema).default([]),
  annotations: z.array(AnnotationFactSchema).default([]),
  diagnosticFacts: z.array(DiagnosticFactSchema).default([]),
  duplicates: z.array(DuplicateFactSchema).default([]),
  diagnostics: z.array(FactDiagnosticSchema).default([]),
});
export type FileFacts = z.infer<typeof FileFactsSchema>;

export const WorkspaceNodeSchema = z.object({
  name: z.string().min(1),
  root: z.string(),
  kind: z.enum(["root", "app", "package", "workspace"]),
  dependencies: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceNode = z.infer<typeof WorkspaceNodeSchema>;

export const ImportEdgeFactSchema = z.object({
  from: z.string().min(1),
  source: z.string().min(1),
  to: z.string().min(1).optional(),
  resolution: ImportFactSchema.shape.resolution,
  fromPackage: z.string().min(1).optional(),
  toPackage: z.string().min(1).optional(),
});
export type ImportEdgeFact = z.infer<typeof ImportEdgeFactSchema>;

export const RepoGraphSchema = z.object({
  rootDir: z.string().min(1),
  graphHash: z.string().min(1),
  files: z.array(z.string().min(1)),
  packages: z.array(WorkspaceNodeSchema).default([]),
  importEdges: z.array(ImportEdgeFactSchema).default([]),
});
export type RepoGraph = z.infer<typeof RepoGraphSchema>;
