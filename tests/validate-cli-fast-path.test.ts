import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");
const validateSpawnTimeoutMs = 20_000;

test("validate --files returns without starting runtime when no selected validator can target the files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validate-no-runtime-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/specs"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "opencanon/areas/index.ts"), "export default [];\n");
    writeFileSync(path.join(rootDir, "opencanon/specs/index.ts"), "export default [];\n");
    writeFileSync(path.join(rootDir, "opencanon/changes/index.ts"), "export default [];\n");
    writeFileSync(
      path.join(rootDir, "opencanon/conventions/index.ts"),
      [
        'import { defineConvention } from "@opencanon/core";',
        "",
        "export default defineConvention({",
        '  id: "source-only-rule",',
        '  title: "Source Only Rule",',
        '  topics: ["test"],',
        '  rule: "Only source files are validated.",',
        '  applies: { kind: "files", globs: ["src/**/*.ts"] },',
        '  render: { kind: "none" },',
        "  runtime: {",
        '    kind: "validator",',
        '    severity: "error",',
        '    scope: "file",',
        "    facts: [],",
        "    validate() {",
        "      return [];",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [script, "validate", "--files", "package.json", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: validateSpawnTimeoutMs,
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      files: string[];
      validators: string[];
      findings: unknown[];
      findingCount: number;
    };
    assert.deepEqual(payload.files, ["package.json"]);
    assert.deepEqual(payload.validators, ["source-only-rule"]);
    assert.equal(payload.findingCount, 0);
    assert.deepEqual(payload.findings, []);
    assert.equal(existsSync(path.join(rootDir, ".opencanon/runtime.json")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
