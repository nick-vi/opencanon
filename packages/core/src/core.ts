export type {
  Baseline,
  ChangePolicy,
  ContextConfig,
  ContextPaths,
  ContextReferenceValidator,
  ContextValidationInput,
  Decision,
  Format,
  ImpactSurface,
  ProposedImpactNote,
} from "./context.ts";
export {
  createDefaultConfig,
  createPaths,
  loadBaseline,
  loadConfig,
  loadContextFiles,
  loadImpactSurfaces,
  loadProposedImpactNotes,
  ProjectFileName,
  resolveRootDir,
  validateConfig,
  validateContext,
  validateImpactSurfaces,
} from "./context.ts";
export { explainGlobMatches, intersects, matchesAny, matchesAnyFile, normalizePath, pathToImportUrl, relative, splitList, toRepoRelativePath, unique } from "./core-utils.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
export { discoverProjectFiles, FileDiscoveryMode, listFiles, listProjectFiles, matchesProjectFileScope } from "./discovery.ts";
export type { DocSnippet } from "./docs.ts";
export { normalizeMarkdownHeading, parseMarkdownDoc, resolveDocsReferences, validateDocsReference } from "./docs.ts";
export type { GitCommitInfo, GitFileDiff, GitFileHistory } from "./git.ts";
export { getChangedFiles, getGitFileDiff, getGitFileHistory, getGitRoot } from "./git.ts";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
