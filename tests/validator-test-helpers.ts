import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  applyDoctorFixes,
  applyFindingFixes,
  BatchProducerPolicy,
  buildDoctorReport,
  createCommitApprovalContext,
  createCommitApprovalRecord,
  createConventionFactory,
  createPaths,
  createRuntime,
  createValidationContext,
  createValidationResultCache,
  defineArea,
  defineConvention,
  discoverProjectFiles,
  DoctorStatus,
  FixModeValue,
  flushValidationContextCache,
  generateProjectTypes,
  getChangedFiles,
  InteractiveProducerPolicy,
  LiteralContext,
  LiteralValueKind,
  loadCommitApprovalsWithDiagnostics,
  OpenCanonSkillFilePath,
  pickAuthoritativeStatus,
  ProjectTypesFilePath,
  renderOpenCanonAgentEntryBlock,
  resolveCommitGates,
  resolveValidators,
  runValidation,
  savePendingCommitGates,
  toPendingCommitGates,
  upsertCommitApproval,
  validateConfig,
  validateContext,
  validateValidatorDefinitions,
  validatorGraphHash,
  ValidatorOutcomeStatus,
  conventionToValidator,
} from "@opencanon/core";
import type { Convention } from "@opencanon/core";
import type { ValidatorDefinition } from "../packages/core/src/validator-types.ts";
import {
  externalCommand,
  externalDiagnostics,
  migrationReferences,
  noBypassComments,
  noHardcodedConfigValues,
  noHeaderComments,
  noSecretLikeLiterals,
  noUnusedExports,
  repeatedLiterals,
  requireExportPattern,
  requiredFileSibling,
  requiredFunctionParam,
  restrictedSymbols,
  similarFunctionNames,
} from "@opencanon/validators";

export {
  assert,
  spawnSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  tmpdir,
  path,
  test,
  applyDoctorFixes,
  applyFindingFixes,
  BatchProducerPolicy,
  buildDoctorReport,
  createCommitApprovalContext,
  createCommitApprovalRecord,
  createConventionFactory,
  createPaths,
  createRuntime,
  createValidationContext,
  createValidationResultCache,
  defineArea,
  defineConvention,
  discoverProjectFiles,
  DoctorStatus,
  FixModeValue,
  flushValidationContextCache,
  generateProjectTypes,
  getChangedFiles,
  InteractiveProducerPolicy,
  LiteralContext,
  LiteralValueKind,
  loadCommitApprovalsWithDiagnostics,
  OpenCanonSkillFilePath,
  pickAuthoritativeStatus,
  ProjectTypesFilePath,
  renderOpenCanonAgentEntryBlock,
  resolveCommitGates,
  resolveValidators,
  runValidation,
  savePendingCommitGates,
  toPendingCommitGates,
  upsertCommitApproval,
  validateConfig,
  validateContext,
  validateValidatorDefinitions,
  validatorGraphHash,
  ValidatorOutcomeStatus,
  externalCommand,
  externalDiagnostics,
  migrationReferences,
  noBypassComments,
  noHardcodedConfigValues,
  noHeaderComments,
  noSecretLikeLiterals,
  noUnusedExports,
  repeatedLiterals,
  requireExportPattern,
  requiredFileSibling,
  requiredFunctionParam,
  restrictedSymbols,
  similarFunctionNames,
};
export type { Convention, ValidatorDefinition };

export function createHashHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function linkWorkspaceTypeScript(rootDir: string): string {
  const source = path.resolve("node_modules/typescript");
  const target = path.join(rootDir, "node_modules/typescript");
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    symlinkSync(source, target, "dir");
  } catch {
    cpSync(source, target, { recursive: true });
  }
  try {
    return JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")).version as string;
  } catch (error) {
    throw new Error(`Could not read linked TypeScript package metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveTestValidators(input: unknown) {
  const normalize = (value: unknown) => (isConvention(value) ? conventionToValidator(value) : value);
  return resolveValidators(Array.isArray(input) ? input.map(normalize).filter(Boolean) : normalize(input));
}

function isConvention(value: unknown): value is Convention {
  return Boolean(value && typeof value === "object" && "applies" in value && "render" in value && "runtime" in value);
}

export function testValidatorDefinition(definition: ValidatorDefinition): ValidatorDefinition {
  return definition;
}

export function isolatedCliEnv(rootDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(rootDir, "global", "service.json");
  return env;
}

export function stopIsolatedCliRuntime(rootDir: string): void {
  const script = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = isolatedCliEnv(rootDir);
  for (const args of [
    ["project", "stop", "--format", "json"],
    ["service", "stop", "--format", "json"],
  ]) {
    spawnSync(process.execPath, [script, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
  }
}

export function initGitRepo(rootDir: string): void {
  for (const args of [
    ["init"],
    ["config", "user.email", "opencanon@example.com"],
    ["config", "user.name", "OpenCanon Test"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) {
    const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

export function git(rootDir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
