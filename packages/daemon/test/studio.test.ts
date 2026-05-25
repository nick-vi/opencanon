import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { applyStudioValidator, listStudioFactories, listStudioValidators, previewStudioValidator, runStudioValidatorFixtures } from "../src/studio.ts";
import { createStudioProject } from "./support.ts";

test("validator studio previews, runs fixtures, and applies generated validators", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-studio-"));
  createStudioProject(rootDir);
  const request = {
    factoryId: "noForbiddenCalls",
    options: {
      id: "no-eval-calls",
      topics: ["hygiene"],
      severity: "warning",
      in: ["src/**/*.ts"],
      calls: ["eval\\("],
      message: "Do not call eval.",
      fixDescription: "Replace eval with a typed parser or explicit dispatch.",
    },
    fixtures: {
      valid: [{ path: "src/example.ts", content: "export const run = (input: string) => input.trim();\n" }],
      invalid: [{ path: "src/example.ts", content: "export const run = (input: string) => eval(input);\n" }],
    },
  };

  try {
    const factoryIds = new Set(listStudioFactories().map((factory) => factory.id));
    assert(factoryIds.has("noForbiddenCalls"));
    assert(factoryIds.has("noHeaderComments"));
    assert(factoryIds.has("noBypassComments"));
    const preview = previewStudioValidator(rootDir, request);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.preview.validatorPath, "validators/no-eval-calls.ts");
    assert(preview.preview.source.includes("noForbiddenCalls"));

    const run = await runStudioValidatorFixtures(rootDir, request);
    assert.equal(run.ok, true);
    if (!run.ok) return;
    assert.equal(run.run.passed, true);

    const apply = await applyStudioValidator(rootDir, request);
    assert.equal(apply.ok, true);
    assert(existsSync(path.join(rootDir, "validators/no-eval-calls.ts")));
    assert(existsSync(path.join(rootDir, "fixtures/no-eval-calls/invalid.ts")));
    assert(readFileSync(path.join(rootDir, "validators/index.ts"), "utf8").includes("noEvalCalls"));

    const validators = await listStudioValidators(rootDir);
    assert(validators.some((validator) => validator.id === "no-eval-calls"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
