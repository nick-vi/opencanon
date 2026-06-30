import { createConventionFactory } from "@opencanon/core";
import { joinPatterns, optionSummary } from "../shared.ts";
import type { NoFolderNamesOptions, FolderStructureOptions } from "../shared.ts";

export const noFolderNames = createConventionFactory<NoFolderNamesOptions>((options) => {
  const paths = Object.fromEntries(
    options.in.map((pattern) => [
      pattern,
      {
        folders: {
          denyNames: options.names,
          message: options.message,
          fix: options.fix,
          docs: options.docs,
        },
      },
    ]),
  );

  return {
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "folder",
    conventionIds: options.related,
    summary: optionSummary(options, `Folders under ${joinPatterns(options.in)} must avoid ambiguous names: ${options.names.join(", ")}.`),
    visuals: [
      {
        kind: "tree",
        title: "Folder Names",
        definition: paths,
      },
    ],
    validate({ ctx }) {
      return ctx.tree(paths);
    },
  };
});

export const folderStructure = createConventionFactory<FolderStructureOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  conventionIds: options.related,
  summary: options.summary ?? "Project files must match the configured folder structure.",
  visuals: [
    {
      kind: "tree",
      title: "Folder Structure",
      definition: options.tree,
    },
  ],
  validate({ ctx }) {
    return ctx.tree(options.tree);
  },
}));
