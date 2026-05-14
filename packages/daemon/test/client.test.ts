import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { inspectProjectDaemon } from "@opencanon/daemon";
import { createStudioProject } from "./support.ts";

test("daemon client uses an unregistered ephemeral daemon when no supervised daemon is running", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-ephemeral-client-"));
  createStudioProject(rootDir);
  writeFileSync(
    path.join(rootDir, ".agents/skills/opencanon/index.ts"),
    [
      `export { defineValidator } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "packages/core/src/index.ts")).href)};`,
      `export { noForbiddenCalls } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "packages/validators/src/index.ts")).href)};`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "validators/index.ts"),
    [
      "import { defineValidator } from \"../.agents/skills/opencanon/index.ts\";",
      "",
      "export default defineValidator({",
      "  id: \"test-rule\",",
      "  topics: [\"test\"],",
      "  severity: \"warning\",",
      "  scope: \"project\",",
      "  applies: [\"src/**/*.ts\"],",
      "  decisionIds: [\"test-decision\"],",
      "  docs: [\"docs/decisions.json#test-decision\"],",
      "  validate() {",
      "    return [];",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "docs/decisions.json"),
    JSON.stringify(
      [
        {
          id: "test-decision",
          date: "2026-05-10",
          status: "current",
          title: "Test decision",
          topics: ["test"],
          applies: ["src/**/*.ts"],
          summary: "Test files use the test rule.",
          validatorIds: ["test-rule"],
          docs: ["docs/canon.md#test"],
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(rootDir, "docs/canon.md"),
    ["# Canon", "", "## Test", "", "Test files use the test rule.", ""].join("\n"),
  );
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    assert.equal(await inspectProjectDaemon(rootDir), undefined);
    const result = spawnSync("bun", ["-e", ephemeralDaemonClientCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const output = JSON.parse(result.stdout.trim()) as { files: string[]; relatedDecisionIds: string[]; relatedValidatorIds: string[]; registered: boolean; projectState: boolean };
    assert.deepEqual(output.files, ["src/company.ts"]);
    assert.deepEqual(output.relatedDecisionIds, ["test-decision"]);
    assert.deepEqual(output.relatedValidatorIds, ["test-rule"]);
    assert.equal(output.registered, false);
    assert.equal(output.projectState, false);
    assert.equal(await inspectProjectDaemon(rootDir), undefined);
    assert.equal(existsSync(path.join(rootDir, ".opencanon", "state.sqlite")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function ephemeralDaemonClientCheckSource(): string {
  const daemonClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/daemon-client.ts")).href;
  const daemonUrl = pathToFileURL(path.join(process.cwd(), "packages/daemon/src/index.ts")).href;
  return `
    import { existsSync } from "node:fs";
    import path from "node:path";
    import { DaemonApiRoute, withDaemonClient } from ${JSON.stringify(daemonClientUrl)};
    import { inspectProjectDaemon, projectDaemonPath } from ${JSON.stringify(daemonUrl)};

    const rootDir = Bun.argv[1];
    if (await inspectProjectDaemon(rootDir)) throw new Error("expected no daemon before request");
    const files = await withDaemonClient(rootDir, async (client) => {
      const snapshot = await client.get(DaemonApiRoute.Snapshot);
      const related = await client.get(DaemonApiRoute.CanonRelated + "?file=" + encodeURIComponent("src/company.ts"));
      if (existsSync(projectDaemonPath(rootDir))) throw new Error("ephemeral daemon registered project daemon file");
      return { snapshotFiles: snapshot.files, related };
    });
    console.log(JSON.stringify({
      files: files.snapshotFiles,
      relatedDecisionIds: files.related.decisions.map((decision) => decision.id),
      relatedValidatorIds: files.related.validators.map((validator) => validator.id),
      registered: Boolean(await inspectProjectDaemon(rootDir)),
      projectState: existsSync(path.join(rootDir, ".opencanon", "state.sqlite")),
    }));
  `;
}
