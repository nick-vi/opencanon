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
import { snapshotFiles } from "@opencanon/runtime";

type BenchmarkQuery = {
  sizes: number[];
  fileKb: number;
  format: Format;
  keep: boolean;
  sourceSnapshot: boolean;
  sourceSnapshotOnly: boolean;
  help: boolean;
};

type MemorySample = {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
};

type SourceSnapshotBenchmark = {
  snapshots: number;
  bytes: number;
  elapsedMs: number;
  memoryBefore: MemorySample;
  memoryAfter: MemorySample;
  memoryDelta: MemorySample;
  bytesPerSnapshot: number;
  heapDeltaPerSnapshot: number;
};

type BenchmarkResult = {
  size: number;
  rootDir: string;
  files: number;
  discoverySource: string;
  diagnostics: string[];
  profile: ProfileEntry[];
  sourceSnapshot?: SourceSnapshotBenchmark;
};

export async function runBenchmarkCommand(args = process.argv.slice(2)): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const results: BenchmarkResult[] = [];
  for (const size of query.sizes) {
    results.push(
      await runBenchmark({
        size,
        fileKb: query.fileKb,
        keep: query.keep,
        sourceSnapshot: query.sourceSnapshot || query.sourceSnapshotOnly,
        sourceSnapshotOnly: query.sourceSnapshotOnly,
      }),
    );
  }

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
  cli.option("--file-kb <kb>", "Approximate generated TypeScript file size in KiB.");
  cli.option("--format <format>", "Output format.");
  cli.option("--keep", "Keep generated benchmark repos.");
  cli.option("--source-snapshot", "Measure runtime source snapshot capture time and memory.");
  cli.option("--source-snapshot-only", "Measure source snapshot capture without validation context parsing.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "sizes", "fileKb", "format", "keep", "sourceSnapshot", "sourceSnapshotOnly"]);

  return {
    sizes: parseSizes(optionValues(options.sizes)),
    fileKb: parseFileKb(options.fileKb),
    format: formatOption(options.format),
    keep: booleanOption(options.keep),
    sourceSnapshot: booleanOption(options.sourceSnapshot),
    sourceSnapshotOnly: booleanOption(options.sourceSnapshotOnly),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
}

async function runBenchmark(input: {
  size: number;
  fileKb: number;
  keep: boolean;
  sourceSnapshot: boolean;
  sourceSnapshotOnly: boolean;
}): Promise<BenchmarkResult> {
  const { size, fileKb, keep, sourceSnapshot, sourceSnapshotOnly } = input;
  const rootDir = mkdtempSync(path.join(tmpdir(), `opencanon-bench-${size}-`));
  const profiler = createProfiler(true);

  try {
    profiler.measure("benchmark.generate", () => generateBenchmarkRepo(rootDir, size, fileKb));
    const paths = createPaths(rootDir);
    const discovery = profiler.measure("discover.project", () => discoverProjectFiles(paths));
    if (!sourceSnapshotOnly) {
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
    }
    const sourceSnapshotBenchmark = sourceSnapshot ? runSourceSnapshotBenchmark(rootDir, discovery.files) : undefined;

    return {
      size,
      rootDir,
      files: discovery.files.length,
      discoverySource: discovery.source,
      diagnostics: discovery.diagnostics,
      profile: profiler.entries(),
      ...(sourceSnapshotBenchmark ? { sourceSnapshot: sourceSnapshotBenchmark } : {}),
    };
  } finally {
    if (!keep) rmSync(rootDir, { recursive: true, force: true });
  }
}

function generateBenchmarkRepo(rootDir: string, size: number, fileKb: number): void {
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
  const padding = benchmarkFilePadding(fileKb);
  for (let index = 0; index < size; index += 1) {
    writeFileSync(
      path.join(rootDir, "src/services", `company-${index}.service.ts`),
      `import { util } from "../shared/util";\n\n${padding}export function company${index}() {\n  return util("${index}");\n}\n`,
    );
  }
  spawnSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
}

function benchmarkFilePadding(fileKb: number): string {
  if (fileKb <= 1) return "";
  const targetBytes = fileKb * 1024;
  const line = "const benchmarkPayload = \"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\";\n";
  const lines = Math.ceil(targetBytes / Buffer.byteLength(line));
  return line.repeat(lines);
}

function parseSizes(values: string[]): number[] {
  const raw = values.length > 0 ? values.flatMap((value) => value.split(",")) : ["1000"];
  const sizes = raw.map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  if (sizes.length === 0) fail("--sizes must contain positive integers.");
  return sizes;
}

function parseFileKb(value: unknown): number {
  if (value === undefined) return 1;
  const raw = Array.isArray(value) ? value.at(-1) : value;
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed <= 0) fail("--file-kb must be a positive integer.");
  return parsed;
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
    if (result.sourceSnapshot) {
      lines.push("");
      lines.push("Source snapshot:");
      lines.push(`- Snapshots: ${result.sourceSnapshot.snapshots}`);
      lines.push(`- Captured bytes: ${formatBytes(result.sourceSnapshot.bytes)}`);
      lines.push(`- Capture time: ${result.sourceSnapshot.elapsedMs.toFixed(3)}ms`);
      lines.push(`- Heap delta: ${formatBytes(result.sourceSnapshot.memoryDelta.heapUsed)}`);
      lines.push(`- RSS delta: ${formatBytes(result.sourceSnapshot.memoryDelta.rss)}`);
      lines.push(`- Heap delta per snapshot: ${formatBytes(result.sourceSnapshot.heapDeltaPerSnapshot)}`);
    }
    lines.push("");
    for (const entry of result.profile) lines.push(`- ${entry.name}: ${entry.ms.toFixed(3)}ms (${entry.count})`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function runSourceSnapshotBenchmark(rootDir: string, files: string[]): SourceSnapshotBenchmark {
  maybeGc();
  const memoryBefore = memorySample();
  const startedAt = performance.now();
  const snapshots = snapshotFiles(rootDir, files);
  const elapsedMs = performance.now() - startedAt;
  const memoryAfter = memorySample();
  const memoryDelta = subtractMemory(memoryAfter, memoryBefore);
  const bytes = snapshots.reduce((total, snapshot) => total + snapshot.size, 0);
  return {
    snapshots: snapshots.length,
    bytes,
    elapsedMs,
    memoryBefore,
    memoryAfter,
    memoryDelta,
    bytesPerSnapshot: snapshots.length === 0 ? 0 : bytes / snapshots.length,
    heapDeltaPerSnapshot: snapshots.length === 0 ? 0 : memoryDelta.heapUsed / snapshots.length,
  };
}

function memorySample(): MemorySample {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function subtractMemory(after: MemorySample, before: MemorySample): MemorySample {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    heapTotal: after.heapTotal - before.heapTotal,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function maybeGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

function formatBytes(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${sign}${absolute.toFixed(0)}B`;
  if (absolute < 1024 * 1024) return `${sign}${(absolute / 1024).toFixed(2)}KiB`;
  return `${sign}${(absolute / (1024 * 1024)).toFixed(2)}MiB`;
}

function printHelp(): void {
  console.log(`Usage:
  opencanon benchmark
  opencanon benchmark --sizes 1000,10000,50000

Options:
  --sizes <sizes>          Comma-separated file counts. Default: 1000.
  --file-kb <kb>           Approximate generated TypeScript file size in KiB. Default: 1.
  --format markdown|json   Output format. Default: markdown.
  --keep                   Keep generated benchmark repos.
  --source-snapshot        Measure runtime source snapshot capture time and memory.
  --source-snapshot-only   Measure source snapshot capture without validation context parsing.
`);
}
