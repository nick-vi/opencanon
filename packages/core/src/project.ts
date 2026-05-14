import { statSync } from "node:fs";
import { createPaths, loadContextFiles, loadImpactSurfaces, pathToImportUrl, relative, resolveRootDir, validateContext } from "./core.ts";
import type { ContextPaths, Decision, ImpactSurface } from "./core.ts";
import { resolveValidators } from "./validator.ts";
import type { Validator } from "./validator.ts";

export type ProjectContext = {
  rootDir: string;
  paths: ContextPaths;
  decisions: Decision[];
  validators: Validator[];
  impactSurfaces: ImpactSurface[];
};

export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContext> {
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const { decisions } = loadContextFiles(paths);
  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const validators = await loadValidators(rootDir, paths);
  const diagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
  if (diagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon context:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return { rootDir, paths, decisions, validators, impactSurfaces };
}

export async function loadValidators(rootDir: string, paths: ContextPaths): Promise<Validator[]> {
  const module = await import(`${pathToImportUrl(paths.validatorsPath)}?mtime=${statSync(paths.validatorsPath).mtimeMs}`);
  const result = resolveValidators(module.default);
  if (result.diagnostics.length > 0) {
    throw new Error(`Invalid validators ${relative(rootDir, paths.validatorsPath)}:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return result.validators;
}
