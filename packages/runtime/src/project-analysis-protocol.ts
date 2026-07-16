import { RuntimeAnalysisOutcomeKind, type RuntimeAnalysis, type RuntimeAnalysisOutcome } from "./snapshot.ts";

export const ProjectAnalysisProtocolVersion = 3;

export type ProjectAnalysisResult = {
  version: typeof ProjectAnalysisProtocolVersion;
  requestId: string;
  outcome: RuntimeAnalysisOutcome;
};

export function parseProjectAnalysisResult(value: unknown, requestId: string): ProjectAnalysisResult {
  if (!value || typeof value !== "object") throw new Error("Project analysis worker returned an invalid result.");
  const result = value as Partial<ProjectAnalysisResult>;
  if (result.version !== ProjectAnalysisProtocolVersion) {
    throw new Error(`Project analysis worker protocol mismatch: expected ${ProjectAnalysisProtocolVersion}, found ${String(result.version)}.`);
  }
  if (result.requestId !== requestId) throw new Error("Project analysis worker returned a result for another request.");
  if (!result.outcome || typeof result.outcome !== "object") throw new Error("Project analysis worker returned no analysis outcome.");
  const outcome = result.outcome as Partial<RuntimeAnalysisOutcome>;
  if (outcome.kind === RuntimeAnalysisOutcomeKind.Unchanged) {
    if (typeof outcome.analysisInputHash !== "string" || outcome.analysisInputHash.length === 0) {
      throw new Error("Project analysis worker returned no unchanged analysis input identity.");
    }
    if (typeof outcome.sourceInventoryHash !== "string" || outcome.sourceInventoryHash.length === 0) {
      throw new Error("Project analysis worker returned no unchanged source inventory identity.");
    }
    return result as ProjectAnalysisResult;
  }
  if (outcome.kind !== RuntimeAnalysisOutcomeKind.Candidate || !outcome.analysis || typeof outcome.analysis !== "object") {
    throw new Error("Project analysis worker returned an invalid analysis outcome.");
  }
  const analysis = outcome.analysis as Partial<RuntimeAnalysis>;
  if (!analysis.snapshot || typeof analysis.snapshot !== "object") throw new Error("Project analysis worker returned no snapshot.");
  if (!analysis.publication || typeof analysis.publication !== "object") throw new Error("Project analysis worker returned no publication candidate.");
  if (!/^[a-zA-Z0-9_-]+$/.test(analysis.publication.codeGraphGeneration ?? "")) {
    throw new Error("Project analysis worker returned an invalid code graph generation.");
  }
  if (typeof analysis.publication.analysisInputHash !== "string" || analysis.publication.analysisInputHash.length === 0) {
    throw new Error("Project analysis worker returned no analysis input identity.");
  }
  if (typeof analysis.publication.sourceInventoryHash !== "string" || analysis.publication.sourceInventoryHash.length === 0) {
    throw new Error("Project analysis worker returned no source inventory identity.");
  }
  if (!analysis.publication.productModel || typeof analysis.publication.productModel !== "object") {
    throw new Error("Project analysis worker returned no product projection.");
  }
  const changeCatalog = analysis.publication.changeCatalog;
  if (!changeCatalog || typeof changeCatalog !== "object" || !Array.isArray(changeCatalog.changes)) {
    throw new Error("Project analysis worker returned no Change catalog.");
  }
  if (typeof changeCatalog.rootDir !== "string" || typeof changeCatalog.changesPath !== "string") {
    throw new Error("Project analysis worker returned an invalid Change catalog.");
  }
  return result as ProjectAnalysisResult;
}
