import { fileNames } from "@opencanon/validators";

const validator = fileNames({
  id: "folder-file-naming",
  title: "Service files use the service suffix",
  topics: ["folder-structure", "service"],
  in: ["src/services/**/*.{ts,tsx}", "packages/*/src/services/**/*.{ts,tsx}"],
  severity: "error",
  related: ["folder-structure-current"],
  suffix: [".service.ts", ".service.tsx"],
  allowNames: ["index.ts", "index.tsx"],
  message: "Service implementation files must use the *.service.ts naming pattern.",
  fix: {
    safety: "manual",
    description: "Rename the service file to *.service.ts or *.service.tsx and update imports.",
  },
  docs: ["docs/opencanon/canon/folder-file-naming.md#service-files-use-the-service-suffix"],
});

export default validator;
