import { noBareExcept } from "../../../.agents/skills/opencanon/index.ts";

const validator = noBareExcept({
  id: "python-no-bare-except",
  topics: ["python", "hygiene"],
  in: ["src/python/**/*.py"],
  severity: "warning",
  decisionIds: ["python-module-boundaries"],
  message: "Python code should catch specific exception types instead of using bare except clauses.",
  docs: ["examples/conventions/docs/opencanon/canon/language-python.md#python"],
});

export default validator;
