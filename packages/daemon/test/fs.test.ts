import assert from "node:assert/strict";
import { test } from "vitest";
import { filterTreeFiles, validateRelativePath } from "../src/server-fs.ts";

test("daemon path normalization preserves dot-prefixed tree entries", () => {
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

test("daemon fs tree hides bundled vscode icon payloads", () => {
  assert.deepEqual(
    filterTreeFiles(
      [
        "README.md",
        "packages/ui/public/vscode-icons/README.md",
        ".agents/skills/opencanon/runtime/ui/vscode-icons/README.md",
        "packages/ui/src/vscodeIcons.ts",
      ],
      { query: "README.md", showDotEntries: true },
    ),
    ["README.md"],
  );
});
