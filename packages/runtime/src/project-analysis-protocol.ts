import type { RuntimeAnalysis } from "./snapshot.ts";

export const ProjectAnalysisProtocolVersion = 1;

export type ProjectAnalysisResult = {
  version: typeof ProjectAnalysisProtocolVersion;
  requestId: string;
  analysis: RuntimeAnalysis;
};

export function parseProjectAnalysisResult(value: unknown, requestId: string): ProjectAnalysisResult {
  if (!value || typeof value !== "object") throw new Error("Project analysis worker returned an invalid result.");
  const result = value as Partial<ProjectAnalysisResult>;
  if (result.version !== ProjectAnalysisProtocolVersion) {
    throw new Error(`Project analysis worker protocol mismatch: expected ${ProjectAnalysisProtocolVersion}, found ${String(result.version)}.`);
  }
  if (result.requestId !== requestId) throw new Error("Project analysis worker returned a result for another request.");
  if (!result.analysis || typeof result.analysis !== "object") throw new Error("Project analysis worker returned no analysis candidate.");
  const analysis = result.analysis as Partial<RuntimeAnalysis>;
  if (!analysis.snapshot || typeof analysis.snapshot !== "object") throw new Error("Project analysis worker returned no snapshot.");
  if (!analysis.publication || typeof analysis.publication !== "object") throw new Error("Project analysis worker returned no publication candidate.");
  if (!/^[a-zA-Z0-9_-]+$/.test(analysis.publication.codeGraphGeneration ?? "")) {
    throw new Error("Project analysis worker returned an invalid code graph generation.");
  }
  if (!analysis.publication.productModel || typeof analysis.publication.productModel !== "object") {
    throw new Error("Project analysis worker returned no product projection.");
  }
  return result as ProjectAnalysisResult;
}
