import { unique } from "./core-utils.ts";
import { ProjectFileLanguage } from "./language-registry.ts";
import type {
  ImportEdge,
  ProjectAnnotationFact,
  ProjectCallFact,
  ProjectComment,
  ProjectDiagnosticFact,
  ProjectDuplicateFact,
  ProjectExportFact,
  ProjectFile,
  ProjectLiteralFact,
  ProjectReferenceFact,
  ProjectSymbolFact,
} from "./validator-types.ts";
import { ImportEdgeKind } from "./validator-types.ts";
import { LiteralValueKind } from "./typescript.ts";

const FactKeySeparator = "\u0000";

export function buildExportFacts(files: ProjectFile[]): ProjectExportFact[] {
  return files.flatMap((file) => {
    if (file.language !== ProjectFileLanguage.TypeScript && file.language !== ProjectFileLanguage.Svelte) return [];
    return file.ts.exports().map((item) => ({ ...item, file, language: file.language }));
  });
}

export function buildSymbolFacts(files: ProjectFile[]): ProjectSymbolFact[] {
  const facts: ProjectSymbolFact[] = [];
  for (const file of files) {
    if (file.language === ProjectFileLanguage.TypeScript || file.language === ProjectFileLanguage.Svelte) {
      const exportedNames = new Set(
        file
          .ts.exports()
          .filter((item) => !item.source && item.kind !== "star-reexport")
          .map((item) => item.name),
      );
      for (const fn of file.ts.functions()) {
        facts.push({
          file,
          language: file.language,
          line: fn.line,
          name: fn.name,
          kind: fn.kind ?? "function",
          exported: fn.exported || exportedNames.has(fn.name),
          params: fn.params,
        });
      }
      for (const declaration of file.ts.declarations()) {
        facts.push({
          file,
          language: file.language,
          line: declaration.line,
          endLine: declaration.endLine,
          name: declaration.name,
          kind: symbolKindForDeclaration(declaration.kind),
          exported: declaration.exported || exportedNames.has(declaration.name),
        });
      }
      continue;
    }

    if (file.language === ProjectFileLanguage.Python) {
      for (const fn of file.py.functions()) {
        facts.push({
          file,
          language: file.language,
          line: fn.line,
          name: fn.name,
          kind: fn.kind,
          exported: !fn.name.startsWith("_"),
          params: fn.params,
        });
      }
      for (const cls of file.py.classes()) {
        facts.push({
          file,
          language: file.language,
          line: cls.line,
          name: cls.name,
          kind: "class",
          exported: !cls.name.startsWith("_"),
        });
      }
    }
  }
  return uniqueSymbolFacts(facts);
}

export function buildCallFacts(files: ProjectFile[]): ProjectCallFact[] {
  const calls: ProjectCallFact[] = [];
  for (const file of files) {
    if (file.language !== ProjectFileLanguage.TypeScript && file.language !== ProjectFileLanguage.Svelte && file.language !== ProjectFileLanguage.Python) continue;
    const fileCalls = file.language === ProjectFileLanguage.Python ? file.py.calls() : file.ts.calls();
    for (const call of fileCalls) {
      calls.push({
        file,
        language: file.language,
        ...call,
      });
    }
  }
  return calls;
}

export function buildLiteralFacts(files: ProjectFile[]): ProjectLiteralFact[] {
  return files.flatMap((file) => {
    if (file.language !== ProjectFileLanguage.TypeScript && file.language !== ProjectFileLanguage.Svelte) return [];
    return file.ts.literals().map((item) => ({ ...item, file, language: file.language }));
  });
}

export function buildReferenceFacts(files: ProjectFile[], imports: ImportEdge[], symbols: ProjectSymbolFact[], calls: ProjectCallFact[]): ProjectReferenceFact[] {
  const references: ProjectReferenceFact[] = [];
  for (const edge of imports) {
    for (const specifier of edge.specifiers) {
      const name = importReferenceName(specifier);
      if (!name) continue;
      references.push({
        file: edge.from,
        language: edge.from.language,
        line: edge.line,
        name,
        kind: edge.kind === ImportEdgeKind.Export ? "export" : "import",
        targetPath: edge.resolvedPath,
        targetName: name,
      });
    }
  }

  for (const call of calls) {
    references.push({
      file: call.file,
      language: call.language,
      line: call.line,
      column: call.column,
      name: call.name,
      kind: "call",
    });
  }

  // Group exported symbols by name and scan each file ONCE with a single combined
  // word-boundary regex, instead of one regex per (file × symbol) — the latter is
  // quadratic and was the dominant cost of analysis on large repos. `\b…\b` anchoring
  // makes alternation order irrelevant (the whole word that matches is the same either
  // way), and emitting one reference per same-named symbol preserves the old semantics,
  // including duplicate exported names.
  const symbolsByName = new Map<string, ProjectSymbolFact[]>();
  for (const symbol of symbols) {
    if (!symbol.exported) continue;
    const existing = symbolsByName.get(symbol.name);
    if (existing) existing.push(symbol);
    else symbolsByName.set(symbol.name, [symbol]);
  }
  if (symbolsByName.size > 0) {
    const combined = new RegExp(`\\b(?:${[...symbolsByName.keys()].map((name) => RegExp.escape(name)).join("|")})\\b`, "g");
    for (const file of files) {
      for (const match of file.find(combined)) {
        const named = symbolsByName.get(match.text);
        if (!named) continue;
        for (const symbol of named) {
          if (symbol.file.path === file.path) continue;
          references.push({
            file,
            language: file.language,
            line: match.line,
            column: match.column,
            name: symbol.name,
            kind: "identifier",
            targetPath: symbol.file.path,
            targetName: symbol.name,
          });
        }
      }
    }
  }
  return dedupeReferences(references);
}

export function buildAnnotationFacts(comments: ProjectComment[], symbols: ProjectSymbolFact[]): ProjectAnnotationFact[] {
  const annotations: ProjectAnnotationFact[] = [];
  for (const comment of comments) {
    const owner = nearestFollowingSymbol(symbols, comment.file.path, comment.line);
    const tags = annotationTags(comment.text);
    for (const tag of tags) {
      annotations.push({
        file: comment.file,
        language: comment.file.language,
        line: comment.line,
        column: comment.column,
        tag: tag.tag,
        value: tag.value,
        raw: comment.text,
        ownerName: owner?.name,
      });
    }
  }
  return annotations;
}

export function buildDuplicateFacts(literals: ProjectLiteralFact[]): ProjectDuplicateFact[] {
  const groups = new Map<string, ProjectLiteralFact[]>();
  for (const literal of literals) {
    if (literal.valueKind !== LiteralValueKind.String) continue;
    if (!/[A-Za-z0-9]/.test(literal.value)) continue;
    const key = `${literal.valueKind}:${literal.value}`;
    groups.set(key, [...(groups.get(key) ?? []), literal]);
  }

  const duplicates: ProjectDuplicateFact[] = [];
  for (const [key, values] of groups) {
    if (values.length < 3) continue;
    const files = unique(values.map((value) => value.file.path));
    const first = values[0];
    duplicates.push({
      file: first.file,
      language: first.language,
      line: first.line,
      column: first.column,
      kind: "literal",
      key,
      value: first.value,
      occurrences: values.length,
      files,
    });
  }
  return duplicates;
}


export function symbolKindForDeclaration(kind: string): ProjectSymbolFact["kind"] {
  if (kind === "enum") return "enum";
  if (kind === "interface") return "interface";
  if (kind === "type") return "type";
  if (kind === "class") return "class";
  if (kind === "function") return "function";
  if (kind === "variable" || kind === "const" || kind === "let" || kind === "var") return "variable";
  return "unknown";
}

export function uniqueSymbolFacts(facts: ProjectSymbolFact[]): ProjectSymbolFact[] {
  const seen = new Set<string>();
  const output: ProjectSymbolFact[] = [];
  for (const fact of facts) {
    const key = [fact.file.path, fact.line, fact.name, fact.kind].join(FactKeySeparator);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(fact);
  }
  return output;
}

export function importReferenceName(specifier: string): string {
  return specifier.replace(/^type\s+/, "").replace(/\s+as\s+.+$/, "").trim();
}

export function dedupeReferences(references: ProjectReferenceFact[]): ProjectReferenceFact[] {
  const seen = new Set<string>();
  const output: ProjectReferenceFact[] = [];
  for (const reference of references) {
    const key = [reference.file.path, reference.line, reference.column ?? 0, reference.name, reference.kind, reference.targetPath ?? ""].join(FactKeySeparator);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reference);
  }
  return output;
}

export function nearestFollowingSymbol(symbols: ProjectSymbolFact[], filePath: string, line: number): ProjectSymbolFact | undefined {
  return symbols
    .filter((symbol) => symbol.file.path === filePath && symbol.line >= line)
    .sort((left, right) => left.line - right.line)[0];
}

export function annotationTags(text: string): Array<{ tag: string; value: string }> {
  const tags: Array<{ tag: string; value: string }> = [];
  for (const match of text.matchAll(/@([A-Za-z][\w-]*)(?:\s+([^@\n\r]+))?/g)) {
    tags.push({ tag: normalizeAnnotationTag(match[1]), value: (match[2] ?? "").trim() });
  }
  const lifecycle = text.match(/\b(deprecated|shim|compat|compatibility|legacy|remove[-\s]?by|owner|replacement)\b[:\s-]*(.*)$/i);
  if (lifecycle) tags.push({ tag: normalizeAnnotationTag(lifecycle[1]), value: lifecycle[2].trim() });
  return tags;
}

export function normalizeAnnotationTag(tag: string): string {
  const normalized = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (normalized === "compatibility") return "compat";
  if (normalized === "remove-by") return "remove-by";
  return normalized;
}

/** Parse diagnostics across files — surfaces malformed source the extractor could
 * not fully parse, so a broken file is never silently reported as clean. */
export function buildDiagnosticFacts(files: ProjectFile[]): ProjectDiagnosticFact[] {
  return files.flatMap((file) => file.diagnostics());
}
