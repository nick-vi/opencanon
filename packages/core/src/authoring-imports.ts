import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTypesFilePath } from "./project-types.ts";
import type { Plugin } from "./runtime-esbuild.ts";

/** Resolved on-disk targets for the `@opencanon/*` authoring imports that validator
 * and fixture definitions write against. */
export type AuthoringImportAliases = { core: string; validators: string; project: string };

export type ResolveAuthoringImportAliasesInput = {
  rootDir: string;
  generatedProject?: string;
  sourceRootCandidates?: string[];
};

/** esbuild plugin that rewrites the `@opencanon/*` authoring imports to the resolved
 * on-disk aliases, and keeps `esbuild` itself external. Alias discovery differs per
 * caller (validator graph vs. fixture testing), so callers compute the aliases and
 * pass them in. */
export function authoringImportPlugin(aliases: AuthoringImportAliases): Plugin {
  return {
    name: "opencanon-authoring-imports",
    setup(builder) {
      builder.onResolve({ filter: /^@opencanon\/core(?:\/testing)?$/ }, () => ({ path: aliases.core }));
      builder.onResolve({ filter: /^@opencanon\/validators$/ }, () => ({ path: aliases.validators }));
      builder.onResolve({ filter: /^@opencanon\/project$/ }, () => ({ path: aliases.project }));
      builder.onResolve({ filter: /^esbuild$/ }, () => ({ path: "esbuild", external: true, sideEffects: false }));
    },
  };
}

export function resolveOpenCanonAuthoringImportAliases(input: ResolveAuthoringImportAliasesInput): AuthoringImportAliases {
  const generatedProject = input.generatedProject ?? path.join(input.rootDir, ProjectTypesFilePath);
  const sourceRoot = input.sourceRootCandidates?.find(hasSourceAuthoringPackages);
  if (sourceRoot) {
    return {
      core: path.join(sourceRoot, "packages/core/src/index.ts"),
      validators: path.join(sourceRoot, "packages/validators/src/index.ts"),
      project: existsSync(generatedProject) ? generatedProject : path.join(sourceRoot, ProjectTypesFilePath),
    };
  }

  return {
    core: resolveAuthoringPackage("OPENCANON_AUTHORING_CORE", "@opencanon/core", "core.js"),
    validators: resolveAuthoringPackage("OPENCANON_AUTHORING_VALIDATORS", "@opencanon/validators", "validators.js"),
    project: resolveAuthoringProject(generatedProject),
  };
}

function hasSourceAuthoringPackages(candidate: string): boolean {
  return existsSync(path.join(candidate, "packages/core/src/index.ts")) && existsSync(path.join(candidate, "packages/validators/src/index.ts"));
}

function resolveAuthoringProject(generatedProject: string): string {
  const explicit = process.env.OPENCANON_AUTHORING_PROJECT;
  if (explicit?.trim()) return path.resolve(explicit);
  return generatedProject;
}

function resolveAuthoringPackage(envName: string, packageName: string, bundledFileName: string): string {
  const explicit = process.env[envName];
  if (explicit?.trim()) return path.resolve(explicit);

  const bundledPath = path.join(path.dirname(fileURLToPath(import.meta.url)), bundledFileName);
  if (existsSync(bundledPath)) return bundledPath;

  try {
    const resolved = createRequire(import.meta.url).resolve(packageName);
    if (existsSync(resolved)) return resolved;
  } catch {
    // Fall through to the targeted error below.
  }

  throw new Error(
    [
      `Could not resolve ${packageName} for OpenCanon convention authoring.`,
      `Set ${envName} to the installed runtime entrypoint, or run through the installed opencanon CLI.`,
    ].join(" "),
  );
}
