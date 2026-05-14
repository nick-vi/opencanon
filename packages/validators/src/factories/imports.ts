import { createValidatorFactory } from "@opencanon/core";
import type { Finding } from "@opencanon/core";
import { edgeMatches, isBarrelFile, joinPatterns, manualFix, optionSummary } from "../shared.ts";
import type { NoImportsOptions, NoForbiddenImportsOptions, NoDeepRelativeImportsOptions, NoBarrelCrossBoundaryOptions, NoLayerCallOptions } from "../shared.ts";
import { noForbiddenCalls } from "./comments.ts";

export const noImports = createValidatorFactory<NoImportsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.from,
  severity: options.severity,
  scope: "import-edge",
  facts: ["imports"],
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.from)} must not import ${joinPatterns(options.to)}.`),
  visuals: [
    {
      kind: "tree",
      title: "Import Boundary",
      definition: {
        nodes: {
          from: options.from,
          denied: options.to,
        },
        boundaries: [
          {
            from: "from",
            deny: ["denied"],
            message: options.message,
            fix: options.fix,
            docs: options.docs,
          },
        ],
      },
    },
  ],
  validate({ ctx }) {
    return ctx.tree({
      nodes: {
        from: options.from,
        denied: options.to,
      },
      boundaries: [
        {
          from: "from",
          deny: ["denied"],
          message: options.message,
          fix: options.fix,
          docs: options.docs,
        },
      ],
    });
  },
}));

export const noForbiddenImports = createValidatorFactory<NoForbiddenImportsOptions>((options) =>
  noImports({
    ...options,
    from: options.in,
    to: options.imports,
  }),
);

export const noDeepRelativeImports = createValidatorFactory<NoDeepRelativeImportsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "import-edge",
  facts: ["imports"],
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} may use relative imports up to depth ${options.maxDepth}.`),
  validate({ ctx }) {
    const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
    const findings: Finding[] = [];

    for (const edge of ctx.facts.imports()) {
      if (!targetPaths.has(edge.from.path)) continue;
      if (edge.relativeDepth <= options.maxDepth) continue;
      findings.push(
        edge.from.report({
          line: edge.line,
          message: options.message,
          fix: options.fix ?? manualFix("Use an approved import surface or move the helper closer to the importing code."),
          docs: options.docs,
        }),
      );
    }

    return findings;
  },
}));

export const noBarrelCrossBoundary = createValidatorFactory<NoBarrelCrossBoundaryOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "import-edge",
  facts: ["imports"],
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `Barrel files matching ${joinPatterns(options.in)} must stay inside the approved boundary.`),
  validate({ ctx, runtime }) {
    const targetFiles = new Set(ctx.targetFiles.map((file) => file.path));
    const findings: Finding[] = [];

    for (const edge of ctx.facts.imports()) {
      if (!targetFiles.has(edge.from.path)) continue;
      if (!isBarrelFile(edge.from.path)) continue;
      const denied = options.deny && edgeMatches(runtime, edge, options.deny);
      const outsideAllow = options.allow && edge.resolvedPath && !edgeMatches(runtime, edge, [...options.allow, edge.from.path]);
      const tooDeep = options.maxRelativeDepth !== undefined && edge.relativeDepth > options.maxRelativeDepth;
      if (!denied && !outsideAllow && !tooDeep) continue;
      findings.push(
        edge.from.report({
          line: edge.line,
          message: options.message,
          fix: options.fix ?? manualFix("Keep barrel exports inside the approved ownership boundary."),
          docs: options.docs,
        }),
      );
    }

    return findings;
  },
}));

export const noLayerCall = createValidatorFactory<NoLayerCallOptions>((options) =>
  noForbiddenCalls({
    ...options,
  }),
);
