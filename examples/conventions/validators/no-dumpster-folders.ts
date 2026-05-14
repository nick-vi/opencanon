import { noFolderNames } from "../../../.agents/skills/opencanon/index.ts";

const validator = noFolderNames({
  id: "no-dumpster-folders",
  topics: ["folder-structure"],
  in: ["src", "tests", "packages/*/src"],
  severity: "warning",
  decisionIds: ["folder-structure-current"],
  names: ["misc", "helpers", "common", "temp", "new", "draft"],
  message: "Folder name is too ambiguous for source ownership.",
  fix: {
    safety: "manual",
    description: "Move the touched flow into a responsibility-named folder or add a convention decision for the new folder.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#folder-structure-current"],
});

export default validator;
