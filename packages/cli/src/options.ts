import { fail, Format } from "@opencanon/core";
import type { FixMode } from "@opencanon/core";
import { FixModeValue } from "@opencanon/core";

export const CliOptionName = {
  DryRun: "dryRun",
  Fix: "fix",
  Format: "format",
  H: "h",
  Help: "help",
  Hooks: "hooks",
  Manifest: "manifest",
  Yes: "yes",
} as const;

export const CliOptionFlag = {
  DryRun: "--dry-run",
  Format: "--format <format>",
  Help: "-h, --help",
  Manifest: "--manifest <source>",
} as const;

export const CliOptionDescription = {
  DryRun: "Show selected fixes without writing files.",
  Format: "Output format.",
  RuntimeManifest: "Runtime release manifest path, file URL, or HTTPS URL.",
} as const;

export function rejectUnknownOptions(options: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(["--", ...allowed]);
  for (const key of Object.keys(options)) {
    if (allowedSet.has(key)) continue;
    fail(`Unknown option: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
  }
}

export function stringValues(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string" || item.length === 0)) fail("Option requires a value.");
  return values as string[];
}

export function booleanOption(value: unknown): boolean {
  return value === true;
}

export function formatOption(value: unknown): Format {
  if (value === undefined) return "markdown";
  if (value !== Format.Markdown && value !== Format.Json) fail(`Unsupported --format: ${String(value)}`);
  return value;
}

export function fixModeOption(value: unknown): FixMode | undefined {
  if (value === undefined) return undefined;
  if (value === true) return FixModeValue.Safe;
  if (value !== FixModeValue.Safe && value !== FixModeValue.Suggested && value !== FixModeValue.All) fail("--fix must be safe, suggested, or all.");
  return value;
}

export function positiveIntegerOption(value: unknown, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) fail(`${flag} requires a positive integer`);
  return numberValue;
}

export function nonNegativeIntegerOption(value: unknown, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) fail(`${flag} requires a non-negative integer`);
  return numberValue;
}
