import { createValidatorFactory } from "@opencanon/core";
import { DefaultBypassCommentPatterns, DefaultBypassReasonPatterns, DefaultHeaderCommentAllowPatterns, firstCodeLineNumber, joinPatterns, list, manualFix, optionSummary, regexMatches } from "../shared.ts";
import type { NoCommentMatchesOptions, NoHeaderCommentsOptions, NoBypassCommentsOptions, NoForbiddenCallsOptions, NoShimFilesOptions, AnnotationPolicyOptions } from "../shared.ts";

export const noCommentMatches = createValidatorFactory<NoCommentMatchesOptions>((options) => {
  const patterns = list(options.patterns);

  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    facts: ["comments"],
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Comments in ${joinPatterns(options.in)} must not match the configured forbidden patterns.`),
    validate({ ctx }) {
      const targetFiles = new Set(ctx.targetFiles.map((file) => file.path));

      return ctx.facts
        .comments()
        .filter((comment) => targetFiles.has(comment.file.path))
        .filter((comment) => patterns.some((pattern) => regexMatches(pattern, comment.text)))
        .map((comment) =>
          comment.file.report({
            line: comment.line,
            column: comment.column,
            message: options.message,
            fix: options.fix,
            docs: options.docs,
          }),
        );
    },
  };
});

export const noHeaderComments = createValidatorFactory<NoHeaderCommentsOptions>((options) => {
  const patterns = list(options.patterns);
  const allowed = [...DefaultHeaderCommentAllowPatterns, ...list(options.allow)];
  const maxHeaderLines = options.maxHeaderLines ?? 12;

  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    facts: ["comments"],
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must not start with unapproved header comments.`),
    validate({ ctx }) {
      return ctx.targetFiles.flatMap((file) => {
        const firstCodeLine = firstCodeLineNumber(file.lines, file.language);
        return file
          .comments()
          .filter((comment) => comment.line < firstCodeLine)
          .filter((comment) => comment.line <= maxHeaderLines)
          .filter((comment) => !allowed.some((pattern) => regexMatches(pattern, comment.text)))
          .filter((comment) => patterns.length === 0 || patterns.some((pattern) => regexMatches(pattern, comment.text)))
          .map((comment) =>
            file.report({
              line: comment.line,
              column: comment.column,
              message: options.message,
              fix: options.fix ?? manualFix("Remove the file header comment unless it is required license, shebang, or reference metadata."),
              docs: options.docs,
            }),
          );
      });
    },
  };
});

export const noBypassComments = createValidatorFactory<NoBypassCommentsOptions>((options) => {
  const patterns = list(options.patterns);
  const activePatterns = patterns.length > 0 ? patterns : DefaultBypassCommentPatterns;
  const allowed = list(options.allow);
  const reasonPatterns = list(options.reasonPatterns);
  const activeReasonPatterns = reasonPatterns.length > 0 ? reasonPatterns : DefaultBypassReasonPatterns;

  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    facts: ["comments"],
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Comments in ${joinPatterns(options.in)} must not bypass validators or linters without an approved policy.`),
    validate({ ctx }) {
      const targetFiles = new Set(ctx.targetFiles.map((file) => file.path));
      return ctx.facts
        .comments()
        .filter((comment) => targetFiles.has(comment.file.path))
        .filter((comment) => activePatterns.some((pattern) => regexMatches(pattern, comment.text)))
        .filter((comment) => !allowed.some((pattern) => regexMatches(pattern, comment.text)))
        .filter((comment) => !options.requireReason || !activeReasonPatterns.some((pattern) => regexMatches(pattern, comment.text)))
        .map((comment) =>
          comment.file.report({
            line: comment.line,
            column: comment.column,
            message: options.message,
            fix: options.fix ?? manualFix("Remove the bypass comment and fix the underlying issue, or document a project-level exception."),
            docs: options.docs,
          }),
        );
    },
  };
});

export const noForbiddenCalls = createValidatorFactory<NoForbiddenCallsOptions>((options) => {
  const calls = list(options.calls);

  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    facts: ["calls"],
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must not call the configured forbidden APIs.`),
    validate({ ctx }) {
      return ctx.targetFiles.flatMap((file) =>
        calls.flatMap((call) =>
          file.find(call).map((match) =>
            file.report({
              line: match.line,
              column: match.column,
              message: options.message,
              fix: options.fix,
              docs: options.docs,
            }),
          ),
        ),
      );
    },
  };
});

export const noShimFiles = createValidatorFactory<NoShimFilesOptions>((options) => {
  const patterns = list(options.patterns);
  const activePatterns = patterns.length > 0 ? patterns : [/\b(?:shim|compat|legacy|deprecated|old)\b/i];
  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must not introduce shim or compatibility naming.`),
    validate({ ctx }) {
      return ctx.targetFiles
        .filter((file) => activePatterns.some((pattern) => regexMatches(pattern, file.path)))
        .map((file) =>
          file.report({
            line: 1,
            message: options.message,
            fix: options.fix ?? manualFix("Move the behavior into the current implementation path or document an explicit public-boundary exception."),
            docs: options.docs,
          }),
        );
    },
  };
});

export const annotationRequiresTags = createValidatorFactory<AnnotationPolicyOptions>((options) => {
  const tags = new Set(options.tags ?? ["shim", "compat", "deprecated", "legacy"]);
  const required = new Set(options.requireTags);
  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    facts: ["annotations"],
    decisionIds: options.decisionIds,
    summary: optionSummary(options, `Lifecycle annotations in ${joinPatterns(options.in)} must include required metadata.`),
    validate({ ctx }) {
      const targetFiles = new Set(ctx.targetFiles.map((file) => file.path));
      const annotationsByFileLine = new Map<string, Set<string>>();
      for (const annotation of ctx.facts.annotations()) {
        const key = `${annotation.file.path}:${annotation.line}`;
        const values = annotationsByFileLine.get(key) ?? new Set<string>();
        values.add(annotation.tag);
        annotationsByFileLine.set(key, values);
      }

      return ctx.facts
        .annotations()
        .filter((annotation) => targetFiles.has(annotation.file.path))
        .filter((annotation) => tags.has(annotation.tag))
        .flatMap((annotation) => {
          const present = annotationsByFileLine.get(`${annotation.file.path}:${annotation.line}`) ?? new Set<string>();
          const missing = [...required].filter((tag) => !present.has(tag));
          if (missing.length === 0) return [];
          return [
            annotation.file.report({
              line: annotation.line,
              column: annotation.column,
              message: `${options.message} Missing metadata: ${missing.join(", ")}.`,
              fix: options.fix ?? manualFix("Add owner, replacement, and removal metadata, or remove the lifecycle annotation."),
              docs: options.docs,
            }),
          ];
        });
    },
  };
});
