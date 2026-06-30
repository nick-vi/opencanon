import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setProjectAstFactsProviderFactory, DiagnosticSeverity } from "@opencanon/core";
import { createCliAstFactsProvider } from "@opencanon/runtime";
import { createProjectFile } from "../packages/core/src/project-files.ts";

const validator = { id: "ast-facts-test", severity: "warning" as const };

/** TS fact access has NO regex fallback — it throws without an installed provider. */
test("TypeScript fact access throws when no AST provider is installed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ast-noprov-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.ts"), "import { x } from './b';\n");
  setProjectAstFactsProviderFactory(undefined); // clear the vitest-global provider
  try {
    const pf = createProjectFile({ rootDir: root, file: "src/a.ts", validator });
    assert.throws(() => pf.ts.imports(), /ProjectAstFactsProvider/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The runtime provider's engine->TS normalization carries the AST-specific fields
 * (covered in Rust extractor tests, but the TS mapping was untested). */
test("engine provider normalizes AST-specific TS facts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ast-norm-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/m.ts"),
    [
      "export { a as b } from './x';",
      "export * from './y';",
      "export const Mode = { On: 'on', Off: 'off' } as const;",
      "enum Color { Red = 'red', Blue = 'blue' }",
      "function f(s: string) {",
      "  try { return JSON.parse(readFileSync(s)); } catch { return null; }",
      "}",
    ].join("\n"),
  );
  try {
    const pf = createProjectFile({ rootDir: root, file: "src/m.ts", validator });

    const exports = pf.ts.exports();
    assert.equal(exports.find((e) => e.name === "b")?.kind, "reexport", "named re-export → kind reexport");
    assert.ok(exports.map((e) => e.kind).includes("star-reexport"), "export * → kind star-reexport");

    const color = pf.ts.declarations().find((d) => d.name === "Color");
    assert.equal(color?.kind, "enum", "Color declared as enum");
    assert.equal((color as { members?: unknown[] }).members?.length, 2, "enum members populated");

    const parse = pf.ts.calls().find((c) => c.callee === "JSON.parse");
    assert.equal(parse?.tryDepth, 1, "JSON.parse inside one try body → tryDepth 1");
    assert.ok(parse?.argumentCalls?.some((a) => a.name === "readFileSync"), "argumentCalls capture the file read");

    assert.ok(
      pf.ts.literals().some((l) => l.value === "on" && l.declarationSourceId === "Mode"),
      "const-object member literal carries declarationSourceId",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A file the extractor cannot parse surfaces a parse diagnostic — it must NOT be
 * silently reported as clean (no regex degrade, no empty-facts-and-move-on). */
test("malformed source surfaces a parse diagnostic", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ast-bad-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/broken.py"), "def f(:\n    return 1\n");
  try {
    const pf = createProjectFile({ rootDir: root, file: "src/broken.py", validator });
    const diagnostics = pf.diagnostics();
    assert.ok(diagnostics.length > 0, "broken Python yields at least one diagnostic");
    assert.ok(
      diagnostics.some((d) => d.severity === DiagnosticSeverity.Error),
      "the syntax error is reported at error severity, not swallowed",
    );
    assert.equal(diagnostics[0]?.file, "src/broken.py");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Svelte facts come from the engine's SvelteExtractor: the provider receives the
 * .svelte file and returns merged <script> facts in host coordinates, reachable
 * through the normal file.ts.* accessors. */
test("Svelte script facts come through the engine provider", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ast-svelte-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/Comp.svelte"),
    [
      `<script context="module" lang="ts">export const TITLE = "hi";</script>`,
      `<div>{value}</div>`,
      `<script lang="ts">`,
      `  import { onMount } from "svelte";`,
      `  function greet() { return TITLE; }`,
      `</script>`,
    ].join("\n"),
  );
  try {
    const pf = createProjectFile({ rootDir: root, file: "src/Comp.svelte", validator });

    // Instance-script import, offset to its real file line (line 4).
    const onMount = pf.ts.imports().find((i) => i.source === "svelte");
    assert.ok(onMount, "import from the instance <script> is extracted");
    assert.equal(onMount?.line, 4, "fact line is in host (.svelte) coordinates, not script-local");

    // Symbols from both module and instance scripts are merged.
    const names = pf.ts.functions().map((f) => f.name);
    assert.ok(names.includes("greet"), "instance-script function is present");
    assert.ok(
      pf.ts.exports().some((e) => e.name === "TITLE"),
      "module-script export is present in the merged facts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
