import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { appendOpenCodeFeedback, extractFilesFromPatchText, installHook, inspectHookInstallations, normalizeHookPayload, renderFeedbackMarkdown, renderHookResponse } from "@opencanon/core";
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

test("installs project hook configs idempotently", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-hooks-"));
  try {
    for (const host of ["codex", "claude", "opencode"] as const) {
      const result = installHook({ rootDir, host, scope: "project", dryRun: false });
      assert.equal(result.diagnostics.length, 0);
      assert(result.files.every((file) => file.action === "create"));

      const second = installHook({ rootDir, host, scope: "project", dryRun: false });
      assert.equal(second.diagnostics.length, 0);
      assert(second.files.every((file) => file.action === "unchanged"));
    }

    assert(readFileSync(path.join(rootDir, ".codex/config.toml"), "utf8").includes("codex_hooks = true"));
    assert(readFileSync(path.join(rootDir, ".codex/hooks.json"), "utf8").includes("hook codex"));
    assert(readFileSync(path.join(rootDir, ".claude/settings.json"), "utf8").includes("hook claude"));
    assert(readFileSync(path.join(rootDir, ".opencode/plugins/opencanon.ts"), "utf8").includes(".agents/skills/opencanon/scripts/opencode-plugin.ts"));
    assert.deepEqual(
      inspectHookInstallations(rootDir).map((inspection) => inspection.valid),
      [true, true, true],
    );
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

  assert(output.includes("Run: bun run opencanon validate --files src/a.ts src/b.ts"));
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
