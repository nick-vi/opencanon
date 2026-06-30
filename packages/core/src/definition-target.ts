export const DefinitionTargetKind = {
  File: "file",
  Package: "package",
  Endpoint: "endpoint",
  Command: "command",
  Doc: "doc",
  Resource: "resource",
} as const;
export type DefinitionTargetKind = (typeof DefinitionTargetKind)[keyof typeof DefinitionTargetKind];

type DefinitionTargetBase = {
  id?: string;
  label?: string;
  description?: string;
  adapter?: string;
};

export type DefinitionTarget =
  | (DefinitionTargetBase & { kind: "file"; path: string })
  | (DefinitionTargetBase & { kind: "package"; name: string })
  | (DefinitionTargetBase & { kind: "endpoint"; path: string; protocol?: string })
  | (DefinitionTargetBase & { kind: "command"; name: string })
  | (DefinitionTargetBase & { kind: "doc"; path: string })
  | (DefinitionTargetBase & { kind: "resource"; name: string; type?: string });

export function definitionTargetFiles(targets: DefinitionTarget[] | undefined): string[] {
  return (targets ?? []).filter(isFileTarget).map((target) => target.path);
}

export function definitionTargetDocs(targets: DefinitionTarget[] | undefined): string[] {
  return (targets ?? []).filter(isDocTarget).map((target) => target.path);
}

export function definitionTargetSummary(target: DefinitionTarget): string {
  const value = definitionTargetValue(target);
  const qualifiers = [target.adapter, target.label].filter((item): item is string => Boolean(item));
  return qualifiers.length > 0 ? `${value} (${qualifiers.join(", ")})` : value;
}

export function definitionTargetRows(targets: DefinitionTarget[] | undefined): Array<[string, string[]]> {
  return [
    ["Files", targetValues(targets, DefinitionTargetKind.File)],
    ["Packages", targetValues(targets, DefinitionTargetKind.Package)],
    ["Endpoints", targetValues(targets, DefinitionTargetKind.Endpoint)],
    ["Commands", targetValues(targets, DefinitionTargetKind.Command)],
    ["Docs", targetValues(targets, DefinitionTargetKind.Doc)],
    ["Resources", targetValues(targets, DefinitionTargetKind.Resource)],
  ].filter((row): row is [string, string[]] => row[1].length > 0);
}

function targetValues(targets: DefinitionTarget[] | undefined, kind: DefinitionTargetKind): string[] {
  return (targets ?? []).filter((target) => target.kind === kind).map(definitionTargetSummary);
}

function isFileTarget(target: DefinitionTarget): target is Extract<DefinitionTarget, { kind: "file" }> {
  return target.kind === DefinitionTargetKind.File;
}

function isDocTarget(target: DefinitionTarget): target is Extract<DefinitionTarget, { kind: "doc" }> {
  return target.kind === DefinitionTargetKind.Doc;
}

function definitionTargetValue(target: DefinitionTarget): string {
  switch (target.kind) {
    case DefinitionTargetKind.File:
    case DefinitionTargetKind.Endpoint:
    case DefinitionTargetKind.Doc:
      return target.path;
    case DefinitionTargetKind.Package:
    case DefinitionTargetKind.Command:
    case DefinitionTargetKind.Resource:
      return target.name;
  }
}
