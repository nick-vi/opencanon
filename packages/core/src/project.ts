import { createPaths, loadContextFiles, loadImpactSurfaces, resolveRootDir, validateContext } from "./core.ts";
import type { ContextPaths, Decision, ImpactSurface } from "./core.ts";
import type { Validator } from "./validator.ts";
import { loadValidatorGraph, loadValidators } from "./validator-graph.ts";
import type { ValidatorGraphMetadata } from "./validator-graph.ts";

export type ProjectContext = {
  rootDir: string;
  paths: ContextPaths;
  decisions: Decision[];
  validators: Validator[];
  validatorGraph: ValidatorGraphMetadata;
  impactSurfaces: ImpactSurface[];
};

export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContext> {
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const { decisions } = loadContextFiles(paths);
  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const { validators, metadata: validatorGraph } = await loadValidatorGraph(rootDir, paths);
  const diagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
  if (diagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon context:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return { rootDir, paths, decisions, validators, validatorGraph, impactSurfaces };
}

export { loadValidators };
