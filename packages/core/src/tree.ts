import path from "node:path";
import { matchesAny, normalizePath, unique } from "./core.ts";
import { validatePatterns } from "./globs.ts";
import type { Finding, FindingFix, ImportEdge, ProjectFile, ValidationContext, ValidatorArgs } from "./validator.ts";

export type TreeDefinition = TreePathDefinition | TreeGraphDefinition;

export type TreePathDefinition = Record<string, TreeNode>;

export type TreeGraphDefinition = {
  paths?: TreePathDefinition;
  nodes?: Record<string, string | string[]>;
  boundaries?: TreeBoundaryRule[];
};

export type TreeNode = {
  docs?: string[];
  files?: TreeFileRules;
  folders?: TreeFolderRules;
  imports?: TreeImportRules;
  children?: TreePathDefinition;
};

export type TreeFileRules = {
  match?: string | string[];
  suffix?: string | string[];
  allowNames?: string[];
  message?: string;
  fix?: FindingFix;
  docs?: string[];
};

export type TreeFolderRules = {
  denyNames?: string[];
  message?: string;
  fix?: FindingFix;
  docs?: string[];
};

export type TreeImportRules = {
  allow?: string[];
  deny?: string[];
  maxRelativeDepth?: number;
  message?: string;
  fix?: FindingFix;
  docs?: string[];
};

export type TreeBoundaryRule = {
  from: string | string[];
  allow?: string[];
  deny?: string[];
  message?: string;
  fix?: FindingFix;
  docs?: string[];
};

type TreeRuleNode = {
  pattern: string;
  node: TreeNode;
};

type CompiledTreeDefinition = {
  paths: TreePathDefinition;
  nodes: Record<string, string[]>;
  boundaries: TreeBoundaryRule[];
  diagnostics: string[];
};

export function tree(definition: TreeDefinition): (args: ValidatorArgs) => Finding[] {
  return ({ ctx }) => ctx.tree(definition);
}

export function validateTreeDefinition(definition: unknown): string[] {
  return compileTreeDefinition(definition).diagnostics;
}

export function validateTree(ctx: ValidationContext, definition: TreeDefinition): Finding[] {
  const compiled = compileTreeDefinition(definition);
  if (compiled.diagnostics.length > 0) return treeDefinitionFindings(ctx, compiled.diagnostics);

  const findings: Finding[] = [];
  const nodes = flattenTree(compiled.paths);
  const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
  const targetFolders = foldersForFiles(ctx.targetFiles);

  for (const ruleNode of nodes) {
    if (ruleNode.node.files) findings.push(...validateFileRules(ctx, ruleNode, ruleNode.node.files));
    if (ruleNode.node.folders) findings.push(...validateFolderRules(ctx, ruleNode, ruleNode.node.folders, targetFolders));
    if (ruleNode.node.imports) findings.push(...validateImportRules(ctx, ruleNode, ruleNode.node.imports, targetPaths));
  }

  findings.push(...validateBoundaryRules(ctx, compiled, targetPaths));
  return findings;
}

function treeDefinitionFindings(ctx: ValidationContext, diagnostics: string[]): Finding[] {
  return diagnostics.map((diagnostic) =>
    ctx.report({
      file: "<tree-definition>",
      line: 1,
      message: diagnostic,
      fix: {
        safety: "manual",
        description: "Fix the ctx.tree() definition.",
      },
    }),
  );
}

function validateFileRules(ctx: ValidationContext, ruleNode: TreeRuleNode, rules: TreeFileRules): Finding[] {
  const suffixes = list(rules.suffix);
  const allowNames = new Set(rules.allowNames ?? []);
  if (suffixes.length === 0 && allowNames.size === 0) return [];

  return ctx.targetFiles
    .filter((file) => matchesTreeFile(file.path, ruleNode.pattern, rules.match))
    .filter((file) => !allowNames.has(path.posix.basename(file.path)))
    .filter((file) => suffixes.length > 0 && !suffixes.some((suffix) => file.path.endsWith(suffix)))
    .map((file) =>
      file.report({
        line: 1,
        message: rules.message ?? `File must use one of the configured suffixes: ${suffixes.join(", ")}.`,
        fix: rules.fix ?? {
          safety: "manual",
          description: "Rename the file to match the project tree convention and update imports.",
        },
        docs: docsFor(ruleNode, rules.docs),
      }),
    );
}

function validateFolderRules(ctx: ValidationContext, ruleNode: TreeRuleNode, rules: TreeFolderRules, targetFolders: Set<string>): Finding[] {
  const denyNames = new Set(rules.denyNames ?? []);
  if (denyNames.size === 0) return [];

  const findings: Finding[] = [];
  for (const folder of ctx.folders()) {
    if (!targetFolders.has(folder.path)) continue;
    if (!matchesTreeFolder(folder.path, ruleNode.pattern)) continue;
    const folderName = path.posix.basename(folder.path);

    if (denyNames.has(folderName)) {
      findings.push(
        ctx.report({
          file: folder.path,
          line: 1,
          message: rules.message ?? "Folder name is not allowed by the project tree convention.",
          fix: rules.fix ?? {
            safety: "manual",
            description: "Move the touched flow into a responsibility-named folder.",
          },
          docs: docsFor(ruleNode, rules.docs),
        }),
      );
    }
  }

  return findings;
}

function validateImportRules(ctx: ValidationContext, ruleNode: TreeRuleNode, rules: TreeImportRules, targetPaths: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const allow = list(rules.allow);
  const deny = list(rules.deny);

  for (const edge of ctx.imports()) {
    if (!targetPaths.has(edge.from.path)) continue;
    if (!matchesTreeFile(edge.from.path, ruleNode.pattern)) continue;

    if (rules.maxRelativeDepth !== undefined && edge.relativeDepth > rules.maxRelativeDepth) {
      findings.push(
        edge.from.report({
          line: edge.line,
          message: rules.message ?? `Relative import depth must be at most ${rules.maxRelativeDepth}.`,
          fix: rules.fix ?? {
            safety: "manual",
            description: "Use the approved import surface or move files closer to their owner.",
          },
          docs: docsFor(ruleNode, rules.docs),
        }),
      );
    }

    if (deny.length > 0 && importMatches(edge, deny)) {
      findings.push(
        edge.from.report({
          line: edge.line,
          message: rules.message ?? `Import is denied by the project tree boundary: ${edge.source}.`,
          fix: rules.fix ?? {
            safety: "manual",
            description: "Route the dependency through the approved layer boundary.",
          },
          docs: docsFor(ruleNode, rules.docs),
        }),
      );
    }

    if (allow.length > 0 && edge.resolvedPath && !matchesAny(edge.resolvedPath, [...allow, ...nodeFilePatterns(ruleNode.pattern)])) {
      findings.push(
        edge.from.report({
          line: edge.line,
          message: rules.message ?? `Import is outside the allowed project tree boundary: ${edge.source}.`,
          fix: rules.fix ?? {
            safety: "manual",
            description: "Import from an allowed layer or keep the dependency inside the current tree node.",
          },
          docs: docsFor(ruleNode, rules.docs),
        }),
      );
    }
  }

  return findings;
}

function validateBoundaryRules(ctx: ValidationContext, definition: CompiledTreeDefinition, targetPaths: Set<string>): Finding[] {
  const findings: Finding[] = [];

  for (const rule of definition.boundaries) {
    const from = expandBoundaryRefs(list(rule.from), definition.nodes);
    const allow = expandBoundaryRefs(list(rule.allow), definition.nodes);
    const deny = expandBoundaryRefs(list(rule.deny), definition.nodes);

    for (const edge of ctx.imports()) {
      if (!targetPaths.has(edge.from.path)) continue;
      if (!matchesAny(edge.from.path, from)) continue;

      if (deny.length > 0 && importMatches(edge, deny)) {
        findings.push(
          edge.from.report({
            line: edge.line,
            message: rule.message ?? `Import is denied by the project boundary: ${edge.source}.`,
            fix: rule.fix ?? {
              safety: "manual",
              description: "Route the dependency through the approved layer boundary.",
            },
            docs: rule.docs,
          }),
        );
      }

      if (allow.length > 0 && edge.resolvedPath && !matchesAny(edge.resolvedPath, [...allow, ...from])) {
        findings.push(
          edge.from.report({
            line: edge.line,
            message: rule.message ?? `Import is outside the allowed project boundary: ${edge.source}.`,
            fix: rule.fix ?? {
              safety: "manual",
              description: "Import from an allowed layer or keep the dependency inside the current boundary node.",
            },
            docs: rule.docs,
          }),
        );
      }
    }
  }

  return findings;
}

function flattenTree(definition: TreePathDefinition, parent = ""): TreeRuleNode[] {
  const nodes: TreeRuleNode[] = [];
  for (const [key, node] of Object.entries(definition)) {
    const pattern = joinPattern(parent, key);
    nodes.push({ pattern, node });
    if (node.children) nodes.push(...flattenTree(node.children, pattern));
  }
  return nodes;
}

function compileTreeDefinition(definition: unknown): CompiledTreeDefinition {
  const diagnostics: string[] = [];

  if (!isPlainObject(definition)) {
    return {
      paths: {},
      nodes: {},
      boundaries: [],
      diagnostics: ["Tree definition must be an object."],
    };
  }

  if (isGraphDefinition(definition)) {
    const graph = definition as Partial<TreeGraphDefinition>;
    for (const key of Object.keys(graph)) {
      if (!["paths", "nodes", "boundaries"].includes(key)) diagnostics.push(`Unknown tree graph key: ${key}.`);
    }

    const paths = isPlainObject(graph.paths) ? (graph.paths as TreePathDefinition) : {};
    const nodes = compileNamedNodes(graph.nodes, diagnostics);
    const boundaries = compileBoundaries(graph.boundaries, nodes, diagnostics);

    if (graph.paths !== undefined && !isPlainObject(graph.paths)) diagnostics.push("Tree paths must be an object when present.");
    diagnostics.push(...validatePathDefinition(paths));

    return { paths, nodes, boundaries, diagnostics };
  }

  const paths = definition as TreePathDefinition;
  diagnostics.push(...validatePathDefinition(paths));
  return { paths, nodes: {}, boundaries: [], diagnostics };
}

function compileNamedNodes(value: unknown, diagnostics: string[]): Record<string, string[]> {
  const nodes: Record<string, string[]> = {};
  if (value === undefined) return nodes;
  if (!isPlainObject(value)) {
    diagnostics.push("Tree nodes must be an object when present.");
    return nodes;
  }

  for (const [name, patterns] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) diagnostics.push(`Tree node name must be identifier-like: ${name}.`);
    const patternList = list(patterns as string | string[] | undefined);
    if (patternList.length === 0) diagnostics.push(`Tree node ${name} needs at least one glob pattern.`);
    if (patternList.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
      diagnostics.push(`Tree node ${name} patterns must be non-empty strings.`);
      continue;
    }
    for (const issue of validatePatterns(patternList)) diagnostics.push(`Tree node ${name}: ${issue}`);
    nodes[name] = patternList;
  }

  return nodes;
}

function compileBoundaries(value: unknown, nodes: Record<string, string[]>, diagnostics: string[]): TreeBoundaryRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push("Tree boundaries must be an array when present.");
    return [];
  }

  const boundaries: TreeBoundaryRule[] = [];
  for (const [index, boundary] of value.entries()) {
    const label = `Tree boundary ${index + 1}`;
    if (!isPlainObject(boundary)) {
      diagnostics.push(`${label} must be an object.`);
      continue;
    }

    for (const key of Object.keys(boundary)) {
      if (!["from", "allow", "deny", "message", "fix", "docs"].includes(key)) diagnostics.push(`${label} has unknown key: ${key}.`);
    }

    const rule = boundary as Partial<TreeBoundaryRule>;
    validateBoundaryRefs(label, "from", rule.from, nodes, diagnostics, { required: true });
    validateBoundaryRefs(label, "allow", rule.allow, nodes, diagnostics);
    validateBoundaryRefs(label, "deny", rule.deny, nodes, diagnostics);
    if (rule.allow && rule.deny) {
      const duplicates = list(rule.allow).filter((item) => list(rule.deny).includes(item));
      for (const duplicate of duplicates) diagnostics.push(`${label} both allows and denies ${duplicate}.`);
    }
    if (rule.message !== undefined && typeof rule.message !== "string") diagnostics.push(`${label} message must be a string when present.`);
    validateStringArray(`${label} docs`, rule.docs, diagnostics);

    boundaries.push(rule as TreeBoundaryRule);
  }

  return boundaries;
}

function matchesTreeFile(file: string, nodePattern: string, match?: string | string[]): boolean {
  return matchesAny(file, qualifiedFilePatterns(nodePattern, match));
}

function matchesTreeFolder(folder: string, nodePattern: string): boolean {
  return matchesAny(folder, [nodePattern, `${nodePattern}/**`]);
}

function qualifiedFilePatterns(nodePattern: string, match?: string | string[]): string[] {
  const matches = list(match);
  if (matches.length === 0) return nodeFilePatterns(nodePattern);
  return matches.map((pattern) => qualifyPattern(nodePattern, pattern));
}

function nodeFilePatterns(nodePattern: string): string[] {
  return [`${nodePattern}/**/*`];
}

function qualifyPattern(base: string, pattern: string): string {
  const negated = pattern.startsWith("!");
  const body = normalizePatternPart(negated ? pattern.slice(1) : pattern);
  const qualified = joinPattern(base, body);
  return negated ? `!${qualified}` : qualified;
}

function joinPattern(parent: string, child: string): string {
  const normalizedParent = normalizePatternPart(parent);
  const normalizedChild = normalizePatternPart(child);
  if (!normalizedParent) return normalizedChild;
  if (!normalizedChild) return normalizedParent;
  return `${normalizedParent}/${normalizedChild}`;
}

function normalizePatternPart(value: string): string {
  return normalizePath(value).replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function validatePathDefinition(definition: TreePathDefinition, parent = ""): string[] {
  const diagnostics: string[] = [];
  for (const [key, node] of Object.entries(definition)) {
    const pattern = joinPattern(parent, key);
    if (!key) diagnostics.push("Tree path key must not be empty.");
    for (const issue of validatePatterns([pattern])) diagnostics.push(`Tree path ${pattern}: ${issue}`);

    if (!isPlainObject(node)) {
      diagnostics.push(`Tree path ${pattern} must be an object.`);
      continue;
    }

    for (const nodeKey of Object.keys(node)) {
      if (!["docs", "files", "folders", "imports", "children"].includes(nodeKey)) diagnostics.push(`Tree path ${pattern} has unknown key: ${nodeKey}.`);
    }

    validateStringArray(`Tree path ${pattern} docs`, node.docs, diagnostics);
    if (node.files !== undefined) validateFileRuleDefinition(`Tree path ${pattern} files`, node.files, diagnostics);
    if (node.folders !== undefined) validateFolderRuleDefinition(`Tree path ${pattern} folders`, node.folders, diagnostics);
    if (node.imports !== undefined) validateImportRuleDefinition(`Tree path ${pattern} imports`, node.imports, diagnostics);
    if (node.children !== undefined) {
      if (!isPlainObject(node.children)) diagnostics.push(`Tree path ${pattern} children must be an object when present.`);
      else diagnostics.push(...validatePathDefinition(node.children, pattern));
    }
  }
  return diagnostics;
}

function validateFileRuleDefinition(label: string, value: unknown, diagnostics: string[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(`${label} must be an object.`);
    return;
  }
  const rule = value as Partial<TreeFileRules>;
  for (const key of Object.keys(rule)) {
    if (!["match", "suffix", "allowNames", "message", "fix", "docs"].includes(key)) diagnostics.push(`${label} has unknown key: ${key}.`);
  }
  validateStringOrStringArray(`${label}.match`, rule.match, diagnostics, { glob: true });
  validateStringOrStringArray(`${label}.suffix`, rule.suffix, diagnostics);
  validateStringArray(`${label}.allowNames`, rule.allowNames, diagnostics);
  validateStringArray(`${label}.docs`, rule.docs, diagnostics);
  if (rule.message !== undefined && typeof rule.message !== "string") diagnostics.push(`${label}.message must be a string when present.`);
  if (rule.fix !== undefined && !isPlainObject(rule.fix)) diagnostics.push(`${label}.fix must be an object when present.`);
}

function validateFolderRuleDefinition(label: string, value: unknown, diagnostics: string[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(`${label} must be an object.`);
    return;
  }
  const rule = value as Partial<TreeFolderRules>;
  for (const key of Object.keys(rule)) {
    if (!["denyNames", "message", "fix", "docs"].includes(key)) diagnostics.push(`${label} has unknown key: ${key}.`);
  }
  validateStringArray(`${label}.denyNames`, rule.denyNames, diagnostics);
  validateStringArray(`${label}.docs`, rule.docs, diagnostics);
  if (rule.message !== undefined && typeof rule.message !== "string") diagnostics.push(`${label}.message must be a string when present.`);
  if (rule.fix !== undefined && !isPlainObject(rule.fix)) diagnostics.push(`${label}.fix must be an object when present.`);
}

function validateImportRuleDefinition(label: string, value: unknown, diagnostics: string[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(`${label} must be an object.`);
    return;
  }
  const rule = value as Partial<TreeImportRules>;
  for (const key of Object.keys(rule)) {
    if (!["allow", "deny", "maxRelativeDepth", "message", "fix", "docs"].includes(key)) diagnostics.push(`${label} has unknown key: ${key}.`);
  }
  validateStringArray(`${label}.allow`, rule.allow, diagnostics, { glob: true });
  validateStringArray(`${label}.deny`, rule.deny, diagnostics, { glob: true });
  validateStringArray(`${label}.docs`, rule.docs, diagnostics);
  if (rule.maxRelativeDepth !== undefined && (!Number.isInteger(rule.maxRelativeDepth) || rule.maxRelativeDepth < 0)) {
    diagnostics.push(`${label}.maxRelativeDepth must be a non-negative integer when present.`);
  }
  if (rule.message !== undefined && typeof rule.message !== "string") diagnostics.push(`${label}.message must be a string when present.`);
  if (rule.fix !== undefined && !isPlainObject(rule.fix)) diagnostics.push(`${label}.fix must be an object when present.`);
}

function validateBoundaryRefs(
  label: string,
  key: string,
  value: string | string[] | undefined,
  nodes: Record<string, string[]>,
  diagnostics: string[],
  options: { required?: boolean } = {},
): void {
  const values = list(value);
  if (options.required && values.length === 0) diagnostics.push(`${label} ${key} needs at least one node or glob.`);
  if (values.some((item) => typeof item !== "string" || item.length === 0)) {
    diagnostics.push(`${label} ${key} entries must be non-empty strings.`);
    return;
  }
  for (const item of values) {
    if (nodes[item]) continue;
    if (looksLikeGlob(item)) {
      for (const issue of validatePatterns([item])) diagnostics.push(`${label} ${key} ${item}: ${issue}`);
      continue;
    }
    diagnostics.push(`${label} ${key} references unknown tree node: ${item}.`);
  }
}

function validateStringArray(label: string, value: string[] | undefined, diagnostics: string[], options: { glob?: boolean } = {}): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    diagnostics.push(`${label} must be an array of non-empty strings when present.`);
    return;
  }
  if (value.length === 0) diagnostics.push(`${label} must not be empty when present.`);
  if (options.glob) {
    for (const issue of validatePatterns(value)) diagnostics.push(`${label}: ${issue}`);
  }
}

function validateStringOrStringArray(
  label: string,
  value: string | string[] | undefined,
  diagnostics: string[],
  options: { glob?: boolean } = {},
): void {
  if (value === undefined) return;
  if (typeof value !== "string" && !Array.isArray(value)) {
    diagnostics.push(`${label} must be a string or string[] when present.`);
    return;
  }
  const values = list(value);
  if (values.some((item) => typeof item !== "string" || item.length === 0)) {
    diagnostics.push(`${label} must contain non-empty strings.`);
    return;
  }
  if (values.length === 0) diagnostics.push(`${label} must not be empty when present.`);
  if (options.glob) {
    for (const issue of validatePatterns(values)) diagnostics.push(`${label}: ${issue}`);
  }
}

function expandBoundaryRefs(values: string[], nodes: Record<string, string[]>): string[] {
  return values.flatMap((value) => nodes[value] ?? [value]);
}

function isGraphDefinition(value: Record<string, unknown>): boolean {
  return "paths" in value || "nodes" in value || "boundaries" in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeGlob(value: string): boolean {
  return /[*/{}[\]!?]|\//.test(value);
}

function importMatches(edge: ImportEdge, patterns: string[]): boolean {
  const normalizedSource = normalizePath(edge.source);
  const unrootedSource = normalizedSource.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  return unique([edge.resolvedPath, normalizedSource, unrootedSource].filter((value): value is string => Boolean(value))).some((candidate) =>
    matchesAny(candidate, patterns),
  );
}

function foldersForFiles(files: ProjectFile[]): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
  }
  return folders;
}

function docsFor(ruleNode: TreeRuleNode, ruleDocs: string[] | undefined): string[] | undefined {
  const docs = unique([...(ruleNode.node.docs ?? []), ...(ruleDocs ?? [])]);
  return docs.length > 0 ? docs : undefined;
}

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
