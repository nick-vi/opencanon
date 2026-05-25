import { fileNames } from "@opencanon/validators";

const validator = fileNames({
  id: "folder-file-naming",
  topics: ["folder-structure", "service"],
  in: ["src/services/**/*.{ts,tsx}", "packages/*/src/services/**/*.{ts,tsx}"],
  severity: "error",
  decisionIds: ["folder-structure-current"],
  suffix: [".service.ts", ".service.tsx"],
  allowNames: ["index.ts", "index.tsx"],
  message: "Service implementation files must use the *.service.ts naming pattern.",
  fix: {
    safety: "manual",
    description: "Rename the service file to *.service.ts or *.service.tsx and update imports.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#folder-structure-current"],
});

export default validator;
