import { test } from "vitest";
import assert from "node:assert/strict";
import { descriptorForExtension, languageDescriptor, namingIdiom, usesProperParser, ProjectFileLanguage } from "@opencanon/core";

test("registry classifies files by extension", () => {
  assert.equal(descriptorForExtension(".ts").id, ProjectFileLanguage.TypeScript);
  assert.equal(descriptorForExtension(".tsx").id, ProjectFileLanguage.TypeScript);
  assert.equal(descriptorForExtension(".svelte").id, ProjectFileLanguage.Svelte);
  assert.equal(descriptorForExtension(".py").id, ProjectFileLanguage.Python);
  assert.equal(descriptorForExtension(".md").id, ProjectFileLanguage.Markdown);
  assert.equal(descriptorForExtension(".unknownext").id, ProjectFileLanguage.Text);
});

test("registry honestly reports which languages use a proper parser", () => {
  // The whole point: 'is language X on a real parser?' is a queryable fact.
  assert.equal(usesProperParser(ProjectFileLanguage.TypeScript), true, "TS = oxc AST");
  assert.equal(usesProperParser(ProjectFileLanguage.Svelte), true, "Svelte = oxc AST");
  assert.equal(usesProperParser(ProjectFileLanguage.Python), true, "Python = rustpython AST");
  assert.equal(languageDescriptor(ProjectFileLanguage.TypeScript).facts.extractor, "oxc");
  assert.equal(languageDescriptor(ProjectFileLanguage.Svelte).facts.extractor, "oxc");
  assert.equal(languageDescriptor(ProjectFileLanguage.Python).facts.extractor, "rustpython");
});

test("registry distinguishes extractor-emitted facts from core-derived ones", () => {
  // Honesty: references/annotations/duplicates are NOT emitted by the oxc extractor —
  // core derives them from the base facts. `coverage` lists API availability;
  // `derived` flags the ones the extractor does not itself produce.
  const ts = languageDescriptor(ProjectFileLanguage.TypeScript);
  assert.deepEqual(ts.facts.derived, ["references", "annotations", "duplicates"]);
  for (const kind of ts.facts.derived ?? []) {
    assert.equal(ts.facts.coverage[kind], "full", `${kind} is still available via the facts API`);
  }
  // Python advertises only what rustpython truly emits — no derived overclaim.
  assert.equal(languageDescriptor(ProjectFileLanguage.Python).facts.derived, undefined);
});

test("registry carries language capability metadata", () => {
  assert.equal(languageDescriptor(ProjectFileLanguage.TypeScript).semantic?.providerId, "typescript-type-producer");
  assert.equal(languageDescriptor(ProjectFileLanguage.Python).semantic, undefined, "Python has no semantic provider yet");
  assert.equal(languageDescriptor(ProjectFileLanguage.Svelte).role, "embedded-source");
  assert.equal(namingIdiom(ProjectFileLanguage.Python, "function"), "snake_case");
  assert.equal(namingIdiom(ProjectFileLanguage.TypeScript, "function"), "camelCase");
  assert.equal(namingIdiom(ProjectFileLanguage.TypeScript, "type"), "PascalCase");
});
