/**
 * Adapt language-neutral engine `FileFacts` into the per-language accessor shapes:
 * `file.ts.*` (ImportInfo / ExportInfo / FunctionInfo / TypeScriptDeclaration /
 * CallInfo / LiteralInfo / CommentInfo) and `file.py.*` (PythonImportInfo /
 * PythonFunctionInfo / PythonClassInfo). Pure functions — core owns this
 * adaptation; the engine-backed provider only returns raw FileFacts via
 * `factsFor`. This is the seam between the universal fact contract and the
 * per-language accessor surfaces.
 */
import type { CommentFact, DeclarationFact, FileFacts } from "./contracts.ts";
import type { PythonClassInfo, PythonFunctionInfo, PythonImportInfo } from "./python.ts";
import { TypeScriptDeclarationKind } from "./typescript.ts";
import { ProjectSymbolKind } from "./validator-types.ts";
import type { FunctionInfo, ImportInfo, ExportInfo, LiteralInfo, TypeScriptDeclaration } from "./typescript.ts";
import type { CallInfo, CommentInfo } from "./validator-types.ts";

export function mapImports(file: FileFacts | undefined): ImportInfo[] {
  // ImportInfo.kind is import|export; engine emits import|export|dynamic. Map via a
  // lookup (object-property context) rather than equality on a soft-enum literal.
  const importKind = { import: "import", export: "export", dynamic: "import" } as const;
  return (file?.imports ?? []).map((i) => ({
    line: i.line,
    source: i.source,
    specifiers: i.specifiers ?? [],
    kind: importKind[i.kind] ?? "import",
  }));
}

export function mapExports(file: FileFacts | undefined): ExportInfo[] {
  return (file?.exports ?? []).map((i) => ({
    line: i.line,
    name: i.name,
    kind: i.kind,
    source: i.source,
    importedName: i.importedName,
    typeOnly: i.typeOnly,
  }));
}

export function mapFunctions(file: FileFacts | undefined, text: string): FunctionInfo[] {
  // Membership/lookup rather than equality on soft-enum literals (FunctionInfo kinds
  // are function|method).
  const functionKinds = new Set(["function", "method"]);
  const toFunctionKind = { method: "method", function: "function" } as const;
  return (file?.symbols ?? [])
    .filter((symbol) => functionKinds.has(symbol.kind))
    .map((symbol) => {
      const kind = toFunctionKind[symbol.kind as "function" | "method"] ?? toFunctionKind.function;
      const signature = declarationText(text, symbol.line, symbol.endLine).split(/\r?\n/, 1)[0]?.trim() ?? "";
      return {
        line: symbol.line,
        name: symbol.name,
        kind,
        exported: symbol.exported,
        async: /\basync\b/.test(signature),
        params: symbol.params ?? [],
        signature,
      };
    });
}

export function mapDeclarations(file: FileFacts | undefined): TypeScriptDeclaration[] {
  return (file?.declarations ?? []).map(declarationFromEngine).filter((declaration): declaration is TypeScriptDeclaration => declaration !== null);
}

export function mapCalls(file: FileFacts | undefined): CallInfo[] {
  return (file?.calls ?? []).map(callFromEngine);
}

export function mapLiterals(file: FileFacts | undefined): LiteralInfo[] {
  return (file?.literals ?? []).map((literal) => ({
    line: literal.line,
    column: literal.column ?? 1,
    value: literal.value,
    valueKind: literal.valueKind,
    context: literal.context as LiteralInfo["context"],
    declarationSourceId: literal.declarationSourceId,
  }));
}

export function mapComments(file: FileFacts | undefined): CommentInfo[] {
  const commentKind = { line: "line", block: "block" } as const;
  return (file?.comments ?? []).map((comment: CommentFact) => ({
    line: comment.line,
    column: comment.column ?? 1,
    text: comment.text,
    kind: commentKind[comment.kind],
  }));
}

export function mapPythonImports(file: FileFacts | undefined): PythonImportInfo[] {
  return (file?.imports ?? []).map((item) => ({
    line: item.line,
    module: item.source,
    names: item.specifiers ?? [],
    kind: pythonImportKind(item.source, item.specifiers ?? []),
  }));
}

export function mapPythonFunctions(file: FileFacts | undefined, text: string): PythonFunctionInfo[] {
  const pythonFunctionKinds = new Set(["function", "method"]);
  return (file?.symbols ?? [])
    .filter((symbol) => pythonFunctionKinds.has(symbol.kind))
    .map((symbol) => ({
      line: symbol.line,
      name: symbol.name,
      kind: symbol.kind === "method" ? "method" : "function",
      async: /^\s*async\s+def\b/.test(lineText(text, symbol.line)),
      params: symbol.params ?? [],
    }));
}

export function mapPythonClasses(file: FileFacts | undefined): PythonClassInfo[] {
  return (file?.symbols ?? [])
    .filter((symbol) => symbol.kind === ProjectSymbolKind.Class)
    .map((symbol) => ({
      line: symbol.line,
      name: symbol.name,
    }));
}

export function mapPythonCalls(file: FileFacts | undefined): CallInfo[] {
  return (file?.calls ?? []).map(callFromEngine);
}

function callFromEngine(call: NonNullable<FileFacts["calls"]>[number]): CallInfo {
  return {
    line: call.line,
    column: call.column,
    name: call.name,
    receiver: call.receiver,
    callee: call.callee,
    tryDepth: call.tryDepth ?? 0,
    argumentCalls: call.argumentCalls ?? [],
  };
}

function pythonImportKind(source: string, specifiers: string[]): PythonImportInfo["kind"] {
  if (specifiers.length === 1 && source === pythonImportedName(specifiers[0])) return "import";
  return "from";
}

function pythonImportedName(specifier: string): string {
  return specifier.replace(/\s+as\s+.+$/, "").trim();
}

function declarationFromEngine(declaration: DeclarationFact): TypeScriptDeclaration | null {
  const base = {
    name: declaration.name,
    exported: declaration.exported,
    line: declaration.line,
    endLine: declaration.endLine,
    text: declaration.text,
  };
  if (declaration.kind === TypeScriptDeclarationKind.Enum) {
    return {
      ...base,
      kind: TypeScriptDeclarationKind.Enum,
      constEnum: declaration.constEnum ?? false,
      members: declaration.members.map((member) => ({
        name: member.name,
        value: member.value,
        valueKind: member.valueKind,
        line: member.line,
      })),
    };
  }
  if (declaration.kind === TypeScriptDeclarationKind.Variable) {
    const initializer = declaration.initializer ?? { kind: "unknown" as const, asConst: false, properties: [] };
    return {
      ...base,
      kind: TypeScriptDeclarationKind.Variable,
      declarationKind: declaration.declarationKind ?? "const",
      initializer: {
        kind: initializer.kind,
        asConst: initializer.asConst,
        satisfies: initializer.satisfies,
        properties: initializer.properties.map((property) => ({
          key: property.key,
          quoted: property.quoted,
          value: property.value,
          valueKind: property.valueKind,
          line: property.line,
        })),
      },
    };
  }
  if (declaration.kind === TypeScriptDeclarationKind.Function) {
    return { ...base, kind: TypeScriptDeclarationKind.Function, async: declaration.async ?? false };
  }
  if (declaration.kind === TypeScriptDeclarationKind.Class) return { ...base, kind: TypeScriptDeclarationKind.Class };
  if (declaration.kind === TypeScriptDeclarationKind.Type) return { ...base, kind: TypeScriptDeclarationKind.Type };
  if (declaration.kind === TypeScriptDeclarationKind.Interface) return { ...base, kind: TypeScriptDeclarationKind.Interface };
  return null;
}

function declarationText(text: string, line: number, endLine = line): string {
  return text
    .split(/\r?\n/)
    .slice(line - 1, endLine)
    .join("\n")
    .trim();
}

function lineText(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1] ?? "";
}
