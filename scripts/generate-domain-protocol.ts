import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenCanonOpenApiDocument } from "@opencanon/core";

const OutputPath = path.join("packages", "core", "generated", "domain-protocol.openapi.json");
const CheckFlag = "--check";
const rootDir = process.cwd();
const outputPath = path.join(rootDir, OutputPath);
const expected = `${JSON.stringify(createOpenCanonOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes(CheckFlag)) {
  const actual = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : undefined;
  if (actual !== expected) {
    console.error(`${OutputPath} is stale. Run npm run protocol:generate.`);
    process.exitCode = 1;
  } else {
    console.log(`${OutputPath} is current.`);
  }
} else {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, expected);
  console.log(`Generated ${OutputPath}.`);
}
