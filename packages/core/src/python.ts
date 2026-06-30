export type PythonImportInfo = {
  line: number;
  module: string;
  names: string[];
  kind: "import" | "from";
};

export type PythonFunctionInfo = {
  line: number;
  name: string;
  kind: "function" | "method";
  async: boolean;
  params: string[];
};

export type PythonClassInfo = {
  line: number;
  name: string;
};
