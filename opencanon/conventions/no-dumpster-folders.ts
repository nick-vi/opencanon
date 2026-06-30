import { noFolderNames } from "@opencanon/validators";

const validator = noFolderNames({
  id: "no-dumpster-folders",
  title: "Folders name real responsibilities",
  topics: ["folder-structure"],
  in: ["src", "tests", "packages/*/src"],
  severity: "warning",
  related: ["folder-structure-current"],
  names: ["misc", "helpers", "common", "temp", "new", "draft"],
  message: "Folder name is too ambiguous for source ownership.",
  fix: {
    safety: "manual",
    description: "Move the touched flow into a responsibility-named folder or add a convention for the new folder.",
  },
  docs: ["docs/opencanon/canon/no-dumpster-folders.md#folders-name-real-responsibilities"],
});

export default validator;
