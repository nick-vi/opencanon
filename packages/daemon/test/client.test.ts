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
      `export * from ${JSON.stringify(path.join(process.cwd(), "packages/core/src/index.ts"))};`,
      `export { noForbiddenCalls } from ${JSON.stringify(path.join(process.cwd(), "packages/validators/src/index.ts"))};`,
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

test("running daemon reloads validator graph when imported validator modules change", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-daemon-validator-reload-"));
  createStudioProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "validator-helpers"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "validators/index.ts"),
    ["import validator from \"./rules.ts\";", "", "export default validator;", ""].join("\n"),
  );
  writeFileSync(path.join(rootDir, "validators/rules.ts"), ["import { validatorIds } from \"../validator-helpers/rules.ts\";", "", "export default validatorIds.map((id) => ({", "  id,", "  topics: [\"test\"],", "  severity: \"warning\",", "  scope: \"project\",", "  validate() { return []; },", "}));", ""].join("\n"));
  writeFileSync(path.join(rootDir, "validator-helpers/rules.ts"), validatorHelperSource(["first-rule"]));

  try {
    const result = spawnSync("bun", ["-e", daemonValidatorReloadCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("running daemon generates project authoring types on startup and relevant changes", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-daemon-project-types-"));
  createStudioProject(rootDir);
  writeFileSync(
    path.join(rootDir, "opencanon.config.json"),
    JSON.stringify(
      {
        decisionsPath: "docs/decisions.json",
        validatorsPath: "validators/index.ts",
        fixturesDir: "fixtures",
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".opencanon/**"],
      },
      null,
      2,
    ),
  );
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "fixtures/demo"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", name: "demo-app", dependencies: { zod: "^4.0.0" } }, null, 2));
  writeFileSync(
    path.join(rootDir, "fixtures/demo/valid.ts"),
    [
      'import { defineFixture } from "@opencanon/core/testing";',
      'import leftPad from "left-pad";',
      "",
      "void leftPad;",
      "export default defineFixture({});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "validators/index.ts"),
    [
      "export default {",
      "  id: \"conventions\",",
      "  topics: [\"test\"],",
      "  severity: \"warning\",",
      "  scope: \"project\",",
      "  validate() { return []; },",
      "};",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync("bun", ["-e", daemonProjectTypesCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function daemonProjectTypesCheckSource(): string {
  const daemonUrl = pathToFileURL(path.join(process.cwd(), "packages/daemon/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { startOpenCanonDaemon } from ${JSON.stringify(daemonUrl)};

    const rootDir = Bun.argv[1];
    const generatedProject = path.join(rootDir, ".agents/skills/opencanon/generated/project.ts");
    const generatedAliases = path.join(rootDir, ".agents/skills/opencanon/generated/aliases.d.ts");
    const server = await startOpenCanonDaemon({ cwd: rootDir, port: 0, serveUi: false });
    try {
      assert(readFileSync(generatedProject, "utf8").includes('DEMO_APP: "demo-app"'));
      assert(readFileSync(generatedAliases, "utf8").includes('declare module "left-pad"'));
      writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", name: "demo-next", dependencies: { zod: "^4.0.0" } }, null, 2));
      await waitForFileText(generatedProject, (source) => source.includes('DEMO_NEXT: "demo-next"'));
      writeFileSync(path.join(rootDir, "fixtures/demo/valid.ts"), [
        'import { defineFixture } from "@opencanon/core/testing";',
        'import slugify from "slugify";',
        "",
        "void slugify;",
        "export default defineFixture({});",
        "",
      ].join("\\n"));
      await waitForFileText(generatedAliases, (source) => source.includes('declare module "slugify"'));
    } finally {
      await server.stop();
    }

    async function waitForFileText(file, predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (existsSync(file) && predicate(readFileSync(file, "utf8"))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for generated file update: " + file);
    }
  `;
}

function daemonValidatorReloadCheckSource(): string {
  const daemonUrl = pathToFileURL(path.join(process.cwd(), "packages/daemon/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    import { daemonAuthHeaders, startOpenCanonDaemon } from ${JSON.stringify(daemonUrl)};

    const rootDir = Bun.argv[1];
    const server = await startOpenCanonDaemon({ cwd: rootDir, port: 0, serveUi: false });
    try {
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule"]);
      writeFileSync(path.join(rootDir, "validator-helpers/rules.ts"), ${JSON.stringify(validatorHelperSource(["first-rule", "second-rule"]))});
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule", "second-rule"]);
      writeFileSync(path.join(rootDir, "validators/rules.ts"), "export default { id: 1 };\\n");
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule", "second-rule"]);
    } finally {
      await server.stop();
    }

    async function getSnapshotValidatorIds(url, authToken) {
      const response = await fetch(url + "/api/snapshot", { headers: daemonAuthHeaders(authToken) });
      if (response.status !== 200) throw new Error(await response.text());
      const body = await response.json();
      return body.data.validators.map((validator) => validator.id);
    }
  `;
}

function validatorHelperSource(ids: string[]): string {
  return `export const validatorIds = ${JSON.stringify(ids)};\n`;
}

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
