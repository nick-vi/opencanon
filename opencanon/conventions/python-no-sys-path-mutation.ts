import { noForbiddenCalls } from "@opencanon/validators";

const validator = noForbiddenCalls({
  id: "python-no-sys-path-mutation",
  title: "Python modules do not mutate sys.path",
  topics: ["python"],
  in: ["src/python/**/*.py"],
  severity: "warning",
  related: ["python-module-boundaries"],
  calls: /\bsys\.path\.(append|insert)\s*\(/,
  message: "Python modules should not mutate sys.path to cross package boundaries.",
  fix: {
    safety: "manual",
    description: "Use package imports and configure the runner/module path instead.",
  },
  docs: ["docs/opencanon/canon/python-no-sys-path-mutation.md#python-modules-do-not-mutate-syspath"],
});

export default validator;
