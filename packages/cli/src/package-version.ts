import { readFileSync } from "node:fs";

export function readCliPackageVersion(): string {
  for (const candidate of [
    new URL("./package.json", import.meta.url),
    new URL("../package.json", import.meta.url),
    new URL("../../../package.json", import.meta.url),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim()) return parsed.version;
    } catch {
      // Source, workspace, and bundled runtime layouts use different package.json locations.
    }
  }
  return "0.0.0-dev";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
