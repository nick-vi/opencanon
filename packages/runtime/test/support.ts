import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function createAuthoringProject(rootDir: string): void {
  const skillDir = path.join(rootDir, ".agents/skills/opencanon");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "opencanon.config.json"),
    JSON.stringify(
      {
        conventionsPath: "conventions/index.ts",
        fixturesDir: "fixtures",
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".opencanon/**"],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(skillDir, "SKILL.md"), "# OpenCanon\n");
  writeFileSync(path.join(rootDir, "docs/canon.md"), "# Canon\n");
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "export default [",
      "];",
      "",
    ].join("\n"),
  );
}
