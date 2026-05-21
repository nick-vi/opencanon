import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function createStudioProject(rootDir: string): void {
  const skillDir = path.join(rootDir, ".agents/skills/opencanon");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  mkdirSync(path.join(rootDir, "validators"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "opencanon.config.json"),
    JSON.stringify(
      {
        decisionsPath: "docs/decisions.json",
        validatorsPath: "validators/index.ts",
        fixturesDir: "fixtures",
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".opencanon/**"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(rootDir, ".agents/skills/opencanon/index.ts"),
    [
      `export { defineValidator } from "${testImportPath(skillDir, path.join(process.cwd(), "packages/core/src/index.ts"))}";`,
      `export { noForbiddenCalls } from "${testImportPath(skillDir, path.join(process.cwd(), "packages/validators/src/index.ts"))}";`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(rootDir, "docs/decisions.json"), "[]\n");
  writeFileSync(path.join(rootDir, "docs/canon.md"), "# Canon\n");
  writeFileSync(
    path.join(rootDir, "validators/index.ts"),
    [
      "import { defineValidator } from \"../.agents/skills/opencanon/index.ts\";",
      "",
      "export default defineValidator({",
      "  id: \"conventions\",",
      "  validators: [],",
      "});",
      "",
    ].join("\n"),
  );
}

function testImportPath(_fromDir: string, toFile: string): string {
  return toFile;
}
