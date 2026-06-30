import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cac } from "cac";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";
import { createPaths, discoverProjectFiles, fail } from "@opencanon/core";
import { Format } from "@opencanon/core";
import { createProfiler } from "@opencanon/core";
import type { ProfileEntry } from "@opencanon/core";
import { createRuntime, createValidationContext, flushValidationContextCache } from "@opencanon/core";

type BenchmarkQuery = {
  sizes: number[];
  format: Format;
  keep: boolean;
  help: boolean;
};

type BenchmarkResult = {
  size: number;
  rootDir: string;
  files: number;
  discoverySource: string;
  diagnostics: string[];
  profile: ProfileEntry[];
};

export async function runBenchmarkCommand(args = process.argv.slice(2)): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const results: BenchmarkResult[] = [];
  for (const size of query.sizes) results.push(await runBenchmark(size, query.keep));

  if (query.format === Format.Json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  console.log(renderBenchmarkMarkdown(results));
}

function parseArgs(args: string[]): BenchmarkQuery {
  const cli = cac("opencanon benchmark");
  cli.option("-h, --help", "Show help.");
  cli.option("--sizes <sizes>", "Comma-separated file counts.");
  cli.option("--format <format>", "Output format.");
  cli.option("--keep", "Keep generated benchmark repos.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "sizes", "format", "keep"]);

  return {
    sizes: parseSizes(optionValues(options.sizes)),
    format: formatOption(options.format),
    keep: booleanOption(options.keep),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
}

async function runBenchmark(size: number, keep: boolean): Promise<BenchmarkResult> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `opencanon-bench-${size}-`));
  const profiler = createProfiler(true);

  try {
    profiler.measure("benchmark.generate", () => generateBenchmarkRepo(rootDir, size));
    const paths = createPaths(rootDir);
    const discovery = profiler.measure("discover.project", () => discoverProjectFiles(paths));
    const ctx = profiler.measure("context.create", () =>
      createValidationContext({
        rootDir,
        paths,
        files: discovery.files,
        targetFiles: discovery.files,
        analysisFiles: discovery.files,
        validator: { id: "benchmark", severity: "warning" },
        profiler,
      }),
    );
    profiler.measure("context.facts.imports", () => ctx.facts.imports());
    profiler.measure("context.facts.comments", () => ctx.facts.comments());
    flushValidationContextCache(ctx);
    createRuntime(paths, []);

    return {
      size,
      rootDir,
      files: discovery.files.length,
      discoverySource: discovery.source,
      diagnostics: discovery.diagnostics,
      profile: profiler.entries(),
    };
  } finally {
    if (!keep) rmSync(rootDir, { recursive: true, force: true });
  }
}

function generateBenchmarkRepo(rootDir: string, size: number): void {
  mkdirSync(path.join(rootDir, "src/services"), { recursive: true });
  mkdirSync(path.join(rootDir, "src/shared"), { recursive: true });
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "opencanon-benchmark", type: "module" }, null, 2));
  writeFileSync(
    path.join(rootDir, "opencanon.config.json"),
    JSON.stringify(
      {
        cacheDir: ".opencanon/cache",
        fileDiscovery: "git",
        maxFiles: size + 1,
        maxFileSizeKb: 512,
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".git/**", "dist/**", "coverage/**"],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(rootDir, ".gitignore"), "dist/\ncoverage/\n");
  writeFileSync(path.join(rootDir, "src/shared/util.ts"), "export function util(value: string) { return value.trim(); }\n");
  for (let index = 0; index < size; index += 1) {
    writeFileSync(
      path.join(rootDir, "src/services", `company-${index}.service.ts`),
      `import { util } from "../shared/util";\n\nexport function company${index}() {\n  return util("${index}");\n}\n`,
    );
  }
  spawnSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
}

function parseSizes(values: string[]): number[] {
  const raw = values.length > 0 ? values.flatMap((value) => value.split(",")) : ["1000"];
  const sizes = raw.map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  if (sizes.length === 0) fail("--sizes must contain positive integers.");
  return sizes;
}

function optionValues(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

function renderBenchmarkMarkdown(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Benchmark");
  lines.push("");
  lines.push("Run larger tiers explicitly with `--sizes 1000,10000,50000`.");
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.size} files`);
    lines.push("");
    lines.push(`Files discovered: ${result.files}`);
    lines.push(`Discovery source: ${result.discoverySource}`);
    for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
    lines.push("");
    for (const entry of result.profile) lines.push(`- ${entry.name}: ${entry.ms.toFixed(3)}ms (${entry.count})`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function printHelp(): void {
  console.log(`Usage:
  opencanon benchmark
  opencanon benchmark --sizes 1000,10000,50000

Options:
  --sizes <sizes>          Comma-separated file counts. Default: 1000.
  --format markdown|json   Output format. Default: markdown.
  --keep                   Keep generated benchmark repos.
`);
}
