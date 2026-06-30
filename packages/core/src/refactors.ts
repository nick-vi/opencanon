import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles } from "./discovery.ts";
import { importRewritableExtensions } from "./language-registry.ts";
import { resolveInsideRoot } from "./paths.ts";
import type { CodeReference, CodeSymbol } from "./contracts.ts";
import type { TextEdit } from "./validator-types.ts";

const TextEncoding = "utf8";
// Files whose imports the refactor engine rewrites — sourced from the registry's
// TypeScript-resolution languages (TS/JS family + Svelte), plus config files that
// move with a package rename but carry no rewritable imports.
const SourceExtensions = importRewritableExtensions;
const PackageRenameExtensions = [...SourceExtensions, ".json", ".jsonc", ".lock"];

export type RefactorPlanKind = "rename-symbol" | "update-imports" | "move-file" | "move-dir" | "rename-package" | "split-module";

export type RefactorFileMove = {
  from: string;
  to: string;
};

export type RefactorPlan = {
  kind: RefactorPlanKind;
  summary: string;
  edits: TextEdit[];
  fileMoves: RefactorFileMove[];
  diagnostics: string[];
};

export type RefactorApplyResult = {
  dryRun: boolean;
  appliedEdits: number;
  movedFiles: number;
  files: string[];
  diagnostics: string[];
};

export function renameSymbol(input: {
  rootDir: string;
  from: string;
  to: string;
  files?: string[];
  include?: string[];
  symbols?: CodeSymbol[];
  references?: CodeReference[];
  graphOnly?: boolean;
}): RefactorPlan {
  const diagnostics = validateIdentifierPair(input.from, input.to);
  const discoveredFiles = projectFiles(input.rootDir, input.files, input.include);
  const files = discoveredFiles.length > 0 || input.files || input.include ? discoveredFiles : graphFiles(input.symbols ?? [], input.references ?? []);
  const allowedFiles = new Set(files.map(normalizeProjectPath));
  const matchingSymbols = (input.symbols ?? []).filter((symbol) => symbol.name === input.from && allowedFiles.has(normalizeProjectPath(symbol.path)));
  if (input.graphOnly && matchingSymbols.length > 1) diagnostics.push(`Ambiguous graph rename for symbol ${input.from}: ${matchingSymbols.length} declarations match.`);
  const graphEdits = diagnostics.length > 0 ? [] : graphRenameEdits(input.from, input.to, input.symbols ?? [], input.references ?? [], files);
  const textEdits = diagnostics.length > 0 || input.graphOnly ? [] : files.flatMap((file) => renameSymbolEdits(input.rootDir, file, input.from, input.to));
  if (input.graphOnly && graphEdits.length === 0) diagnostics.push(`No graph references found for symbol: ${input.from}`);
  return {
    kind: "rename-symbol",
    summary: `Rename symbol ${input.from} to ${input.to}.`,
    edits: uniqueEdits([...graphEdits, ...textEdits]),
    fileMoves: [],
    diagnostics,
  };
}

export function updateImports(input: {
  rootDir: string;
  from: string;
  to: string;
  files?: string[];
  include?: string[];
}): RefactorPlan {
  const diagnostics = validateProjectPath(input.rootDir, input.from, "from").concat(validateProjectPath(input.rootDir, input.to, "to"));
  const files = projectFiles(input.rootDir, input.files, input.include);
  const edits = diagnostics.length > 0 ? [] : files.flatMap((file) => updateImportEdits(input.rootDir, file, input.from, input.to));
  return {
    kind: "update-imports",
    summary: `Update imports from ${input.from} to ${input.to}.`,
    edits,
    fileMoves: [],
    diagnostics,
  };
}

export function moveFile(input: {
  rootDir: string;
  from: string;
  to: string;
  files?: string[];
  include?: string[];
}): RefactorPlan {
  const diagnostics = validateExistingProjectPath(input.rootDir, input.from, "from").concat(validateProjectPath(input.rootDir, input.to, "to"));
  const importPlan = updateImports(input);
  return {
    kind: "move-file",
    summary: `Move file ${input.from} to ${input.to}.`,
    edits: diagnostics.length > 0 ? [] : importPlan.edits,
    fileMoves: diagnostics.length > 0 ? [] : [{ from: input.from, to: input.to }],
    diagnostics: [...diagnostics, ...importPlan.diagnostics],
  };
}

export function moveDir(input: {
  rootDir: string;
  from: string;
  to: string;
  files?: string[];
  include?: string[];
}): RefactorPlan {
  const fromDir = input.from.replace(/\/+$/, "");
  const toDir = input.to.replace(/\/+$/, "");
  const resolved = resolveInsideRoot(input.rootDir, fromDir);
  const diagnostics = resolved.ok && existsSync(resolved.absolutePath) ? [] : [`from directory does not exist: ${fromDir}`];
  const movedFiles = diagnostics.length > 0 ? [] : projectFiles(path.join(input.rootDir, fromDir)).map((file) => `${fromDir}/${file}`);
  const moves = movedFiles.map((file) => ({ from: file, to: `${toDir}/${file.slice(fromDir.length + 1)}` }));
  const importEdits = moves.flatMap((move) => updateImports({ rootDir: input.rootDir, from: move.from, to: move.to, files: input.files, include: input.include }).edits);
  return {
    kind: "move-dir",
    summary: `Move directory ${fromDir} to ${toDir}.`,
    edits: importEdits,
    fileMoves: moves,
    diagnostics,
  };
}

export function renamePackage(input: {
  rootDir: string;
  from: string;
  to: string;
  files?: string[];
  include?: string[];
}): RefactorPlan {
  const diagnostics = input.from.trim() && input.to.trim() ? [] : ["package names must be non-empty."];
  const files = projectFiles(input.rootDir, input.files, input.include, (file) => hasExtension(file, PackageRenameExtensions) || path.basename(file) === "bun.lock");
  const edits = diagnostics.length > 0 ? [] : files.flatMap((file) => replaceStringLiteralEdits(input.rootDir, file, input.from, input.to));
  return {
    kind: "rename-package",
    summary: `Rename package ${input.from} to ${input.to}.`,
    edits,
    fileMoves: [],
    diagnostics,
  };
}

export function splitModule(input: {
  rootDir: string;
  from: string;
  targets: RefactorFileMove[];
  files?: string[];
  include?: string[];
}): RefactorPlan {
  const diagnostics = validateExistingProjectPath(input.rootDir, input.from, "from");
  for (const target of input.targets) diagnostics.push(...validateProjectPath(input.rootDir, target.to, "target"));
  const edits = diagnostics.length > 0
    ? []
    : input.targets.flatMap((target) => updateImports({ rootDir: input.rootDir, from: input.from, to: target.to, files: input.files, include: input.include }).edits);
  return {
    kind: "split-module",
    summary: `Split imports from ${input.from} across ${input.targets.length} targets.`,
    edits,
    fileMoves: [],
    diagnostics,
  };
}

export function applyRefactorPlan(input: { rootDir: string; plan: RefactorPlan; dryRun?: boolean }): RefactorApplyResult {
  const diagnostics = [...input.plan.diagnostics];
  const files = new Set<string>();
  const dryRun = input.dryRun ?? false;
  let appliedEdits = 0;
  let movedFiles = 0;

  const editsByFile = new Map<string, Array<TextEdit & { startOffset: number; endOffset: number; absolutePath: string }>>();
  for (const edit of input.plan.edits) {
    const resolved = resolveInsideRoot(input.rootDir, edit.file);
    if (!resolved.ok) {
      diagnostics.push(`Unsafe edit path for ${edit.file}: ${resolved.message}`);
      continue;
    }
    if (!existsSync(resolved.absolutePath)) {
      diagnostics.push(`Cannot edit missing file: ${edit.file}`);
      continue;
    }
    const text = readFileSync(resolved.absolutePath, TextEncoding);
    const startOffset = positionToOffset(text, edit.range.startLine, edit.range.startColumn);
    const endOffset = positionToOffset(text, edit.range.endLine, edit.range.endColumn);
    if (startOffset === null || endOffset === null || startOffset > endOffset) {
      diagnostics.push(`Invalid edit range for ${edit.file}:${edit.range.startLine}`);
      continue;
    }
    const edits = editsByFile.get(edit.file) ?? [];
    edits.push({ ...edit, absolutePath: resolved.absolutePath, startOffset, endOffset });
    editsByFile.set(edit.file, edits);
  }

  for (const [file, edits] of editsByFile) {
    edits.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
    for (let index = 1; index < edits.length; index += 1) {
      if (edits[index].startOffset < edits[index - 1].endOffset) diagnostics.push(`Overlapping refactor edits for ${file}.`);
    }
  }
  if (diagnostics.length > input.plan.diagnostics.length) return { dryRun, appliedEdits, movedFiles, files: [...files].sort(), diagnostics };

  if (!dryRun) {
    for (const [file, edits] of editsByFile) {
      let text = readFileSync(edits[0].absolutePath, TextEncoding);
      for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
        text = `${text.slice(0, edit.startOffset)}${edit.replacement}${text.slice(edit.endOffset)}`;
        appliedEdits += 1;
      }
      writeFileSync(edits[0].absolutePath, text);
      files.add(file);
    }
    for (const move of input.plan.fileMoves) {
      const from = resolveInsideRoot(input.rootDir, move.from);
      const to = resolveInsideRoot(input.rootDir, move.to);
      if (!from.ok || !to.ok) {
        diagnostics.push(`Unsafe move path: ${move.from} -> ${move.to}`);
        continue;
      }
      if (!existsSync(from.absolutePath)) {
        diagnostics.push(`Cannot move missing file: ${move.from}`);
        continue;
      }
      mkdirSync(path.dirname(to.absolutePath), { recursive: true });
      renameSync(from.absolutePath, to.absolutePath);
      movedFiles += 1;
      files.add(move.from);
      files.add(move.to);
    }
  } else {
    for (const file of editsByFile.keys()) files.add(file);
    for (const move of input.plan.fileMoves) {
      files.add(move.from);
      files.add(move.to);
    }
  }

  return { dryRun, appliedEdits, movedFiles, files: [...files].sort(), diagnostics };
}

export const fixes = {
  renameSymbol,
  moveFile,
  moveDir,
  updateImports,
  renamePackage,
  splitModule,
  apply: applyRefactorPlan,
} as const;

function renameSymbolEdits(rootDir: string, file: string, from: string, to: string): TextEdit[] {
  const text = readProjectText(rootDir, file);
  if (text === null) return [];
  return matchEdits(file, text, identifierPattern(from), to);
}

function graphRenameEdits(from: string, to: string, symbols: CodeSymbol[], references: CodeReference[], files: string[]): TextEdit[] {
  const allowedFiles = new Set(files.map(normalizeProjectPath));
  const symbolEdits = symbols
    .filter((symbol) => symbol.name === from && allowedFiles.has(normalizeProjectPath(symbol.path)))
    .map((symbol) => rangeEdit(symbol.path, symbol.range, to));
  const referenceEdits = references
    .filter((reference) => reference.name === from && allowedFiles.has(normalizeProjectPath(reference.path)))
    .map((reference) => rangeEdit(reference.path, reference.range, to));
  return [...symbolEdits, ...referenceEdits];
}

function graphFiles(symbols: CodeSymbol[], references: CodeReference[]): string[] {
  return [...new Set([...symbols.map((symbol) => symbol.path), ...references.map((reference) => reference.path)].map(normalizeProjectPath))].sort();
}

function rangeEdit(file: string, range: CodeSymbol["range"], replacement: string): TextEdit {
  return {
    file,
    range: {
      startLine: range.start.line,
      startColumn: range.start.column,
      endLine: range.end.line,
      endColumn: range.end.column,
    },
    replacement,
  };
}

function uniqueEdits(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  const result: TextEdit[] = [];
  for (const edit of edits) {
    const key = `${edit.file}:${edit.range.startLine}:${edit.range.startColumn}:${edit.range.endLine}:${edit.range.endColumn}:${edit.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edit);
  }
  return result;
}

function replaceStringLiteralEdits(rootDir: string, file: string, from: string, to: string): TextEdit[] {
  const text = readProjectText(rootDir, file);
  if (text === null) return [];
  return matchEdits(file, text, new RegExp(`(["'])${RegExp.escape(from)}\\1`, "g"), (match) => `${match[1]}${to}${match[1]}`);
}

function updateImportEdits(rootDir: string, file: string, from: string, to: string): TextEdit[] {
  const text = readProjectText(rootDir, file);
  if (text === null) return [];
  const edits: TextEdit[] = [];
  const importPattern = /\b(from\s+|import\s*\(\s*|import\s+)(["'])([^"']+)(["'])/g;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[3];
    if (!specifier.startsWith(".")) continue;
    if (!importMatches(file, specifier, from)) continue;
    const nextSpecifier = relativeImportSpecifier(path.dirname(file), to, specifier);
    const start = (match.index ?? 0) + match[0].indexOf(specifier);
    const end = start + specifier.length;
    edits.push(textEditForOffsets(file, text, start, end, nextSpecifier));
  }
  return edits;
}

function matchEdits(file: string, text: string, pattern: RegExp, replacement: string | ((match: RegExpMatchArray) => string)): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    edits.push(textEditForOffsets(file, text, start, end, typeof replacement === "string" ? replacement : replacement(match)));
  }
  return edits;
}

function textEditForOffsets(file: string, text: string, start: number, end: number, replacement: string): TextEdit {
  const startPosition = offsetToPosition(text, start);
  const endPosition = offsetToPosition(text, end);
  return {
    file,
    range: {
      startLine: startPosition.line,
      startColumn: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
    },
    replacement,
  };
}

function projectFiles(rootDir: string, files?: string[], include?: string[], predicate = isSourcePath): string[] {
  if (files && files.length > 0) return files.map(normalizeProjectPath).filter(predicate);
  const roots = include && include.length > 0 ? include : ["."];
  return roots.flatMap((root) => listFiles(path.join(rootDir, root), predicate, shouldSkipDirectory).map((file) => path.relative(rootDir, file))).map(normalizeProjectPath);
}

function shouldSkipDirectory(dir: string): boolean {
  return [".git", "node_modules", "dist", "build", ".opencanon"].includes(path.basename(dir));
}

function readProjectText(rootDir: string, file: string): string | null {
  const resolved = resolveInsideRoot(rootDir, file);
  if (!resolved.ok || !existsSync(resolved.absolutePath)) return null;
  return readFileSync(resolved.absolutePath, TextEncoding);
}

function importMatches(importer: string, specifier: string, target: string): boolean {
  return importPathCandidates(importer, specifier).includes(normalizeProjectPath(target));
}

function importPathCandidates(importer: string, specifier: string): string[] {
  const base = normalizeProjectPath(path.normalize(path.join(path.dirname(importer), specifier)));
  const extension = SourceExtensions.find((item) => base.endsWith(item));
  if (extension) return [base];
  return [base, ...SourceExtensions.map((item) => `${base}${item}`), ...SourceExtensions.map((item) => `${base}/index${item}`)];
}

function relativeImportSpecifier(fromDir: string, toFile: string, originalSpecifier: string): string {
  const originalHadExtension = SourceExtensions.some((extension) => originalSpecifier.endsWith(extension));
  const target = originalHadExtension ? toFile : stripKnownExtension(toFile);
  let specifier = normalizeProjectPath(path.relative(fromDir || ".", target));
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function stripKnownExtension(file: string): string {
  const extension = SourceExtensions.find((item) => file.endsWith(item));
  return extension ? file.slice(0, -extension.length) : file;
}

function validateIdentifierPair(from: string, to: string): string[] {
  const diagnostics: string[] = [];
  if (!identifierPatternSource(from)) diagnostics.push(`Invalid source identifier: ${from}`);
  if (!identifierPatternSource(to)) diagnostics.push(`Invalid target identifier: ${to}`);
  return diagnostics;
}

function validateExistingProjectPath(rootDir: string, value: string, label: string): string[] {
  const diagnostics = validateProjectPath(rootDir, value, label);
  const resolved = resolveInsideRoot(rootDir, value);
  if (diagnostics.length === 0 && resolved.ok && !existsSync(resolved.absolutePath)) diagnostics.push(`${label} path does not exist: ${value}`);
  return diagnostics;
}

function validateProjectPath(rootDir: string, value: string, label: string): string[] {
  if (!value.trim()) return [`${label} path must be non-empty.`];
  const resolved = resolveInsideRoot(rootDir, value);
  return resolved.ok ? [] : [`Unsafe ${label} path: ${resolved.message}`];
}

function isSourcePath(file: string): boolean {
  return hasExtension(file, SourceExtensions);
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => file.endsWith(extension));
}

function normalizeProjectPath(file: string): string {
  return file.split(path.sep).join("/");
}

function identifierPattern(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_$])${RegExp.escape(name)}(?![A-Za-z0-9_$])`, "g");
}

function identifierPatternSource(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function positionToOffset(text: string, line: number, column: number): number | null {
  if (line < 1 || column < 1) return null;
  let currentLine = 1;
  let currentColumn = 1;
  for (let index = 0; index <= text.length; index += 1) {
    if (currentLine === line && currentColumn === column) return index;
    if (index === text.length) break;
    if (text[index] === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }
  return null;
}
