import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const cli = path.join(process.cwd(), "packages/cli/src/index.ts");

type CliRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], cwd: string): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("bundle commands resolve typed options into plans and dry-run installs", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-bundle-"));
  const bundlePath = path.join(rootDir, "opencanon.bundle.ts");
  const planPath = "tmp/bundle-plan.md";
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      bundlePath,
      `export default {
  id: "project-rules",
  description: "Project rule bundle.",
  topics: ["project"],
  validators: [],
  options: {
    sourceRoot: { type: "string", default: "src" },
    strictness: { type: "enum", values: ["advisory", "strict"], default: "advisory" }
  },
  docs: [{
    path: "docs/opencanon/canon/project.md",
    heading: "Project Rules",
    body: "Source root: {{sourceRoot}}. Strictness: {{strictness}}."
  }],
  decisions: [{
    id: "project-rules-current",
    date: "2026-05-18",
    status: "current",
    title: "Project rules are explicit",
    topics: ["project"],
    applies: ["{{sourceRoot}}/**"],
    summary: "Project rules are installed from a bundle.",
    rationale: ["Agents need local rules."],
    required: ["Use {{sourceRoot}} for source code."],
    replaced: [],
    agentPolicy: ["Follow the installed project rules."],
    exceptions: [],
    docs: ["docs/opencanon/canon/project.md#project-rules"],
    validatorIds: []
  }],
  files: [{
    path: ".agents/skills/opencanon/fixtures/project-rules/README.md",
    content: "strictness={{strictness}}\\n"
  }],
  impactSurfaces: [],
  externalTools: {}
};\n`,
    );

    const inspect = spawnSync("bun", [cli, "bundle", "inspect", bundlePath, "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout) as { id: string; options: Record<string, unknown> };
    assert.equal(inspected.id, "project-rules");
    assert("sourceRoot" in inspected.options);

    const plan = spawnSync("bun", [cli, "bundle", "plan", bundlePath, "--option", "sourceRoot=app", "--option", "strictness=strict", "--out", planPath], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    assert(plan.stdout.includes("sourceRoot: app"));
    assert(plan.stdout.includes("docs/opencanon/canon/project.md#project-rules"));
    assert.equal(existsSync(path.join(rootDir, planPath)), true);
    assert(readFileSync(path.join(rootDir, planPath), "utf8").includes("strictness: strict"));

    const install = spawnSync(
      "bun",
      [cli, "bundle", "install", bundlePath, "--dry-run", "--format", "json", "--option", "sourceRoot=app", "--option", "strictness=strict", "--plan", planPath],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const installed = JSON.parse(install.stdout) as { bundleId: string; dryRun: boolean; options: Record<string, string>; files: Array<{ path: string }> };
    assert.equal(installed.bundleId, "project-rules");
    assert.equal(installed.dryRun, true);
    assert.equal(installed.options.sourceRoot, "app");
    assert(installed.files.some((file) => file.path === "docs/opencanon/decisions.json"));
    assert(installed.files.some((file) => file.path === "docs/opencanon/canon/project.md"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bundle install wires installed validator modules into validators index", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-bundle-wire-"));
  const bundlePath = path.join(rootDir, "opencanon.bundle.json");
  try {
    mkdirSync(path.join(rootDir, ".agents/skills/opencanon/validators"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, ".agents/skills/opencanon/validators/index.ts"), "export default [];\n");
    writeFileSync(
      bundlePath,
      JSON.stringify({
        id: "wired-rules",
        topics: ["project"],
        validators: ["wired-validator"],
        docs: [],
        decisions: [],
        impactSurfaces: [],
        externalTools: {},
        files: [
          {
            path: ".agents/skills/opencanon/validators/wired-validator.ts",
            content: "export default { id: 'wired-validator', topics: ['project'], severity: 'warning', scope: 'project', validate() { return []; } };\n",
          },
        ],
      }),
    );

    const install = spawnSync("bun", [cli, "bundle", "install", bundlePath, "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const installed = JSON.parse(install.stdout) as { files: Array<{ path: string; action: string }>; diagnostics: string[] };
    assert.equal(installed.diagnostics.length, 0);
    assert(installed.files.some((file) => file.path === ".agents/skills/opencanon/validators/index.ts" && file.action === "update"));

    const index = readFileSync(path.join(rootDir, ".agents/skills/opencanon/validators/index.ts"), "utf8");
    assert(index.includes('import wiredValidatorValidator from "./wired-validator.ts";'));
    assert(index.includes("const opencanonBundleValidators = (value) => Array.isArray(value) ? value : [value];"));
    assert(index.includes("export default [...opencanonBundleValidators(wiredValidatorValidator)];"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bundle commands load pinned remote JSON bundles without executing remote TypeScript", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-remote-bundle-"));
  const remoteBundle = JSON.stringify({
    id: "remote-rules",
    description: "Remote rule bundle.",
    topics: ["project"],
    validators: [],
    options: {
      sourceRoot: { type: "string", default: "src" },
    },
    docs: [
      {
        path: "docs/opencanon/canon/remote.md",
        heading: "Remote Rules",
        body: "Source root: {{sourceRoot}}.",
      },
    ],
    decisions: [],
    files: [],
    impactSurfaces: [],
    externalTools: {},
  });
  const sha256 = createHash("sha256").update(remoteBundle).digest("hex");
  const server = createServer((request, response) => {
    if (request.url === "/bundle.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(remoteBundle);
      return;
    }
    if (request.url === "/bundle.ts") {
      response.writeHead(200, { "content-type": "text/typescript" });
      response.end("export default {};");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const inspect = await runCli(["bundle", "inspect", `${origin}/bundle.json`, "--sha256", sha256, "--format", "json"], rootDir);
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout) as { id: string; installables: { docs: string[] } };
    assert.equal(inspected.id, "remote-rules");
    assert.deepEqual(inspected.installables.docs, ["docs/opencanon/canon/remote.md#remote-rules"]);

    const plan = await runCli(["bundle", "plan", `${origin}/bundle.json`, "--sha256", sha256, "--option", "sourceRoot=app"], rootDir);
    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    assert(plan.stdout.includes("sourceRoot: app"));

    const missingHash = await runCli(["bundle", "inspect", `${origin}/bundle.json`], rootDir);
    assert.notEqual(missingHash.status, 0);
    assert((missingHash.stderr || missingHash.stdout).includes("Remote bundles require --sha256."));

    const remoteTypeScript = await runCli(["bundle", "inspect", `${origin}/bundle.ts`, "--sha256", sha256], rootDir);
    assert.notEqual(remoteTypeScript.status, 0);
    assert((remoteTypeScript.stderr || remoteTypeScript.stdout).includes("Remote bundles must be JSON data files."));
  } finally {
    server.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bundle install rejects unsafe bundle-owned file targets", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-unsafe-bundle-"));
  const bundlePath = path.join(rootDir, "opencanon.bundle.json");
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      bundlePath,
      JSON.stringify({
        id: "unsafe-rules",
        topics: ["project"],
        validators: [],
        docs: [],
        decisions: [],
        files: [{ path: "{{target}}", content: "{}\n" }],
        impactSurfaces: [],
        externalTools: {},
        options: {
          target: { type: "string", default: "package.json" },
        },
      }),
    );

    const install = spawnSync("bun", [cli, "bundle", "install", bundlePath, "--dry-run", "--option", "target=.opencanon/state.json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.notEqual(install.status, 0);
    assert((install.stderr || install.stdout).includes("Bundle file target is not allowed"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("security hardcoding example bundle is inspectable", () => {
  const list = spawnSync("bun", [cli, "bundle", "list", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const listed = JSON.parse(list.stdout) as { bundles: Array<{ id: string; ref: string }> };
  assert(listed.bundles.some((bundle) => bundle.id === "dry-graph" && bundle.ref === "examples/bundles/dry-graph.bundle.ts"));
  assert(listed.bundles.some((bundle) => bundle.id === "migration-control" && bundle.ref === "examples/bundles/migration-control.bundle.ts"));
  assert(listed.bundles.some((bundle) => bundle.id === "security-hardcoding" && bundle.ref === "examples/bundles/security-hardcoding.bundle.ts"));

  const inspect = spawnSync("bun", [cli, "bundle", "inspect", "examples/bundles/security-hardcoding.bundle.ts", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
  const inspected = JSON.parse(inspect.stdout) as { id: string; validators: string[]; installables: { docs: string[] } };
  assert.equal(inspected.id, "security-hardcoding");
  assert.deepEqual(inspected.validators, ["no-secret-like-literals", "no-hardcoded-config-values"]);
  assert.deepEqual(inspected.installables.docs, ["docs/opencanon/canon/security.md#hardcoded-secrets-and-config"]);
});

test("migration and dry example bundles are inspectable", () => {
  for (const [bundleRef, expectedId] of [
    ["examples/bundles/migration-control.bundle.ts", "migration-control"],
    ["examples/bundles/dry-graph.bundle.ts", "dry-graph"],
  ] as const) {
    const inspect = spawnSync("bun", [cli, "bundle", "inspect", bundleRef, "--format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout) as { id: string; installables: { docs: string[]; files: string[] } };
    assert.equal(inspected.id, expectedId);
    assert(inspected.installables.docs.length > 0);
    assert(inspected.installables.files.some((file) => file.includes(".agents/skills/opencanon/validators/")));
  }
});
