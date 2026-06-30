import assert from "node:assert/strict";
import { test } from "vitest";
import { filterTreeFiles, validateRelativePath } from "../src/server-fs.ts";

test("runtime path normalization preserves dot-prefixed tree entries", () => {
  const dotDir = validateRelativePath(".agents", { allowEmpty: true });
  const nestedDotDir = validateRelativePath("./.agents/skills/", { allowEmpty: true });
  const rootDir = validateRelativePath(".", { allowEmpty: true });
  const missingFile = validateRelativePath(".", { allowEmpty: false });

  assert.equal(dotDir.ok, true);
  if (dotDir.ok) assert.equal(dotDir.path, ".agents");

  assert.equal(nestedDotDir.ok, true);
  if (nestedDotDir.ok) assert.equal(nestedDotDir.path, ".agents/skills");

  assert.equal(rootDir.ok, true);
  if (rootDir.ok) assert.equal(rootDir.path, "");

  assert.equal(missingFile.ok, false);
});

test("runtime fs tree filters by query without hidden UI asset rules", () => {
  assert.deepEqual(
    filterTreeFiles(
      [
        "README.md",
        "packages/runtime/src/service.ts",
        "packages/runtime/src/server-fs.ts",
      ],
      { query: "README.md", showDotEntries: true },
    ),
    ["README.md"],
  );
});
