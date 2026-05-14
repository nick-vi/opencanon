export type ImportInfo = {
  line: number;
  source: string;
  specifiers: string[];
  kind: "import" | "export";
};

export type ExportInfo = {
  line: number;
  name: string;
  kind: "function" | "const" | "class" | "type" | "interface" | "unknown";
};

export type FunctionInfo = {
  line: number;
  name: string;
  exported: boolean;
  async: boolean;
  params: string[];
  signature: string;
};

export type LiteralContext =
  | "comparison"
  | "argument"
  | "object-property"
  | "array-item"
  | "type-union"
  | "const-object"
  | "import-source"
  | "test-title"
  | "unknown";

export type LiteralInfo = {
  value: string;
  valueKind: "string" | "number" | "boolean";
  line: number;
  column: number;
  context: LiteralContext;
};

export type TypeScriptDeclaration =
  | TypeScriptEnumDeclaration
  | TypeScriptVariableDeclaration
  | TypeScriptTypeDeclaration
  | TypeScriptFunctionDeclaration
  | TypeScriptClassDeclaration
  | TypeScriptInterfaceDeclaration;

export type TypeScriptDeclarationBase = {
  kind: "enum" | "variable" | "type" | "function" | "class" | "interface";
  name: string;
  exported: boolean;
  line: number;
  endLine: number;
  text: string;
};

export type EnumMemberInfo = {
  name: string;
  value?: string;
  valueKind: "string" | "number" | "unknown";
  line: number;
};

export type ObjectPropertyInfo = {
  key: string;
  quoted: boolean;
  value: string;
  valueKind: "string" | "number" | "boolean" | "unknown";
  line: number;
};

export type InitializerInfo = {
  kind: "object" | "array" | "literal" | "call" | "unknown";
  asConst: boolean;
  satisfies?: string;
  properties: ObjectPropertyInfo[];
};

export type TypeScriptEnumDeclaration = TypeScriptDeclarationBase & {
  kind: "enum";
  constEnum: boolean;
  members: EnumMemberInfo[];
};

export type TypeScriptVariableDeclaration = TypeScriptDeclarationBase & {
  kind: "variable";
  declarationKind: "const" | "let" | "var";
  initializer: InitializerInfo;
};

export type TypeScriptTypeDeclaration = TypeScriptDeclarationBase & {
  kind: "type";
};

export type TypeScriptFunctionDeclaration = TypeScriptDeclarationBase & {
  kind: "function";
  async: boolean;
};

export type TypeScriptClassDeclaration = TypeScriptDeclarationBase & {
  kind: "class";
};

export type TypeScriptInterfaceDeclaration = TypeScriptDeclarationBase & {
  kind: "interface";
};

export function parseTypeScriptImports(text: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const importMatch = line.match(/^\s*import(?:\s+type)?\s+(.+?)\s+from\s+["']([^"']+)["']/);
    const sideEffectMatch = line.match(/^\s*import\s+["']([^"']+)["']/);
    const exportMatch = line.match(/^\s*export\s+.+?\s+from\s+["']([^"']+)["']/);

    if (importMatch) {
      imports.push({
        line: index + 1,
        source: importMatch[2],
        specifiers: parseSpecifiers(importMatch[1]),
        kind: "import",
      });
      continue;
    }

    if (sideEffectMatch) {
      imports.push({
        line: index + 1,
        source: sideEffectMatch[1],
        specifiers: [],
        kind: "import",
      });
      continue;
    }

    if (exportMatch) {
      imports.push({
        line: index + 1,
        source: exportMatch[1],
        specifiers: [],
        kind: "export",
      });
    }
  }

  return imports;
}

export function parseSvelteTypeScriptImports(text: string): ImportInfo[] {
  return parseSvelteScriptBlocks(text).flatMap((block) => parseTypeScriptImports(block.text).map((item) => offsetImport(item, block.lineOffset)));
}

export function parseTypeScriptExports(text: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*export\s+(?:async\s+)?(function|const|class|type|interface)\s+([A-Za-z_$][\w$]*)/);
    if (!match) continue;
    exports.push({
      line: index + 1,
      kind: match[1] as ExportInfo["kind"],
      name: match[2],
    });
  }

  return exports;
}

export function parseSvelteTypeScriptExports(text: string): ExportInfo[] {
  return parseSvelteScriptBlocks(text).flatMap((block) => parseTypeScriptExports(block.text).map((item) => offsetExport(item, block.lineOffset)));
}

export function parseTypeScriptFunctions(text: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    if (!match) continue;
    functions.push({
      line: index + 1,
      name: match[3],
      exported: Boolean(match[1]),
      async: Boolean(match[2]),
      params: splitParams(match[4]),
      signature: line.trim(),
    });
  }

  return functions;
}

export function parseSvelteTypeScriptFunctions(text: string): FunctionInfo[] {
  return parseSvelteScriptBlocks(text).flatMap((block) => parseTypeScriptFunctions(block.text).map((item) => offsetFunction(item, block.lineOffset)));
}

export function parseTypeScriptDeclarations(text: string): TypeScriptDeclaration[] {
  const declarations: TypeScriptDeclaration[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const enumMatch = line.match(/^\s*(export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/);
    if (enumMatch) {
      const endIndex = findBlockEnd(lines, index);
      declarations.push({
        kind: "enum",
        name: enumMatch[3],
        exported: Boolean(enumMatch[1]),
        constEnum: Boolean(enumMatch[2]),
        line: index + 1,
        endLine: endIndex + 1,
        text: lines.slice(index, endIndex + 1).join("\n"),
        members: parseEnumMembers(lines.slice(index + 1, endIndex), index + 2),
      });
      index = endIndex;
      continue;
    }

    const variableMatch = line.match(/^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
    if (variableMatch) {
      const endIndex = variableMatch[4].trim().startsWith("{") ? findInitializerEnd(lines, index) : index;
      const declarationText = lines.slice(index, endIndex + 1).join("\n");
      declarations.push({
        kind: "variable",
        name: variableMatch[3],
        exported: Boolean(variableMatch[1]),
        declarationKind: variableMatch[2] as "const" | "let" | "var",
        line: index + 1,
        endLine: endIndex + 1,
        text: declarationText,
        initializer: parseInitializer(declarationText, index + 1),
      });
      index = endIndex;
      continue;
    }

    const typeMatch = line.match(/^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
    if (typeMatch) {
      declarations.push(simpleDeclaration("type", typeMatch[2], Boolean(typeMatch[1]), index, line));
      continue;
    }

    const functionMatch = line.match(/^\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\b/);
    if (functionMatch) {
      declarations.push({
        ...simpleDeclaration("function", functionMatch[3], Boolean(functionMatch[1]), index, line),
        async: Boolean(functionMatch[2]),
      });
      continue;
    }

    const classMatch = line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
    if (classMatch) {
      declarations.push(simpleDeclaration("class", classMatch[2], Boolean(classMatch[1]), index, line));
      continue;
    }

    const interfaceMatch = line.match(/^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (interfaceMatch) {
      declarations.push(simpleDeclaration("interface", interfaceMatch[2], Boolean(interfaceMatch[1]), index, line));
    }
  }

  return declarations;
}

export function parseSvelteTypeScriptDeclarations(text: string): TypeScriptDeclaration[] {
  return parseSvelteScriptBlocks(text).flatMap((block) => parseTypeScriptDeclarations(block.text).map((item) => offsetDeclaration(item, block.lineOffset)));
}

export function parseTypeScriptLiterals(text: string): LiteralInfo[] {
  const lines = text.split(/\r?\n/);
  const literals: LiteralInfo[] = [];
  const constObjectRanges = constObjectLineRanges(lines);
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = stripLineComment(line, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    if (!stripped.text.trim()) continue;
    if (/^\s*(?:import|export)\b.*\bfrom\s+["']/.test(stripped.text) || /^\s*import\s+["']/.test(stripped.text)) continue;

    const stringRanges: Array<{ start: number; end: number }> = [];

    for (const match of stripped.text.matchAll(/(["'])(?:(?=(\\?))\2.)*?\1/g)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const column = start + 1;
      stringRanges.push({ start, end: start + raw.length });
      literals.push({
        value: raw.slice(1, -1),
        valueKind: "string",
        line: index + 1,
        column,
        context: literalContext(stripped.text, column, raw.length, constObjectRanges.has(index + 1)),
      });
    }

    const primitiveText = maskRanges(stripped.text, stringRanges);

    for (const match of primitiveText.matchAll(/(?<![\w$.])-?\d+(?:\.\d+)?(?![\w$])/g)) {
      const column = (match.index ?? 0) + 1;
      literals.push({
        value: match[0],
        valueKind: "number",
        line: index + 1,
        column,
        context: literalContext(stripped.text, column, match[0].length, constObjectRanges.has(index + 1)),
      });
    }

    for (const match of primitiveText.matchAll(/\b(?:true|false)\b/g)) {
      const column = (match.index ?? 0) + 1;
      literals.push({
        value: match[0],
        valueKind: "boolean",
        line: index + 1,
        column,
        context: literalContext(stripped.text, column, match[0].length, constObjectRanges.has(index + 1)),
      });
    }
  }

  return literals;
}

export function parseSvelteTypeScriptLiterals(text: string): LiteralInfo[] {
  return parseSvelteScriptBlocks(text).flatMap((block) => parseTypeScriptLiterals(block.text).map((item) => ({ ...item, line: item.line + block.lineOffset })));
}

function simpleDeclaration<TKind extends "type" | "function" | "class" | "interface">(
  kind: TKind,
  name: string,
  exported: boolean,
  index: number,
  text: string,
): Extract<TypeScriptDeclaration, { kind: TKind }> {
  return {
    kind,
    name,
    exported,
    line: index + 1,
    endLine: index + 1,
    text: text.trim(),
  } as Extract<TypeScriptDeclaration, { kind: TKind }>;
}

function findBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0 && index > startIndex) return index;
    }
  }
  return startIndex;
}

function findInitializerEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }
    if (depth === 0 && index > startIndex) return index;
  }
  return startIndex;
}

function constObjectLineRanges(lines: string[]): Set<number> {
  const ranges = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const variableMatch = line.match(/^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*\{/);
    if (!variableMatch) continue;
    const endIndex = findInitializerEnd(lines, index);
    const text = lines.slice(index, endIndex + 1).join("\n");
    if (!/\bas\s+const\b/.test(text)) continue;
    for (let lineNumber = index + 1; lineNumber <= endIndex + 1; lineNumber += 1) ranges.add(lineNumber);
    index = endIndex;
  }
  return ranges;
}

function parseEnumMembers(lines: string[], firstLine: number): EnumMemberInfo[] {
  return lines
    .map((line, index) => {
      const match = line.trim().match(/^([A-Za-z_$][\w$]*)\s*(?:=\s*([^,]+))?,?$/);
      if (!match) return null;
      const rawValue = match[2]?.trim();
      const stringMatch = rawValue?.match(/^["']([^"']+)["']$/);
      const numberMatch = rawValue?.match(/^-?\d+(?:\.\d+)?$/);
      return {
        name: match[1],
        value: stringMatch?.[1] ?? rawValue,
        valueKind: stringMatch ? "string" : numberMatch ? "number" : rawValue ? "unknown" : "unknown",
        line: firstLine + index,
      } satisfies EnumMemberInfo;
    })
    .filter((item): item is EnumMemberInfo => Boolean(item));
}

function parseInitializer(text: string, firstLine: number): InitializerInfo {
  const initializerText = text.replace(/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/, "");
  const satisfies = initializerText.match(/\bsatisfies\s+([^;]+)$/)?.[1]?.trim();
  const asConst = /\bas\s+const\b/.test(initializerText);
  const startsWithObject = initializerText.trim().startsWith("{");
  return {
    kind: startsWithObject ? "object" : initializerText.trim().startsWith("[") ? "array" : initializerText.includes("(") ? "call" : "unknown",
    asConst,
    satisfies,
    properties: startsWithObject ? parseObjectProperties(text, firstLine) : [],
  };
}

function parseObjectProperties(text: string, firstLine: number): ObjectPropertyInfo[] {
  const lines = text.split(/\r?\n/);
  const properties: ObjectPropertyInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*([A-Za-z_$][\w$]*|["'][^"']+["'])\s*:\s*([^,]+),?\s*$/);
    if (!match) continue;
    const rawKey = match[1];
    const rawValue = match[2].trim();
    const stringMatch = rawValue.match(/^["']([^"']+)["']$/);
    const numberMatch = rawValue.match(/^-?\d+(?:\.\d+)?$/);
    const booleanMatch = rawValue.match(/^(true|false)$/);
    properties.push({
      key: rawKey.replace(/^["']|["']$/g, ""),
      quoted: rawKey.startsWith("\"") || rawKey.startsWith("'"),
      value: stringMatch?.[1] ?? rawValue,
      valueKind: stringMatch ? "string" : numberMatch ? "number" : booleanMatch ? "boolean" : "unknown",
      line: firstLine + index,
    });
  }

  return properties;
}

function maskRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text;
  const chars = [...text];
  for (const range of ranges) {
    for (let index = range.start; index < range.end && index < chars.length; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

function parseSpecifiers(value: string): string[] {
  return value
    .replace(/[{}]/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripLineComment(line: string, inBlockComment: boolean): { text: string; inBlockComment: boolean } {
  let text = "";
  let index = 0;
  let inString: string | null = null;
  let escaped = false;
  let block = inBlockComment;

  while (index < line.length) {
    const char = line[index];
    const next = line[index + 1];
    if (block) {
      if (char === "*" && next === "/") {
        text += "  ";
        block = false;
        index += 2;
        continue;
      }
      text += " ";
      index += 1;
      continue;
    }
    if (inString) {
      text += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === inString) inString = null;
      index += 1;
      continue;
    }
    if ((char === "\"" || char === "'") && !inString) {
      inString = char;
      text += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") break;
    if (char === "/" && next === "*") {
      text += "  ";
      block = true;
      index += 2;
      continue;
    }
    text += char;
    index += 1;
  }

  return { text, inBlockComment: block };
}

function literalContext(line: string, column: number, rawLength: number, inConstObject: boolean): LiteralContext {
  if (inConstObject) return "const-object";
  if (/\b(?:it|test|describe)\s*\(\s*["']/.test(line)) return "test-title";
  const before = line.slice(0, column - 1);
  const after = line.slice(column - 1 + rawLength);
  if (/\|\s*$/.test(before) || /^\s*\|/.test(after)) return "type-union";
  if (/:\s*$/.test(before)) return "object-property";
  if (/\[\s*[^[]*$/.test(before) && /^[^\]]*\]/.test(after)) return "array-item";
  if (/(===|!==|==|!=|>=|<=|>|<)\s*$/.test(before) || /^\s*(===|!==|==|!=|>=|<=|>|<)/.test(after)) return "comparison";
  if (/\(\s*[^()]*$/.test(before) && /^[^()]*\)/.test(after)) return "argument";
  return "unknown";
}

function splitParams(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSvelteScriptBlocks(text: string): Array<{ text: string; lineOffset: number }> {
  const blocks: Array<{ text: string; lineOffset: number }> = [];
  const scriptPattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

  for (const match of text.matchAll(scriptPattern)) {
    const fullMatch = match[0];
    const content = match[1] ?? "";
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const beforeContent = text.slice(0, (match.index ?? 0) + openTagEnd);
    blocks.push({
      text: content,
      lineOffset: beforeContent.split(/\r?\n/).length - 1,
    });
  }

  return blocks;
}

function offsetImport(item: ImportInfo, offset: number): ImportInfo {
  return { ...item, line: item.line + offset };
}

function offsetExport(item: ExportInfo, offset: number): ExportInfo {
  return { ...item, line: item.line + offset };
}

function offsetFunction(item: FunctionInfo, offset: number): FunctionInfo {
  return { ...item, line: item.line + offset };
}

function offsetDeclaration(item: TypeScriptDeclaration, offset: number): TypeScriptDeclaration {
  const base = { ...item, line: item.line + offset, endLine: item.endLine + offset };
  if (item.kind === "enum") {
    return {
      ...base,
      kind: "enum",
      constEnum: item.constEnum,
      members: item.members.map((member) => ({ ...member, line: member.line + offset })),
    };
  }
  if (item.kind === "variable") {
    return {
      ...base,
      kind: "variable",
      declarationKind: item.declarationKind,
      initializer: {
        ...item.initializer,
        properties: item.initializer.properties.map((property) => ({ ...property, line: property.line + offset })),
      },
    };
  }
  return base;
}
