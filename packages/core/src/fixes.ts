import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveInsideRoot } from "./paths.ts";
import type { Finding, TextEdit } from "./validator.ts";
import { FixSafety } from "./validator.ts";

export const FixModeValue = {
  Safe: "safe",
  Suggested: "suggested",
  All: "all",
} as const;
export type FixMode = (typeof FixModeValue)[keyof typeof FixModeValue];

export type FixApplicationResult = {
  mode: FixMode;
  dryRun: boolean;
  selectedEdits: number;
  appliedEdits: number;
  files: string[];
  skipped: Array<{
    file: string;
    line: number;
    validatorId: string;
    safety: FixSafety;
    reason: string;
  }>;
  diagnostics: string[];
};

type ResolvedEdit = TextEdit & {
  validatorId: string;
  absolutePath: string;
  startOffset: number;
  endOffset: number;
};

export function applyFindingFixes(params: {
  rootDir: string;
  findings: Finding[];
  mode: FixMode;
  dryRun: boolean;
}): FixApplicationResult {
  const result: FixApplicationResult = {
    mode: params.mode,
    dryRun: params.dryRun,
    selectedEdits: 0,
    appliedEdits: 0,
    files: [],
    skipped: [],
    diagnostics: [],
  };
  const editsByFile = new Map<string, ResolvedEdit[]>();

  for (const finding of params.findings) {
    if (!finding.fix) continue;
    if (!isFixAllowed(finding.fix.safety, params.mode)) {
      result.skipped.push({
        file: finding.file,
        line: finding.line,
        validatorId: finding.validatorId,
        safety: finding.fix.safety,
        reason: "Fix safety is outside requested mode.",
      });
      continue;
    }

    if (!finding.fix.edits || finding.fix.edits.length === 0) {
      result.skipped.push({
        file: finding.file,
        line: finding.line,
        validatorId: finding.validatorId,
        safety: finding.fix.safety,
        reason: finding.fix.command ? `Fix command is advisory and is not auto-executed: ${finding.fix.command}` : "Fix has no structured edits.",
      });
      continue;
    }

    for (const edit of finding.fix.edits) {
      const resolvedPath = resolveInsideRoot(params.rootDir, edit.file);
      if (!resolvedPath.ok) {
        result.diagnostics.push(`Unsafe edit path for ${edit.file}: ${resolvedPath.message}`);
        continue;
      }
      const absolutePath = resolvedPath.absolutePath;
      if (!existsSync(absolutePath)) {
        result.diagnostics.push(`Cannot edit missing file: ${edit.file}`);
        continue;
      }

      const text = readFileSync(absolutePath, "utf8");
      const startOffset = positionToOffset(text, edit.range.startLine, edit.range.startColumn);
      const endOffset = positionToOffset(text, edit.range.endLine, edit.range.endColumn);
      if (startOffset === null || endOffset === null || startOffset > endOffset) {
        result.diagnostics.push(`Invalid edit range for ${edit.file}:${edit.range.startLine}`);
        continue;
      }

      const resolvedEdit = {
        ...edit,
        validatorId: finding.validatorId,
        absolutePath,
        startOffset,
        endOffset,
      };
      const edits = editsByFile.get(edit.file) ?? [];
      edits.push(resolvedEdit);
      editsByFile.set(edit.file, edits);
    }
  }

  for (const [file, edits] of editsByFile) {
    edits.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
    for (let index = 1; index < edits.length; index += 1) {
      if (edits[index].startOffset < edits[index - 1].endOffset) {
        result.diagnostics.push(`Overlapping fixes for ${file} from ${edits[index - 1].validatorId} and ${edits[index].validatorId}.`);
      }
    }
  }

  result.selectedEdits = [...editsByFile.values()].reduce((count, edits) => count + edits.length, 0);
  result.files = [...editsByFile.keys()].sort();

  if (result.diagnostics.length > 0 || params.dryRun) return result;

  for (const edits of editsByFile.values()) {
    const absolutePath = edits[0]?.absolutePath;
    if (!absolutePath) continue;
    let text = readFileSync(absolutePath, "utf8");
    for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
      text = `${text.slice(0, edit.startOffset)}${edit.replacement}${text.slice(edit.endOffset)}`;
      result.appliedEdits += 1;
    }
    writeFileSync(absolutePath, text);
  }

  return result;
}

export function isFixAllowed(safety: FixSafety, mode: FixMode): boolean {
  if (safety === FixSafety.Manual) return false;
  if (mode === FixModeValue.All) return safety === FixModeValue.Safe || safety === FixModeValue.Suggested;
  if (mode === FixModeValue.Suggested) return safety === FixModeValue.Safe || safety === FixModeValue.Suggested;
  return safety === FixModeValue.Safe;
}

function positionToOffset(text: string, line: number, column: number): number | null {
  if (line < 1 || column < 1) return null;
  let currentLine = 1;
  let currentColumn = 1;

  for (let index = 0; index <= text.length; index += 1) {
    if (currentLine === line && currentColumn === column) return index;
    if (index === text.length) break;
    const char = text[index];
    if (char === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }

  return currentLine === line && currentColumn === column ? text.length : null;
}
