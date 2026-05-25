import { noForbiddenCalls } from "@opencanon/validators";

const validator = noForbiddenCalls({
  id: "python-no-sys-path-mutation",
  topics: ["python"],
  in: ["src/python/**/*.py"],
  severity: "warning",
  decisionIds: ["python-module-boundaries"],
  calls: /\bsys\.path\.(append|insert)\s*\(/,
  message: "Python modules should not mutate sys.path to cross package boundaries.",
  fix: {
    safety: "manual",
    description: "Use package imports and configure the runner/module path instead.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#python-module-boundaries"],
});

export default validator;
