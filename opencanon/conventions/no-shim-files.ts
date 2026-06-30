import { noShimFiles } from "@opencanon/validators";

const validator = noShimFiles({
  id: "no-shim-files",
  title: "Internal source does not preserve shim files",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  related: ["comments-current"],
  message: "Internal source files should not be named around shims, compatibility, legacy, or deprecated paths.",
  docs: ["docs/opencanon/canon/no-shim-files.md#internal-source-does-not-preserve-shim-files"],
});

export default validator;
