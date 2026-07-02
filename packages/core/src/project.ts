import { loadAreaGraph } from "./area-loader.ts";
import type { AreaGraphMetadata } from "./area-loader.ts";
import type { Area } from "./area.ts";
import { loadChangeGraph } from "./change-loader.ts";
import type { ChangeGraphMetadata } from "./change-loader.ts";
import type { Change } from "./change.ts";
import { loadSpecGraph } from "./spec-loader.ts";
import type { SpecGraphMetadata } from "./spec-loader.ts";
import type { Spec } from "./spec.ts";
import { createPaths, loadImpactSurfaces, resolveRootDir, validateContext } from "./core.ts";
import type { ContextPaths, ImpactSurface } from "./core.ts";
import type { Convention } from "./convention.ts";
import type { Validator } from "./validator.ts";
import { loadConventionGraph, loadValidators } from "./validator-graph.ts";
import type { ValidatorGraphMetadata } from "./validator-graph.ts";

export type ProjectContext = {
  rootDir: string;
  paths: ContextPaths;
  areas: Area[];
  areaGraph: AreaGraphMetadata;
  specs: Spec[];
  specGraph: SpecGraphMetadata;
  changes: Change[];
  changeGraph: ChangeGraphMetadata;
  conventions: Convention[];
  validators: Validator[];
  validatorGraph: ValidatorGraphMetadata;
  impactSurfaces: ImpactSurface[];
};

export type UncheckedProjectContext = ProjectContext & {
  diagnostics: string[];
};

export async function loadProjectContextUnchecked(cwd = process.cwd()): Promise<UncheckedProjectContext> {
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const areaGraph = await loadAreaGraph(rootDir, paths);
  const specGraph = await loadSpecGraph(rootDir, paths);
  const changeGraph = await loadChangeGraph(rootDir, paths);
  const { validators, conventions: conventionResolution, metadata: validatorGraph } = await loadConventionGraph(rootDir, paths, paths.conventionsPath);
  const conventions = [...conventionResolution.byId.values()];
  const areas = areaGraph.areas;
  const specs = specGraph.specs;
  const changes = changeGraph.changes;
  const diagnostics = [
    ...impactDiagnostics,
    ...validateContext({
      conventions,
      areas,
      specs,
      changes,
      validators: validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds, docs: validator.docs })),
      impactSurfaces,
      paths,
    }),
  ];
  return {
    rootDir,
    paths,
    areas,
    areaGraph: areaGraph.metadata,
    specs,
    specGraph: specGraph.metadata,
    changes,
    changeGraph: changeGraph.metadata,
    conventions,
    validators,
    validatorGraph,
    impactSurfaces,
    diagnostics,
  };
}

export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContext> {
  const context = await loadProjectContextUnchecked(cwd);
  if (context.diagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon context:\n${context.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return context;
}

export { loadValidators };
