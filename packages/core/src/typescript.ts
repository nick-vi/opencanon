export type ImportInfo = {
  line: number;
  source: string;
  specifiers: string[];
  kind: "import" | "export";
};

export type ExportInfo = {
  line: number;
  name: string;
  kind: "function" | "class" | "const" | "let" | "var" | "type" | "interface" | "enum" | "default" | "reexport" | "star-reexport";
  source?: string;
  importedName?: string;
  typeOnly?: boolean;
};

export type FunctionInfo = {
  line: number;
  name: string;
  kind?: "function" | "method";
  exported: boolean;
  async: boolean;
  params: string[];
  signature: string;
};

// Single source of truth for literal contexts; reference members instead of inlining the strings.
export const LiteralContext = {
  Comparison: "comparison",
  Argument: "argument",
  ObjectProperty: "object-property",
  ArrayItem: "array-item",
  TypeUnion: "type-union",
  ConstObject: "const-object",
  ImportSource: "import-source",
  TestTitle: "test-title",
  Unknown: "unknown",
} as const;
export type LiteralContext = (typeof LiteralContext)[keyof typeof LiteralContext];

// Single source of truth for literal value kinds; reference members instead of inlining the strings.
export const LiteralValueKind = { String: "string", Number: "number", Boolean: "boolean" } as const;
export type LiteralValueKind = (typeof LiteralValueKind)[keyof typeof LiteralValueKind];

export type LiteralInfo = {
  value: string;
  valueKind: LiteralValueKind;
  line: number;
  column: number;
  context: LiteralContext;
  /**
   * Same-file identifier that introduces the literal (`const X = { ... } as const`
   * or `type X = '...' | '...'`). Undefined for literals not inside such a
   * declaration. A syntactic same-file fact — no cross-file resolution.
   */
  declarationSourceId?: string;
};

export type TypeScriptDeclaration =
  | TypeScriptEnumDeclaration
  | TypeScriptVariableDeclaration
  | TypeScriptTypeDeclaration
  | TypeScriptFunctionDeclaration
  | TypeScriptClassDeclaration
  | TypeScriptInterfaceDeclaration;

// Single source of truth for TypeScript declaration kinds; reference members instead of inlining the strings.
export const TypeScriptDeclarationKind = {
  Enum: "enum",
  Variable: "variable",
  Type: "type",
  Function: "function",
  Class: "class",
  Interface: "interface",
} as const;
export type TypeScriptDeclarationKind = (typeof TypeScriptDeclarationKind)[keyof typeof TypeScriptDeclarationKind];

export type TypeScriptDeclarationBase = {
  kind: TypeScriptDeclarationKind;
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
