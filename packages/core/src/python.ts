export type PythonImportInfo = {
  line: number;
  module: string;
  names: string[];
  kind: "import" | "from";
};

export type PythonFunctionInfo = {
  line: number;
  name: string;
  async: boolean;
  params: string[];
};

export type PythonClassInfo = {
  line: number;
  name: string;
};

export function parsePythonImports(text: string): PythonImportInfo[] {
  const imports: PythonImportInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    const fromMatch = line.match(/^\s*from\s+([A-Za-z_][\w.]*|\.+[A-Za-z_][\w.]*)\s+import\s+(.+)$/);

    if (fromMatch) {
      imports.push({
        line: index + 1,
        module: fromMatch[1],
        names: splitNames(fromMatch[2]),
        kind: "from",
      });
      continue;
    }

    if (importMatch) {
      for (const name of splitNames(importMatch[1])) {
        imports.push({
          line: index + 1,
          module: name.replace(/\s+as\s+.+$/, ""),
          names: [],
          kind: "import",
        });
      }
    }
  }

  return imports;
}

export function parsePythonFunctions(text: string): PythonFunctionInfo[] {
  const functions: PythonFunctionInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/);
    if (!match) continue;
    functions.push({
      line: index + 1,
      async: Boolean(match[1]),
      name: match[2],
      params: splitNames(match[3]),
    });
  }

  return functions;
}

export function parsePythonClasses(text: string): PythonClassInfo[] {
  const classes: PythonClassInfo[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*class\s+([A-Za-z_]\w*)\b/);
    if (!match) continue;
    classes.push({
      line: index + 1,
      name: match[1],
    });
  }

  return classes;
}

function splitNames(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
