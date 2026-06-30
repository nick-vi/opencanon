import { cac } from "cac";
import { Format, LANGUAGE_DESCRIPTORS, fail } from "@opencanon/core";
import type { LanguageDescriptor } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";

type LanguagesQuery = {
  format: Format;
  help: boolean;
};

type LanguageCapabilityRow = {
  id: string;
  role: string;
  extensions: string[];
  parser: string;
  facts: {
    available: string[];
    derived: string[];
  };
  graph: string;
  resolution: string | null;
  refactor: {
    level: string;
    operations: string[];
  };
};

export async function runLanguagesCommand(args = process.argv.slice(2)): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const languages = LANGUAGE_DESCRIPTORS.map(languageCapabilityRow);
  if (query.format === Format.Json) {
    console.log(JSON.stringify({ languages }, null, 2));
    return;
  }

  console.log(renderLanguagesMarkdown(languages));
}

function parseArgs(args: string[]): LanguagesQuery {
  const cli = cac("opencanon languages");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (parsed.args.length > 0) fail(`Unexpected languages arguments: ${parsed.args.join(", ")}`);

  return {
    format: formatOption(options.format),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
}

function languageCapabilityRow(descriptor: LanguageDescriptor): LanguageCapabilityRow {
  return {
    id: descriptor.id,
    role: descriptor.role,
    extensions: descriptor.extensions,
    parser: descriptor.facts.extractor,
    facts: {
      available: Object.entries(descriptor.facts.coverage)
        .filter(([, coverage]) => coverage !== "none")
        .map(([kind, coverage]) => `${kind}:${coverage}`)
        .sort(),
      derived: [...(descriptor.facts.derived ?? [])].sort(),
    },
    graph: descriptor.graph.mode,
    resolution: descriptor.resolution?.strategyId ?? null,
    refactor: {
      level: descriptor.refactor.level,
      operations: descriptor.refactor.operations,
    },
  };
}

function renderLanguagesMarkdown(languages: LanguageCapabilityRow[]): string {
  const lines = ["# OpenCanon Language Capabilities", ""];
  lines.push("| Language | Files | Parser | Facts | Graph | Refactor |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const language of languages) {
    const files = language.extensions.length > 0 ? language.extensions.join(", ") : "<fallback>";
    const facts = language.facts.available.length > 0 ? language.facts.available.join(", ") : "none";
    const derived = language.facts.derived.length > 0 ? `; derived: ${language.facts.derived.join(", ")}` : "";
    const refactor = language.refactor.operations.length > 0 ? `${language.refactor.level}: ${language.refactor.operations.join(", ")}` : language.refactor.level;
    lines.push(`| ${language.id} | ${files} | ${language.parser} | ${facts}${derived} | ${language.graph} | ${refactor} |`);
  }
  lines.push("");
  lines.push("Parser names are literal implementation facts. `none` means OpenCanon can still discover/index the file as text or docs, but does not claim AST facts for that language.");
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`Usage:
  opencanon languages
  opencanon languages --format json

Shows the explicit language capability matrix: file extensions, parser/fact coverage, graph support, and refactor support.
`);
}
