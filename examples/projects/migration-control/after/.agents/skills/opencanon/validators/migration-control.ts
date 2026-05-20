import { migrationReferences } from "../index.ts";

export default migrationReferences({
  id: "old-api-migration",
  topics: ["migration", "deprecation"],
  severity: "error",
  in: ["src/**/*.ts"],
  pattern: "\\boldApi\\b",
  replacement: "currentApi",
  fixSafety: "suggested",
  existingSeverity: "warning",
  newSeverity: "error",
  message: "Replaced API usage must not be introduced.",
  docs: ["docs/opencanon/canon/migrations.md#migration-control"],
});
