import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { readProjectSettings, writeProjectSettings } from "../src/settings.ts";

test("daemon project settings read and write opencanon config", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-settings-"));

  try {
    const initial = readProjectSettings(rootDir);
    assert.equal(initial.hasConfig, false);
    assert.equal(initial.effective.fileDiscovery, "filesystem");

    const result = writeProjectSettings(rootDir, {
      overrides: {
        fileDiscovery: "filesystem",
        maxFiles: 42,
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**"],
        externalTools: {
          "demo-lint": {
            command: ["bun", "tools/demo-lint.ts"],
            versionArgs: ["--version"],
            missingSeverity: "warning",
          },
        },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.settings.hasConfig, true);
    assert.equal(result.settings.effective.maxFiles, 42);
    const saved = JSON.parse(readFileSync(path.join(rootDir, "opencanon.config.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.projectFilePatterns, ["src/**/*.ts"]);
    assert.equal(saved.fileDiscovery, "filesystem");
    assert.deepEqual(saved.externalTools, {
      "demo-lint": {
        command: ["bun", "tools/demo-lint.ts"],
        versionArgs: ["--version"],
        missingSeverity: "warning",
      },
    });

    const invalid = writeProjectSettings(rootDir, { overrides: { legacyMode: true } });
    assert.equal(invalid.ok, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
