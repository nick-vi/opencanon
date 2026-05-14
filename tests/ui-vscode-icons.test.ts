import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { VscodeEntryKind, basenameOfPath, resolveVscodeIconForEntry } from "../packages/ui/src/vscodeIcons.ts";

test("vscode icon resolver uses exact filename mappings", () => {
  const icon = resolveVscodeIconForEntry("pnpm-workspace.yaml", VscodeEntryKind.File);
  assert.equal(icon.filename, "file_type_pnpm.svg");
});

test("vscode icon resolver keeps compound extension matches ahead of generic extensions", () => {
  const testIcon = resolveVscodeIconForEntry("packages/daemon/test/auth.test.ts", VscodeEntryKind.File);
  const reactIcon = resolveVscodeIconForEntry("src/Button.tsx", VscodeEntryKind.File);
  assert.equal(testIcon.filename, "file_type_testts.svg");
  assert.equal(reactIcon.filename, "file_type_reactts.svg");
});

test("vscode icon resolver supports expanded folder variants", () => {
  const closed = resolveVscodeIconForEntry("packages/src", VscodeEntryKind.Directory, false);
  const open = resolveVscodeIconForEntry("packages/src", VscodeEntryKind.Directory, true);
  assert.equal(closed.filename, "folder_type_src.svg");
  assert.equal(open.filename, "folder_type_src_opened.svg");
});

test("vscode icon resolver uses specialized segments for collapsed folder labels", () => {
  const app = resolveVscodeIconForEntry("apps/site", VscodeEntryKind.Directory);
  const appOpen = resolveVscodeIconForEntry("apps/site", VscodeEntryKind.Directory, true);
  const crate = resolveVscodeIconForEntry("crates/opencanon-engine", VscodeEntryKind.Directory);
  const agent = resolveVscodeIconForEntry(".agents/skills/opencanon", VscodeEntryKind.Directory);
  const runtime = resolveVscodeIconForEntry("runtime", VscodeEntryKind.Directory, true);

  assert.equal(app.filename, "folder_type_app.svg");
  assert.equal(appOpen.filename, "folder_type_app_opened.svg");
  assert.equal(crate.filename, "folder_type_cargo.svg");
  assert.equal(agent.filename, "file_type_agents.svg");
  assert.equal(runtime.filename, "folder_type_library_opened.svg");
});

test("vscode icon resolver falls back through language mappings and defaults", () => {
  const markdown = resolveVscodeIconForEntry("general.mdc", VscodeEntryKind.File);
  const html = resolveVscodeIconForEntry("index.html", VscodeEntryKind.File);
  const unknownFile = resolveVscodeIconForEntry("foo.unknown-ext", VscodeEntryKind.File);
  const unknownFolder = resolveVscodeIconForEntry("unknown-folder", VscodeEntryKind.Directory, true);

  assert.equal(markdown.filename, "file_type_markdown.svg");
  assert.equal(html.filename, "file_type_html.svg");
  assert.equal(unknownFile.filename, "default_file.svg");
  assert.equal(unknownFolder.filename, "default_folder_opened.svg");
});

test("vscode icon helpers infer common path shapes", () => {
  assert.equal(basenameOfPath("packages/ui/src/FileTree.tsx"), "FileTree.tsx");
});

test("resolved vscode icons are vendored in the runtime UI public assets", () => {
  const icons = [
    resolveVscodeIconForEntry("README.md", VscodeEntryKind.File),
    resolveVscodeIconForEntry("src/Button.tsx", VscodeEntryKind.File),
    resolveVscodeIconForEntry("packages/src", VscodeEntryKind.Directory, true),
  ];

  for (const icon of icons) {
    const spritePath = path.join(process.cwd(), "packages/ui/public", icon.spritePath.replace(/^\//, ""));
    const sprite = readFileSync(spritePath, "utf8");
    assert.equal(existsSync(spritePath), true, icon.spritePath);
    assert.match(sprite, new RegExp(`id="${icon.symbolId}"`));
  }
});

test("vendored vscode icon sprites are chunked and browser-safe", () => {
  const spriteDir = path.join(process.cwd(), "packages/ui/public/vscode-icons/v12.17.0");
  const spriteFiles = readdirSync(spriteDir).filter((file) => /^sprite-\d+\.svg$/.test(file));

  assert(spriteFiles.length > 1);
  for (const spriteFile of spriteFiles) {
    const sprite = readFileSync(path.join(spriteDir, spriteFile), "utf8");
    assert(sprite.length < 550_000, spriteFile);
    assert.doesNotMatch(sprite, /<image\b|data:image|inkscape:|sodipodi:|rdf:|cc:|dc:/);
  }
});
