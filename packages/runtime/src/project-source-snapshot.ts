import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DiagnosticSeverity,
  discoverProjectFiles,
  engineSourceLanguage,
  isCodeGraphIndexableFile,
  isEngineExtractableFile,
  validationContextFiles,
  type FactDiagnostic,
  type FactKind,
  type FileFacts,
  type ProjectFileSnapshot,
  type ScanAndDiffResult,
} from "@opencanon/core";
import { ENGINE_PARSER_VERSION } from "./ast-facts-provider.ts";
import type { ProjectStore } from "./state.ts";

const allFactKinds: FactKind[] = ["imports", "exports", "symbols", "calls", "literals", "comments"];

export type RuntimeSourceSnapshot = {
  discovery: ReturnType<typeof discoverProjectFiles>;
  scan: ScanAndDiffResult;
  sourceFileSnapshots: ProjectFileSnapshot[];
  contextFileSnapshots: ProjectFileSnapshot[];
  fileSnapshots: ProjectFileSnapshot[];
  factFiles: RuntimeFactFile[];
  facts: FileFacts[];
};

export type RuntimeFactFile = {
  path: string;
  contentHash: string;
  language: ReturnType<typeof engineSourceLanguage>;
  content: string;
};

export function captureRuntimeSourceSnapshot(input: {
  rootDir: string;
  paths: Parameters<typeof discoverProjectFiles>[0];
  store: ProjectStore;
  changedPaths?: string[];
}): RuntimeSourceSnapshot {
  const discovery = discoverProjectFiles(input.paths);
  if (discovery.failed) throw new Error(discovery.diagnostics.join("\n"));

  const scan = applyChangeHint(input.store.scanAndDiff(discovery.files), input.changedPaths);
  const sourceFileSnapshots = snapshotScanFiles(input.rootDir, scan);
  const sourceSnapshotPaths = new Set(sourceFileSnapshots.map((file) => file.path));
  const contextFileSnapshots = snapshotFiles(
    input.rootDir,
    validationContextFiles(input.paths).filter((file) => !sourceSnapshotPaths.has(file)),
  );
  const fileSnapshots = [...sourceFileSnapshots, ...contextFileSnapshots];
  const factFiles = factFilesFromSnapshots(sourceFileSnapshots);
  const extracted = extractRuntimeFacts({ store: input.store, factFiles });

  return {
    discovery,
    scan,
    sourceFileSnapshots,
    contextFileSnapshots,
    fileSnapshots,
    factFiles,
    facts: extracted.files,
  };
}

export function snapshotScanFiles(rootDir: string, scan: ScanAndDiffResult): ProjectFileSnapshot[] {
  return snapshotFiles(rootDir, scan.files.map((file) => file.path));
}

export function snapshotFiles(rootDir: string, files: string[]): ProjectFileSnapshot[] {
  return [...new Set(files)]
    .sort()
    .map((file) => {
      try {
        const content = readFileSync(path.join(rootDir, file), "utf8");
        return {
          path: file,
          contentHash: sourceContentHash(content),
          size: Buffer.byteLength(content),
          content,
        };
      } catch {
        return undefined;
      }
    })
    .filter((file): file is ProjectFileSnapshot => file !== undefined);
}

export function factFilesFromSnapshots(fileSnapshots: ProjectFileSnapshot[]): RuntimeFactFile[] {
  return fileSnapshots
    .filter((file) => isEngineExtractableFile(file.path))
    .map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      language: engineSourceLanguage(file.path),
      content: file.content,
    }));
}

export function extractRuntimeFacts(input: {
  store: ProjectStore;
  factFiles: RuntimeFactFile[];
  facts?: FactKind[];
}): { files: FileFacts[]; diagnostics: FactDiagnostic[] } {
  const result = input.store.project.extractFacts({
    files: input.factFiles,
    facts: input.facts ?? allFactKinds,
    parserVersion: ENGINE_PARSER_VERSION,
  });
  const diagnostics = [
    ...result.diagnostics,
    ...result.files.flatMap((file) => file.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${file.path}: ${diagnostic.message}` }))),
  ] satisfies FactDiagnostic[];
  if (diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)) {
    throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return { files: result.files, diagnostics };
}

export function indexRuntimeCodeGraph(input: {
  store: ProjectStore;
  factFiles: RuntimeFactFile[];
  deletedFiles: string[];
}): void {
  input.store.project.indexCodeGraph({
    files: input.factFiles.filter((file) => isCodeGraphIndexableFile(file.path)),
    deletedFiles: input.deletedFiles.filter(isCodeGraphIndexableFile),
    parserVersion: ENGINE_PARSER_VERSION,
  });
}

export function applyChangeHint(scan: ScanAndDiffResult, changedPaths: string[] | undefined): ScanAndDiffResult {
  if (!changedPaths || changedPaths.length === 0) return scan;
  const filesByPath = new Set(scan.files.map((file) => file.path));
  const hintedChanged = changedPaths.filter((file) => filesByPath.has(file));
  const hintedDeleted = changedPaths.filter((file) => !filesByPath.has(file));
  if (hintedChanged.length === 0 && hintedDeleted.length === 0) return scan;
  const changed = new Set([...scan.changedFiles, ...hintedChanged]);
  const deleted = new Set([...scan.deletedFiles, ...hintedDeleted]);
  return {
    ...scan,
    changedFiles: [...changed].sort(),
    unchangedFiles: scan.unchangedFiles.filter((file) => !changed.has(file) && !deleted.has(file)),
    deletedFiles: [...deleted].sort(),
  };
}

function sourceContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
