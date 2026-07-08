import {
  buildDefinitionHistoryGitArgs,
  loadAreaHistoryTarget,
  loadChangeHistoryTarget,
  loadConventionHistoryTarget,
  loadSpecHistoryTarget,
  parseConventionGitLog,
  runGit as runConventionGit,
  type DefinitionHistoryKind,
  type DefinitionHistoryTarget,
} from "@opencanon/core";
import { UrlSearchParam, diagnostic, diagnosticCodes, diagnosticsFailure, json } from "./routes.ts";

const DefinitionHistoryKindValue = {
  Convention: "convention",
  Area: "area",
  Spec: "spec",
  Change: "change",
} as const satisfies Record<string, DefinitionHistoryKind>;

export async function canonHistoryFromRuntime(rootDir: string, url: URL): Promise<Response> {
  const kind = parseDefinitionHistoryKind(url.searchParams.get(UrlSearchParam.Kind) ?? "");
  if (!kind) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "kind must be convention, area, spec, or change."), 400);
  const id = (url.searchParams.get(UrlSearchParam.Id) ?? "").trim();
  if (!id) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "id is required."), 400);

  const targetResult = await loadDefinitionHistoryTarget(rootDir, kind, id);
  if (!targetResult.ok) return json(diagnosticsFailure(targetResult.diagnostics), 404);

  const git = runConventionGit(rootDir, buildDefinitionHistoryGitArgs(targetResult.target.files));
  return json({
    ok: true,
    data: {
      target: targetResult.target,
      gitRoot: git.gitRoot,
      args: git.args,
      diagnostics: git.diagnostics,
      commits: parseConventionGitLog(git.stdout),
    },
  });
}

function parseDefinitionHistoryKind(value: string): DefinitionHistoryKind | undefined {
  if (
    value === DefinitionHistoryKindValue.Convention ||
    value === DefinitionHistoryKindValue.Area ||
    value === DefinitionHistoryKindValue.Spec ||
    value === DefinitionHistoryKindValue.Change
  ) return value;
  return undefined;
}

async function loadDefinitionHistoryTarget(
  rootDir: string,
  kind: DefinitionHistoryKind,
  id: string,
): Promise<{ ok: true; target: DefinitionHistoryTarget } | { ok: false; diagnostics: string[] }> {
  if (kind === DefinitionHistoryKindValue.Area) return loadAreaHistoryTarget(rootDir, id);
  if (kind === DefinitionHistoryKindValue.Spec) return loadSpecHistoryTarget(rootDir, id);
  if (kind === DefinitionHistoryKindValue.Change) return loadChangeHistoryTarget(rootDir, id);
  const result = await loadConventionHistoryTarget(rootDir, id);
  if (!result.ok) return result;
  return { ok: true, target: { kind: DefinitionHistoryKindValue.Convention, ...result.target } };
}
