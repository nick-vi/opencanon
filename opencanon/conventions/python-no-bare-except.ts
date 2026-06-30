import { noBareExcept } from "@opencanon/validators";

const validator = noBareExcept({
  id: "python-no-bare-except",
  title: "Python catches specific exception types",
  topics: ["python", "hygiene"],
  in: ["src/python/**/*.py"],
  severity: "warning",
  related: ["python-module-boundaries"],
  message: "Python code should catch specific exception types instead of using bare except clauses.",
  docs: ["docs/opencanon/canon/python-no-bare-except.md#python-catches-specific-exception-types"],
});

export default validator;
