import {
  DefinitionGraphNodeKind,
  type ListSemanticChunksResult,
  type ProjectContextAskResult,
  type ProjectContextBacklinksResult,
  type ProjectContextCoverageFile,
  type ProjectContextCoverageResult,
  type ProjectContextEvidence,
  type ProjectContextLink,
  type ProjectContextSearchResult,
  type SemanticChunkMetadata,
  type SemanticSearchResult,
} from "@opencanon/core";
import type { ProjectStore } from "./state.ts";
import type { RuntimeSnapshot } from "./snapshot.ts";
import { semanticSearchVectorForProvider } from "./semantic-index.ts";

const ContextIndexId = "project";
const ChunkPageSize = 500;
const ContextIndexStatus = {
  Ready: "ready",
} as const;
const ContextChunkKind = {
  File: "file",
} as const;

export type ProjectContextQueryOptions = {
  query: string;
  paths?: string[] | undefined;
  limit?: number | undefined;
};

export function searchProjectContext(input: {
  store: ProjectStore;
  snapshot: RuntimeSnapshot;
  query: ProjectContextQueryOptions;
  semanticEmbedding?: Parameters<typeof semanticSearchVectorForProvider>[0]["semanticEmbedding"];
}): ProjectContextSearchResult {
  const text = input.query.query.trim();
  const currentIndex = input.store.readSemanticIndexStatus({ indexId: ContextIndexId }).index;
  if (!text) return { index: currentIndex, query: text, results: [] };
  const vector = semanticSearchVectorForProvider({
    query: text,
    provider: currentIndex?.provider,
    project: input.store.project,
    semanticEmbedding: input.semanticEmbedding,
  });
  const limit = input.query.limit ?? 20;
  const result = input.store.searchSemanticIndex({
    indexId: ContextIndexId,
    query: text,
    vector,
    paths: input.query.paths ?? [],
    limit: Math.min(100, Math.max(limit * 4, 100)),
  });
  const definitionResults = definitionOwnedSearchResults({
    store: input.store,
    snapshot: input.snapshot,
    query: text,
    paths: input.query.paths ?? [],
    limit,
  });
  return {
    index: result.index,
    query: text,
    results: rankSemanticSearchResults(text, mergeSemanticSearchResults([...result.results, ...definitionResults]))
      .slice(0, limit)
      .map((item) => evidenceForSearchResult(input.snapshot, item)),
  };
}

export function listProjectContextChunks(input: {
  store: ProjectStore;
  snapshot?: RuntimeSnapshot | undefined;
  paths?: string[] | undefined;
  definitionIds?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): ListSemanticChunksResult {
  const definitionIds = (input.definitionIds ?? []).map((id) => id.trim()).filter(Boolean);
  const definitionPaths = input.snapshot ? filesForDefinitionIds(input.snapshot, definitionIds) : [];
  const paths = uniqueStrings([...(input.paths ?? []), ...definitionPaths]);
  if (definitionIds.length > 0 && paths.length === 0) {
    return { index: input.store.readSemanticIndexStatus({ indexId: ContextIndexId }).index, chunks: [] };
  }
  return input.store.listSemanticChunks({
    indexId: ContextIndexId,
    paths,
    limit: input.limit ?? 100,
    offset: input.offset ?? 0,
  });
}

export function askProjectContext(input: {
  store: ProjectStore;
  snapshot: RuntimeSnapshot;
  question: string;
  semanticEmbedding?: Parameters<typeof semanticSearchVectorForProvider>[0]["semanticEmbedding"];
}): ProjectContextAskResult {
  const question = input.question.trim();
  const search = searchProjectContext({
    store: input.store,
    snapshot: input.snapshot,
    query: { query: question, limit: 6 },
    semanticEmbedding: input.semanticEmbedding,
  });
  const warnings = freshnessWarnings(search.index);
  if (search.results.length === 0) {
    return {
      index: search.index,
      question,
      answer: "No Project Knowledge matched this question. Rebuild Project Knowledge or ask with more specific file, definition, or surface terms.",
      deterministic: true,
      evidence: [],
      suggestions: ["Run Project Knowledge search with narrower terms.", "Check Health for stale or missing Project Knowledge state."],
      warnings,
    };
  }
  const answerLines = [
    `I found ${search.results.length} indexed evidence ${search.results.length === 1 ? "item" : "items"} related to this question.`,
    ...search.results.slice(0, 4).map((item, index) => `${index + 1}. ${item.file}:${item.line} - ${item.preview}`),
    "Treat this as navigation evidence; deterministic checks, validators, gates, and tests remain authoritative.",
  ];
  const suggestions = missingLinkSuggestions(search.results);
  return {
    index: search.index,
    question,
    answer: answerLines.join("\n"),
    deterministic: true,
    evidence: search.results,
    suggestions,
    warnings,
  };
}

export function projectContextCoverage(input: { store: ProjectStore; snapshot: RuntimeSnapshot }): ProjectContextCoverageResult {
  const index = input.store.readSemanticIndexStatus({ indexId: ContextIndexId }).index;
  const chunks = listAllChunks(input.store, index?.chunkCount ?? 0);
  const chunkCountByFile = new Map<string, number>();
  for (const chunk of chunks) {
    chunkCountByFile.set(chunk.path, (chunkCountByFile.get(chunk.path) ?? 0) + 1);
  }
  const files = input.snapshot.files.map((file) => coverageForFile(input.snapshot, file, chunkCountByFile.get(file) ?? 0));
  const governedFiles = files.filter((file) => fileIsGoverned(file)).length;
  const indexedFiles = files.filter((file) => file.indexedChunks > 0).length;
  const gaps: ProjectContextCoverageResult["gaps"] = [];
  for (const file of files) {
    if (!fileIsGoverned(file)) gaps.push({ kind: "ungoverned-file", file: file.file, message: `${file.file} has no governing Project Map backlinks.` });
    if (file.indexedChunks === 0) gaps.push({ kind: "unindexed-file", file: file.file, message: `${file.file} has no context chunks.` });
  }
  if (index?.status === "stale" || index?.staleChunkCount) {
    gaps.push({ kind: "stale-index", message: "Project Knowledge is stale and should be rebuilt before trusting Search or Ask." });
  }
  return {
    index,
    totals: {
      files: files.length,
      indexedFiles,
      governedFiles,
      ungovernedFiles: files.length - governedFiles,
      chunks: index?.chunkCount ?? chunks.length,
      staleChunks: index?.staleChunkCount ?? 0,
    },
    files,
    gaps,
  };
}

export function projectContextBacklinks(input: { snapshot: RuntimeSnapshot; query: string }): ProjectContextBacklinksResult {
  const query = input.query.trim();
  const normalized = query.toLowerCase();
  const links: ProjectContextLink[] = [];
  for (const node of input.snapshot.definitionGraph.nodes) {
    const publicId = publicDefinitionGraphNodeId(node.kind, node.id).toLowerCase();
    const graphId = node.id.toLowerCase();
    if (publicId === normalized || graphId === normalized || graphId.includes(normalized) || node.label.toLowerCase().includes(normalized)) {
      links.push(definitionNodeLink(node.kind, node.id, node.label));
    }
  }
  for (const finding of input.snapshot.findings) {
    if (finding.id.toLowerCase() === normalized || finding.message.toLowerCase().includes(normalized)) {
      links.push({ kind: "finding", id: finding.id, title: finding.title ?? finding.message, path: finding.file });
    }
  }
  const files = input.snapshot.files
    .filter((file) => file.toLowerCase() === normalized || file.toLowerCase().includes(normalized))
    .map((file) => coverageForFile(input.snapshot, file, 0));
  return { query, links: uniqueLinks(links), files };
}

function listAllChunks(store: ProjectStore, expectedCount: number): SemanticChunkMetadata[] {
  const chunks: SemanticChunkMetadata[] = [];
  for (let offset = 0; ; offset += ChunkPageSize) {
    const page = store.listSemanticChunks({ indexId: ContextIndexId, limit: ChunkPageSize, offset });
    chunks.push(...page.chunks);
    if (page.chunks.length < ChunkPageSize || (expectedCount > 0 && chunks.length >= expectedCount)) break;
  }
  return chunks;
}

function evidenceForSearchResult(snapshot: RuntimeSnapshot, result: SemanticSearchResult): ProjectContextEvidence {
  const fileCoverage = coverageForFile(snapshot, result.chunk.path, 1);
  return {
    chunk: result.chunk,
    file: result.chunk.path,
    line: result.chunk.range.start.line,
    preview: result.chunk.preview,
    score: result.score,
    scores: result.scores,
    definitions: [
      ...fileCoverage.areas,
      ...fileCoverage.specs,
      ...fileCoverage.changes,
      ...fileCoverage.conventions,
    ],
    surfaces: fileCoverage.surfaces,
    checks: checksForDefinitions(snapshot, fileCoverage),
    findings: findingsForFile(snapshot, result.chunk.path),
  };
}

function rankSemanticSearchResults(query: string, results: SemanticSearchResult[]): SemanticSearchResult[] {
  return results
    .map((result, index) => {
      const boost = semanticSearchRankBoost(query, result.chunk);
      const score = Math.min(1, result.score + boost);
      return {
        index,
        rankScore: score,
        result: score === result.score ? result : { ...result, score },
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore || right.result.score - left.result.score || left.index - right.index)
    .map((item) => item.result);
}

function mergeSemanticSearchResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
  const merged = new Map<string, SemanticSearchResult>();
  for (const result of results) {
    const previous = merged.get(result.chunk.id);
    if (!previous || result.score > previous.score) merged.set(result.chunk.id, result);
  }
  return [...merged.values()];
}

function definitionOwnedSearchResults(input: {
  store: ProjectStore;
  snapshot: RuntimeSnapshot;
  query: string;
  paths: string[];
  limit: number;
}): SemanticSearchResult[] {
  const fileScores = definitionFileScoresForQuery(input.snapshot, input.query);
  if (fileScores.size === 0) return [];
  const allowedPaths = new Set(input.paths);
  const paths = [...fileScores.keys()].filter((file) => allowedPaths.size === 0 || allowedPaths.has(file));
  if (paths.length === 0) return [];
  const chunks = input.store.listSemanticChunks({
    indexId: ContextIndexId,
    paths,
    limit: Math.min(500, Math.max(input.limit * 4, 50)),
  }).chunks;
  return chunks.map((chunk) => {
    const lexical = fileScores.get(chunk.path) ?? 0.5;
    const boost = semanticSearchRankBoost(input.query, chunk);
    const signal = chunkQuerySignalScore(input.query, chunk);
    const score = signal > 0 ? Math.min(1, lexical + boost + signal) : lexical >= 0.85 ? Math.min(0.75, lexical) : Math.min(0.25, lexical * 0.5);
    return { chunk, score, scores: { lexical, combined: score } };
  });
}

function definitionFileScoresForQuery(snapshot: RuntimeSnapshot, query: string): Map<string, number> {
  const definitionScores = new Map<string, number>();
  for (const area of snapshot.areas) {
    addDefinitionScore(definitionScores, "areas", area.id, definitionMatchScore(query, [area.id, area.title, area.summary]));
  }
  for (const spec of snapshot.specs) {
    addDefinitionScore(definitionScores, "specs", spec.id, definitionMatchScore(query, [spec.id, spec.title, spec.summary]));
  }
  for (const change of snapshot.changes) {
    addDefinitionScore(definitionScores, "changes", change.id, definitionMatchScore(query, [change.id, change.title, change.summary]));
  }
  for (const convention of snapshot.conventions) {
    addDefinitionScore(definitionScores, "conventions", convention.id, definitionMatchScore(query, [convention.id, convention.title, convention.rule]));
  }
  for (const surface of snapshot.impactSurfaces) {
    addDefinitionScore(definitionScores, "surfaces", surface.id, definitionMatchScore(query, [surface.id, surface.title ?? ""]));
  }
  if (definitionScores.size === 0) return new Map();
  const files = new Map<string, number>();
  for (const [file, coverage] of Object.entries(snapshot.definitionGraph.fileCoverage)) {
    const scores = [
      ...coverage.areas.map((id) => definitionScores.get(`areas:${id}`) ?? 0),
      ...coverage.specs.map((id) => definitionScores.get(`specs:${id}`) ?? 0),
      ...coverage.changes.map((id) => definitionScores.get(`changes:${id}`) ?? 0),
      ...coverage.conventions.map((id) => definitionScores.get(`conventions:${id}`) ?? 0),
      ...coverage.surfaces.map((id) => definitionScores.get(`surfaces:${id}`) ?? 0),
    ];
    const score = Math.max(0, ...scores);
    if (score > 0) files.set(file, score);
  }
  return files;
}

function addDefinitionScore(scores: Map<string, number>, kind: string, id: string, score: number): void {
  if (score > 0) scores.set(`${kind}:${id}`, score);
}

function definitionMatchScore(query: string, fields: string[]): number {
  const terms = significantRankTerms(query);
  if (terms.length === 0) return 0;
  const text = normalizeRankText(fields.join(" "));
  if (!text) return 0;
  const queryText = normalizeRankText(query);
  if (text.includes(queryText)) return 0.9;
  const textSlug = slugRankText(text);
  const hasPhraseMatch = adjacentPhraseSlugs(terms).some((phrase) => textSlug.includes(phrase));
  const overlap = terms.filter((term) => text.includes(term)).length;
  if (overlap < Math.min(2, terms.length)) return 0;
  if (hasPhraseMatch) return 0.45 + Math.min(0.15, overlap / terms.length / 3);
  return 0.35;
}

function semanticSearchRankBoost(query: string, chunk: SemanticChunkMetadata): number {
  const queryText = normalizeRankText(query);
  if (!queryText) return 0;
  const querySlug = slugRankText(query);
  const pathSlug = slugRankText(chunk.path);
  const headingText = normalizeRankText(chunk.heading ?? "");
  const significantTerms = significantRankTerms(query);
  const phraseSlugs = adjacentPhraseSlugs(significantTerms);
  const terms = queryText.split(" ").filter((term) => term.length > 1);
  let boost = 0;
  if (chunk.language === "markdown") boost += 0.05;
  if (chunk.path.startsWith("docs/opencanon/")) boost += 0.05;
  if (querySlug && pathSlug.includes(querySlug)) boost += 0.35;
  if (phraseSlugs.some((phrase) => pathSlug.includes(phrase))) boost += 0.2;
  if (headingText) {
    const headingSlug = slugRankText(headingText);
    if (headingText === queryText) boost += 0.7;
    else if (headingText.includes(queryText) || terms.every((term) => headingText.includes(term))) boost += 0.35;
    else if (phraseSlugs.some((phrase) => headingSlug.includes(phrase))) boost += 0.2;
  }
  return boost;
}

function chunkQuerySignalScore(query: string, chunk: SemanticChunkMetadata): number {
  const terms = significantRankTerms(query);
  if (terms.length === 0) return 0;
  const phraseSlugs = adjacentPhraseSlugs(terms);
  const pathSlug = slugRankText(chunk.path);
  const text = normalizeRankText([chunk.heading ?? "", chunk.symbol ?? "", chunk.preview].join(" "));
  const textSlug = slugRankText(text);
  if (phraseSlugs.some((phrase) => textSlug.includes(phrase))) return 0.15;
  if (chunk.kind === ContextChunkKind.File || chunk.language === "markdown") {
    if (phraseSlugs.some((phrase) => pathSlug.includes(phrase))) return 0.12;
  }
  const pathCanSignal = chunk.kind === ContextChunkKind.File || chunk.language === "markdown";
  const overlap = terms.filter((term) => text.includes(term) || (pathCanSignal && pathSlug.includes(term))).length;
  return overlap >= Math.min(2, terms.length) ? 0.08 : 0;
}

function significantRankTerms(value: string): string[] {
  const stopWords = new Set(["a", "an", "and", "are", "as", "be", "by", "for", "from", "how", "in", "is", "it", "of", "on", "or", "the", "to", "what", "where", "with"]);
  return normalizeRankText(value)
    .split(" ")
    .filter((term) => term.length > 2 && !stopWords.has(term));
}

function adjacentPhraseSlugs(terms: string[]): string[] {
  const phrases: string[] = [];
  for (let index = 0; index < terms.length - 1; index += 1) phrases.push(`${terms[index]}${terms[index + 1]}`);
  return phrases;
}

function normalizeRankText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function slugRankText(value: string): string {
  return normalizeRankText(value).replace(/\s+/gu, "");
}

function coverageForFile(snapshot: RuntimeSnapshot, file: string, indexedChunks: number): ProjectContextCoverageFile {
  const coverage = snapshot.definitionGraph.fileCoverage[file] ?? {
    areas: [],
    specs: [],
    changes: [],
    conventions: [],
    surfaces: [],
  };
  return {
    file,
    areas: coverage.areas.map((id) => areaLink(snapshot, id)).filter(isLink),
    specs: coverage.specs.map((id) => specLink(snapshot, id)).filter(isLink),
    changes: coverage.changes.map((id) => changeLink(snapshot, id)).filter(isLink),
    conventions: coverage.conventions.map((id) => conventionLink(snapshot, id)).filter(isLink),
    surfaces: coverage.surfaces.map((id) => surfaceLink(snapshot, id)).filter(isLink),
    indexedChunks,
  };
}

function checksForDefinitions(snapshot: RuntimeSnapshot, coverage: ProjectContextCoverageFile): ProjectContextLink[] {
  const links: ProjectContextLink[] = [];
  for (const link of coverage.areas) {
    const item = snapshot.areas.find((candidate) => candidate.id === link.id);
    for (const check of item?.checks ?? []) links.push({ kind: "check", id: check.id, title: `${link.title ?? link.id} check` });
  }
  for (const link of coverage.specs) {
    const item = snapshot.specs.find((candidate) => candidate.id === link.id);
    for (const check of item?.checks ?? []) links.push({ kind: "check", id: check.id, title: `${link.title ?? link.id} check` });
  }
  for (const link of coverage.changes) {
    const item = snapshot.changes.find((candidate) => candidate.id === link.id);
    for (const check of item?.checks ?? []) links.push({ kind: "check", id: check.id, title: `${link.title ?? link.id} check` });
  }
  return uniqueLinks(links);
}

function findingsForFile(snapshot: RuntimeSnapshot, file: string): ProjectContextLink[] {
  return snapshot.findings
    .filter((finding) => finding.file === file)
    .map((finding) => ({ kind: "finding" as const, id: finding.id, title: finding.title ?? finding.message, path: finding.file }));
}

function missingLinkSuggestions(evidence: ProjectContextEvidence[]): string[] {
  const suggestions = new Set<string>();
  for (const item of evidence) {
    if (item.definitions.length === 0) suggestions.add(`Consider adding a definition backlink for ${item.file}.`);
    if (item.surfaces.length === 0) suggestions.add(`Consider mapping ${item.file} to an impact surface if it carries product or architecture risk.`);
  }
  return [...suggestions].slice(0, 5);
}

function freshnessWarnings(index: ProjectContextSearchResult["index"]): string[] {
  if (!index) return ["No Project Knowledge snapshot is available."];
  if (index.status !== ContextIndexStatus.Ready) return [`Project Knowledge status is ${index.status}.`];
  if (index.staleChunkCount > 0) return [`Project Knowledge has ${index.staleChunkCount} stale chunks.`];
  return [];
}

function fileIsGoverned(file: ProjectContextCoverageFile): boolean {
  return file.areas.length + file.specs.length + file.changes.length + file.conventions.length + file.surfaces.length > 0;
}

function areaLink(snapshot: RuntimeSnapshot, id: string): ProjectContextLink | undefined {
  const item = snapshot.areas.find((candidate) => candidate.id === id);
  return item ? { kind: "area", id: item.id, title: item.title } : undefined;
}

function specLink(snapshot: RuntimeSnapshot, id: string): ProjectContextLink | undefined {
  const item = snapshot.specs.find((candidate) => candidate.id === id);
  return item ? { kind: "spec", id: item.id, title: item.title } : undefined;
}

function changeLink(snapshot: RuntimeSnapshot, id: string): ProjectContextLink | undefined {
  const item = snapshot.changes.find((candidate) => candidate.id === id);
  return item ? { kind: "change", id: item.id, title: item.title } : undefined;
}

function conventionLink(snapshot: RuntimeSnapshot, id: string): ProjectContextLink | undefined {
  const item = snapshot.conventions.find((candidate) => candidate.id === id);
  return item ? { kind: "convention", id: item.id, title: item.title } : undefined;
}

function surfaceLink(snapshot: RuntimeSnapshot, id: string): ProjectContextLink | undefined {
  const item = snapshot.impactSurfaces.find((candidate) => candidate.id === id);
  return item ? { kind: "impact-surface", id: item.id, title: item.title ?? item.id } : undefined;
}

function definitionNodeLink(kind: RuntimeSnapshot["definitionGraph"]["nodes"][number]["kind"], id: string, title: string): ProjectContextLink {
  const publicId = publicDefinitionGraphNodeId(kind, id);
  if (kind === DefinitionGraphNodeKind.Change) return { kind: "change", id: publicId, title };
  if (kind === DefinitionGraphNodeKind.ImpactSurface) return { kind: "impact-surface", id: publicId, title };
  if (kind === DefinitionGraphNodeKind.Task) return { kind: "task", id: publicId, title };
  if (
    kind === DefinitionGraphNodeKind.Area ||
    kind === DefinitionGraphNodeKind.Spec ||
    kind === DefinitionGraphNodeKind.Convention ||
    kind === DefinitionGraphNodeKind.Validator ||
    kind === DefinitionGraphNodeKind.Check
  ) {
    return { kind: kind === DefinitionGraphNodeKind.Validator ? "check" : kind, id: publicId, title };
  }
  return { kind: "file", id: publicId, title, path: publicId };
}

function isLink(value: ProjectContextLink | undefined): value is ProjectContextLink {
  return value !== undefined;
}

function uniqueLinks(links: ProjectContextLink[]): ProjectContextLink[] {
  const seen = new Set<string>();
  const result: ProjectContextLink[] = [];
  for (const link of links) {
    const key = `${link.kind}:${link.id}:${link.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function filesForDefinitionIds(snapshot: RuntimeSnapshot, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const requested = new Set(ids);
  const files = new Set<string>();
  for (const [file, coverage] of Object.entries(snapshot.definitionGraph.fileCoverage)) {
    const linkedIds = [
      ...coverage.areas,
      ...coverage.specs,
      ...coverage.changes,
      ...coverage.conventions,
      ...coverage.surfaces,
    ];
    if (linkedIds.some((id) => requested.has(id))) files.add(file);
  }
  return [...files].sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function publicDefinitionGraphNodeId(kind: RuntimeSnapshot["definitionGraph"]["nodes"][number]["kind"], id: string): string {
  if (kind === DefinitionGraphNodeKind.Area) return stripNodePrefix(id, "area");
  if (kind === DefinitionGraphNodeKind.Change) return stripNodePrefix(id, "change");
  if (kind === DefinitionGraphNodeKind.Spec) return stripNodePrefix(id, "spec");
  if (kind === DefinitionGraphNodeKind.Convention) return stripNodePrefix(id, "convention");
  if (kind === DefinitionGraphNodeKind.ImpactSurface) return stripNodePrefix(id, "impact-surface");
  if (kind === DefinitionGraphNodeKind.Validator) return stripNodePrefix(id, "validator");
  if (kind === DefinitionGraphNodeKind.Check) return id.includes(":check:") ? id.slice(id.lastIndexOf(":check:") + ":check:".length) : id;
  if (kind === DefinitionGraphNodeKind.Task) return id.includes(":task:") ? id.slice(id.lastIndexOf(":task:") + ":task:".length) : id;
  if (kind === DefinitionGraphNodeKind.Target) return stripTargetNodePrefix(id);
  return id;
}

function stripNodePrefix(id: string, prefix: string): string {
  const expected = `${prefix}:`;
  return id.startsWith(expected) ? id.slice(expected.length) : id;
}

function stripTargetNodePrefix(id: string): string {
  const match = /^target:[^:]+:(.+)$/.exec(id);
  return match?.[1] ?? id;
}
