import { validateDocsReference } from "./core.ts";
import type { Finding, FindingFix, FixSafety, Validator } from "./validator-types.ts";

const FactKeySeparator = "\u0000";

export type FindingValidationContext = {
  paths: Parameters<typeof validateDocsReference>[2]["paths"];
  decisionIds: Set<string>;
};

export function validateFindings(validator: Validator, findings: Finding[], context?: FindingValidationContext): string[] {
  const diagnostics: string[] = [];
  for (const finding of findings) {
    if (finding.validatorId !== validator.id) diagnostics.push(`Finding validatorId must be ${validator.id}.`);
    if (!["error", "warning"].includes(finding.severity)) diagnostics.push(`Finding from ${validator.id} has invalid severity.`);
    if (!finding.file) diagnostics.push(`Finding from ${validator.id} is missing file.`);
    if (!Number.isInteger(finding.line) || finding.line < 1) diagnostics.push(`Finding from ${validator.id} has invalid line.`);
    if (!finding.message) diagnostics.push(`Finding from ${validator.id} is missing message.`);
    if (finding.docs !== undefined && (!Array.isArray(finding.docs) || finding.docs.some((item) => typeof item !== "string" || item.length === 0))) {
      diagnostics.push(`Finding from ${validator.id} docs must be string[] when present.`);
    } else if (context && Array.isArray(finding.docs)) {
      for (const docsRef of finding.docs) {
        diagnostics.push(...validateDocsReference(`Finding from ${validator.id}`, docsRef, context));
      }
    }
    if (
      finding.decisionIds !== undefined &&
      (!Array.isArray(finding.decisionIds) || finding.decisionIds.some((item) => typeof item !== "string" || item.length === 0))
    ) {
      diagnostics.push(`Finding from ${validator.id} decisionIds must be string[] when present.`);
    } else if (context && Array.isArray(finding.decisionIds)) {
      for (const decisionId of finding.decisionIds) {
        if (!context.decisionIds.has(decisionId)) diagnostics.push(`Finding from ${validator.id} references missing decision: ${decisionId}.`);
      }
    }
    if (finding.fix) diagnostics.push(...validateFix(finding));
  }
  return diagnostics;
}

function validateFix(finding: Finding): string[] {
  const diagnostics: string[] = [];
  const validSafety = new Set<FixSafety>(["safe", "suggested", "manual"]);
  if (!validSafety.has(finding.fix?.safety as FixSafety)) diagnostics.push(`Finding from ${finding.validatorId} has invalid fix safety.`);
  if (!finding.fix?.description) diagnostics.push(`Finding from ${finding.validatorId} fix is missing description.`);
  if (finding.fix?.command !== undefined && (typeof finding.fix.command !== "string" || finding.fix.command.length === 0)) {
    diagnostics.push(`Finding from ${finding.validatorId} fix command must be a non-empty string when present.`);
  }

  for (const edit of finding.fix?.edits ?? []) {
    if (!edit.file) diagnostics.push(`Finding from ${finding.validatorId} has a fix edit without file.`);
    if (!Number.isInteger(edit.range.startLine) || edit.range.startLine < 1) diagnostics.push(`Finding from ${finding.validatorId} has invalid edit startLine.`);
    if (!Number.isInteger(edit.range.startColumn) || edit.range.startColumn < 1) diagnostics.push(`Finding from ${finding.validatorId} has invalid edit startColumn.`);
    if (!Number.isInteger(edit.range.endLine) || edit.range.endLine < 1) diagnostics.push(`Finding from ${finding.validatorId} has invalid edit endLine.`);
    if (!Number.isInteger(edit.range.endColumn) || edit.range.endColumn < 1) diagnostics.push(`Finding from ${finding.validatorId} has invalid edit endColumn.`);
    if (typeof edit.replacement !== "string") diagnostics.push(`Finding from ${finding.validatorId} edit replacement must be a string.`);
  }

  return diagnostics;
}

export function findingKey(finding: Pick<Finding, "validatorId" | "file" | "line" | "message">): string {
  return [finding.validatorId, finding.file, finding.line ?? 1, finding.message].join(FactKeySeparator);
}
