import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DefinitionTargetKind, appendOpenCodeFeedback, claudeHookConfig, codexHookConfig, createHookFeedback, extractFilesFromPatchText, HookFileAction, installHook, inspectHookInstallations, normalizeHookPayload, renderFeedbackMarkdown, renderHookResponse, runFeedback } from "@opencanon/core";
import type { HookFeedback } from "@opencanon/core";

test("extracts apply_patch target files without validating deleted paths", () => {
  const files = extractFilesFromPatchText(`*** Begin Patch
*** Update File: src/api/routes/companies.ts
*** Move to: src/api/routes/company.ts
*** Delete File: src/deleted/company.ts
*** Add File: src/created/company.ts
*** End Patch
`);

  assert.deepEqual(files, ["src/api/routes/companies.ts", "src/created/company.ts", "src/api/routes/company.ts"]);
});

test("normalizes Codex PostToolUse apply_patch payloads", () => {
  const payload = normalizeHookPayload("codex", {
    cwd: "/repo",
    session_id: "session-1",
    turn_id: "turn-1",
    tool_name: "apply_patch",
    tool_input: {
      command: `*** Begin Patch
*** Update File: src/db/dal/company.ts
*** End Patch`,
    },
  });

  assert.deepEqual(payload, {
    cwd: "/repo",
    files: ["src/db/dal/company.ts"],
    sessionId: "session-1",
    turnId: "turn-1",
  });
});

test("normalizes Claude Write and MultiEdit payloads", () => {
  assert.deepEqual(
    normalizeHookPayload("claude", {
      cwd: "/repo",
      session_id: "session-1",
      tool_name: "Write",
      tool_input: { file_path: "/repo/src/contracts/company.ts" },
    }),
    {
      cwd: "/repo",
      files: ["/repo/src/contracts/company.ts"],
      sessionId: "session-1",
      turnId: undefined,
    },
  );

  assert.deepEqual(
    normalizeHookPayload("claude", {
      cwd: "/repo",
      session_id: "session-1",
      tool_name: "MultiEdit",
      tool_input: { file_path: "src/services/company.service.ts", edits: [{ old_string: "a", new_string: "b" }] },
    }).files,
    ["src/services/company.service.ts"],
  );
});

test("normalizes OpenCode edit and apply_patch payloads", () => {
  assert.deepEqual(
    normalizeHookPayload(
      "opencode",
      {
        input: { tool: "edit", callID: "call-1", sessionID: "session-1" },
        output: { args: { filePath: "src/services/company.service.ts" } },
      },
      "/repo",
    ),
    {
      cwd: "/repo",
      files: ["src/services/company.service.ts"],
      sessionId: "session-1",
      turnId: "call-1",
    },
  );

  assert.deepEqual(
    normalizeHookPayload(
      "opencode",
      {
        input: { tool: "apply_patch", callID: "call-2" },
        output: { args: { patchText: "*** Update File: src/db/dal/company.ts\n" } },
      },
      "/repo",
    ).files,
    ["src/db/dal/company.ts"],
  );
});

test("renders host hook feedback in the expected response shape", () => {
  const feedback: HookFeedback = {
    host: "codex",
    cwd: "/repo",
    files: ["src/company.ts"],
    result: {
      host: "codex",
      files: ["src/company.ts"],
      diagnostics: [],
      findingCount: 1,
      suppressedCount: 0,
      findings: [],
    },
    text: "OpenCanon found a convention issue.",
  };

  assert.deepEqual(JSON.parse(renderHookResponse(feedback)), {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "OpenCanon found a convention issue.",
    },
  });

  const output: Record<string, unknown> = { output: "write complete" };
  appendOpenCodeFeedback(output, "OpenCanon feedback");
  assert.equal(output.output, "write complete\n\nOpenCanon feedback");
});

test("hook feedback skips absolute files outside initialized OpenCanon projects", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hook-root-"));
  const externalRoot = mkdtempSync(path.join(tmpdir(), "opencanon-hook-external-"));
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    mkdirSync(path.join(externalRoot, "src"), { recursive: true });
    writeFileSync(path.join(externalRoot, "src", "scratch.ts"), "export const scratch = true;\n");

    const feedback = await createHookFeedback(
      "codex",
      {
        cwd: rootDir,
        tool_input: {
          file_path: path.join(externalRoot, "src", "scratch.ts"),
        },
      },
      rootDir,
    );

    assert.deepEqual(feedback.files, []);
    assert.equal(feedback.text, "");
    assert.equal(feedback.result.findingCount, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("hook feedback keeps current package-only project files scoped to cwd root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hook-package-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src", "current.ts"), "export const current = true;\n");

    const feedback = await createHookFeedback(
      "codex",
      {
        cwd: rootDir,
        tool_input: {
          file_path: path.join(rootDir, "src", "current.ts"),
        },
      },
      rootDir,
    );

    assert.deepEqual(feedback.files, ["src/current.ts"]);
    assert.equal(feedback.result.files[0], "src/current.ts");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("hook feedback scopes absolute files to their owning OpenCanon project", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hook-current-"));
  const externalRoot = mkdtempSync(path.join(tmpdir(), "opencanon-hook-owned-"));
  try {
    writeFileSync(path.join(rootDir, "opencanon.config.json"), "{}\n");
    mkdirSync(path.join(externalRoot, "src"), { recursive: true });
    mkdirSync(path.join(externalRoot, "conventions"), { recursive: true });
    writeFileSync(path.join(externalRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(externalRoot, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: [],
        conventionsPath: "conventions/index.ts",
      }),
    );
    writeFileSync(path.join(externalRoot, "src", "owned.ts"), "export const owned = true;\n");
    writeFileSync(
      path.join(externalRoot, "conventions", "index.ts"),
      `
        export default [];
      `,
    );

    const feedback = await createHookFeedback(
      "codex",
      {
        cwd: rootDir,
        tool_input: {
          file_path: path.join(externalRoot, "src", "owned.ts"),
        },
      },
      rootDir,
    );

    assert.deepEqual(feedback.files, ["src/owned.ts"]);
    assert.equal(feedback.result.files[0], "src/owned.ts");
    assert(!feedback.text.includes("File does not exist."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("installs project hook configs idempotently", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hooks-"));
  try {
    for (const host of ["codex", "claude", "opencode"] as const) {
      const result = installHook({ rootDir, host, scope: "project", dryRun: false });
      assert.equal(result.diagnostics.length, 0);
      assert(result.files.every((file) => file.action === HookFileAction.Create));

      const second = installHook({ rootDir, host, scope: "project", dryRun: false });
      assert.equal(second.diagnostics.length, 0);
      assert(second.files.every((file) => file.action === HookFileAction.Unchanged));
    }

    assert(readFileSync(path.join(rootDir, ".codex/config.toml"), "utf8").includes("codex_hooks = true"));
    assert(readFileSync(path.join(rootDir, ".codex/hooks.json"), "utf8").includes("hook codex"));
    assert(readFileSync(path.join(rootDir, ".claude/settings.json"), "utf8").includes("hook claude"));
    assert(readFileSync(path.join(rootDir, ".opencode/plugins/opencanon.ts"), "utf8").includes('"opencanon", ["hook", "opencode"]'));
    assert.deepEqual(
      inspectHookInstallations(rootDir).map((inspection) => inspection.valid),
      [true, true, true],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("hook install supports machine-readable dry-run output", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hooks-json-"));
  try {
    const cli = path.resolve("packages/cli/src/index.ts");
    const result = spawnSync(process.execPath, [cli, "hook", "install", "codex", "--dry-run", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Array<{ host: string; files: Array<{ path: string; action: string }>; diagnostics: string[] }>;
    assert.equal(payload.length, 1);
    assert.equal(payload[0].host, "codex");
    assert(payload[0].files.some((file) => file.action === "create"));
    assert.deepEqual(payload[0].diagnostics, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("feedback markdown groups findings and respects output budget", () => {
  const output = renderFeedbackMarkdown(
    {
      host: "manual",
      files: ["src/a.ts", "src/b.ts"],
      diagnostics: [],
      findingCount: 3,
      suppressedCount: 0,
      findings: [
        { validatorId: "one", severity: "error", file: "src/a.ts", line: 1, message: "first" },
        { validatorId: "two", severity: "warning", file: "src/a.ts", line: 2, message: "second" },
        { validatorId: "three", severity: "warning", file: "src/b.ts", line: 3, message: "third" },
      ],
    },
    { maxFindings: 2, maxChars: 1000 },
  );

  assert(output.includes("Run: opencanon validate --files src/a.ts src/b.ts"));
  assert(output.includes("## src/a.ts"));
  assert(output.includes("1 more finding(s)"));
  assert(output.includes("Finding Resolution Policy"));

  const truncated = renderFeedbackMarkdown(
    {
      host: "manual",
      files: ["src/a.ts"],
      diagnostics: [],
      findingCount: 1,
      suppressedCount: 0,
      findings: [{ validatorId: "one", severity: "error", file: "src/a.ts", line: 1, message: "x".repeat(2000) }],
    },
    { maxChars: 400 },
  );
  assert(truncated.includes("Output truncated."));
});

test("feedback auto-loads governing conventions and renders advisory-only missing convention prompts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-feedback-conventions-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: [],
        conventionsPath: "conventions/index.ts",
        impactSurfacesPath: "impact-surfaces.json",
      }),
    );
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
    writeFileSync(path.join(rootDir, "src/unknown.ts"), "export const unknown = true;\n");
    writeFileSync(
      path.join(rootDir, "conventions/index.ts"),
      `
        import { defineConvention } from "@opencanon/core";

        export default defineConvention({
          id: "company-shape",
          title: "Company Shape",
          rule: "Company code keeps the approved shape.",
          applies: { kind: "files", globs: ["src/company.ts"] },
          render: { kind: "none" },
          runtime: { kind: "none" },
        });
      `,
    );

    const loaded = await runFeedback({ cwd: rootDir, files: ["src/company.ts"], host: "manual", dedupeScope: "off" });
    assert.equal(loaded.governingConventions?.conventions[0]?.id, "company-shape");
    assert.equal(loaded.advisories?.length, 0);
    const loadedMarkdown = renderFeedbackMarkdown(loaded, { emptyMessage: true });
    assert(loadedMarkdown.includes("Relevant Conventions:"));
    assert(loadedMarkdown.includes("company-shape: Company Shape"));

    const advisory = await runFeedback({ cwd: rootDir, files: ["src/unknown.ts"], host: "manual", dedupeScope: "off" });
    assert.equal(advisory.findingCount, 0);
    assert.equal(advisory.advisories?.[0]?.title, "Missing convention?");
    assert.equal(advisory.diagnostics.length, 0);
    assert(renderFeedbackMarkdown(advisory, { emptyMessage: true }).includes("This is advisory only; it does not block commits or CI."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("feedback --changed succeeds with empty feedback when no files changed", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-feedback-empty-"));
  try {
    const gitInit = spawnSync("git", ["init", "--initial-branch", "main"], { cwd: rootDir, encoding: "utf8" });
    assert.equal(gitInit.status, 0, gitInit.stderr);
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "packages/cli/src/index.ts"), "feedback", "--changed", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      files: string[];
      diagnostics: string[];
      findingCount: number;
      suppressedCount: number;
      findings: unknown[];
    };
    assert.deepEqual(payload.files, []);
    assert.deepEqual(payload.diagnostics, []);
    assert.equal(payload.findingCount, 0);
    assert.equal(payload.suppressedCount, 0);
    assert.deepEqual(payload.findings, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("feedback includes related change context and scope drift", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-feedback-change-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "areas"), { recursive: true });
    mkdirSync(path.join(rootDir, "changes"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: [],
        conventionsPath: "conventions/index.ts",
        areasPath: "areas/index.ts",
        changesPath: "changes/index.ts",
        impactSurfacesPath: "impact-surfaces.json",
      }),
    );
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
    writeFileSync(path.join(rootDir, "src/outside.ts"), "export const outside = true;\n");
    writeFileSync(
      path.join(rootDir, "impact-surfaces.json"),
      JSON.stringify([
        {
          id: "company-surface",
          title: "Company Surface",
          applies: ["src/company.ts"],
          risks: ["customer-visible-data"],
          proposed: true,
        },
      ]),
    );
    writeFileSync(
      path.join(rootDir, "conventions/index.ts"),
      `
        import { defineConvention } from "@opencanon/core";

        export default defineConvention({
          id: "company-shape",
          title: "Company Shape",
          rule: "Company code keeps the approved shape.",
          applies: { kind: "files", globs: ["src/company.ts"] },
          render: { kind: "none" },
          runtime: { kind: "none" },
        });
      `,
    );
    writeFileSync(
      path.join(rootDir, "areas/index.ts"),
      `
        import { defineArea } from "@opencanon/core";

        export default defineArea({
          id: "company-profile",
          title: "Company Profile",
          summary: "Company profile data is available to product surfaces.",
          surfaces: ["company-surface"],
          owns: [{ kind: "${DefinitionTargetKind.File}", path: "src/company.ts" }],
          render: { kind: "none" },
        });
      `,
    );
    writeFileSync(
      path.join(rootDir, "changes/index.ts"),
      `
        import { defineChange } from "@opencanon/core";

        export default defineChange({
          id: "add-company-profile",
          title: "Add Company Profile",
          kind: "feature",
          summary: "Add the company profile behavior.",
          updates: { areas: ["company-profile"], surfaces: ["company-surface"] },
          scope: [{ kind: "${DefinitionTargetKind.File}", path: "src/company.ts" }],
          intent: { problem: "No company profile.", outcome: "Company profile exists." },
          render: { kind: "none" },
        });
      `,
    );

    const covered = await runFeedback({ cwd: rootDir, files: ["src/company.ts"], host: "manual", dedupeScope: "off" });
    assert.deepEqual(covered.change?.impactedSurfaces.map((surface) => surface.id), ["company-surface"]);
    assert.deepEqual(covered.change?.areas.map((area) => area.id), ["company-profile"]);
    assert.deepEqual(covered.change?.changes.map((change) => change.id), ["add-company-profile"]);
    assert.equal(covered.change?.scopeDrift, undefined);
    const coveredMarkdown = renderFeedbackMarkdown(covered, { emptyMessage: true });
    assert(coveredMarkdown.includes("Change Context:"));
    assert(coveredMarkdown.includes("Related Changes:"));
    assert(coveredMarkdown.includes("Affected Areas:"));

    const drift = await runFeedback({ cwd: rootDir, files: ["src/outside.ts"], host: "manual", dedupeScope: "off" });
    assert.deepEqual(drift.change?.scopeDrift?.files, ["src/outside.ts"]);
    const driftMarkdown = renderFeedbackMarkdown(drift, { emptyMessage: true });
    assert(driftMarkdown.includes("Scope Drift:"));
    assert(driftMarkdown.includes("outside the scope of every committed change definition"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("generated hook commands invoke installed opencanon, not project runtime", () => {
  for (const config of [codexHookConfig(), claudeHookConfig()]) {
    assert(config.hook.command.startsWith("opencanon hook "), `hook command must call installed opencanon: ${config.hook.command}`);
    assert(!config.hook.command.includes("bun "), `hook command must not invoke bun: ${config.hook.command}`);
    assert(!config.hook.command.includes("opencanon.mjs"));
  }
});
