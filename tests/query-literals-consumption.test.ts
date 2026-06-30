import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { queryLiterals, siteKey, DeclarationIndex, type ProjectLiteralFact, type TypeResolution } from "@opencanon/core";

/**
 * `surroundingType` is a NON-ENUMERABLE lazy getter: only an EXPLICIT
 * `literal.surroundingType` read counts as a typed-fact dependency. Spreading,
 * Object.assign, Object.entries, or JSON.stringify of the fact must NOT trip the
 * getter — otherwise a validator that merely logs/clones the fact would record a
 * spurious producer consumption and emit a bogus producer outcome.
 */
describe("queryLiterals surroundingType getter semantics", () => {
  const literal = {
    value: "foo",
    valueKind: "string" as const,
    line: 1,
    column: 1,
    context: "comparison" as const,
    file: { path: "src/a.ts", language: "typescript" as const },
    language: "typescript" as const,
  } as unknown as ProjectLiteralFact;
  const resolution: TypeResolution = {
    language: "typescript",
    display: "Mode",
    typeSource: "inferred",
    kind: "literal-union",
    members: [{ value: { kind: "string", value: "foo" }, display: '"foo"' }],
  };
  const typeMap = new Map<string, TypeResolution>([[siteKey("src/a.ts", 1, 1), resolution]]);

  function run() {
    const consumed: string[] = [];
    const results = queryLiterals(
      [literal],
      typeMap,
      new DeclarationIndex([]),
      { valueKind: "string" },
      (lang) => consumed.push(lang),
    );
    return { result: results[0]!, consumed };
  }

  it("does NOT mark consumption on spread", () => {
    const { result, consumed } = run();
    void { ...result };
    assert.deepEqual(consumed, []);
  });

  it("does NOT mark consumption on JSON.stringify", () => {
    const { result, consumed } = run();
    void JSON.stringify(result);
    assert.deepEqual(consumed, []);
  });

  it("does NOT mark consumption on Object.entries / keys", () => {
    const { result, consumed } = run();
    void Object.entries(result);
    void Object.keys(result);
    assert.deepEqual(consumed, []);
  });

  it("DOES mark consumption on explicit read, exactly once", () => {
    const { result, consumed } = run();
    void result.surroundingType;
    void result.surroundingType;
    assert.deepEqual(consumed, ["typescript"]);
  });
});
