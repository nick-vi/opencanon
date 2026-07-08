import path from "node:path";
import { createOpenCanonDiagnostic } from "@opencanon/core";
import { AuthoringFixSafety, AuthoringOption, AuthoringSeverity } from "./authoring-types.ts";
import type { AuthoringFactory, AuthoringOption as AuthoringOptionValue } from "./authoring-types.ts";

export function renderOptions(factory: AuthoringFactory, options: Record<string, unknown>): string {
  const lines = factory.sourceFields.flatMap((field) => {
    const value = sourceValueForOption(factory, field, options);
    if (value === undefined) return [];
    return [`  ${sourceFieldName(field)}: ${renderTypeScriptValue(value)},`];
  });
  return `{\n${lines.join("\n")}\n}`;
}

function sourceValueForOption(factory: AuthoringFactory, field: AuthoringOptionValue, options: Record<string, unknown>): unknown {
  const descriptor = factory.fields.find((item) => item.key === field);
  if (field === AuthoringOption.Topics || field === AuthoringOption.Related || field === AuthoringOption.Docs) {
    const value = stringListOption(options, field);
    return value.length > 0 ? value : undefined;
  }
  if (field === AuthoringOption.FixDescription) {
    const description = optionalStringOption(options, field);
    return description ? { safety: AuthoringFixSafety.Manual, description } : undefined;
  }
  if (field === AuthoringOption.Calls || field === AuthoringOption.Patterns || field === AuthoringOption.Allow || field === AuthoringOption.ReasonPatterns) {
    const value = regexListOption(options, field);
    return value.length > 0 || descriptor?.required ? value : undefined;
  }
  if (field === AuthoringOption.MaxDepth) return numberOption(options, field, 1);
  if (field === AuthoringOption.HeaderLines) return numberOption(options, field, 12);
  if (field === AuthoringOption.RequireReason) return booleanOption(options, field, false);
  if (field === AuthoringOption.SafeFix) return booleanOption(options, field, true);
  if (
    field === AuthoringOption.In ||
    field === AuthoringOption.From ||
    field === AuthoringOption.To ||
    field === AuthoringOption.Suffix ||
    field === AuthoringOption.AllowNames ||
    field === AuthoringOption.Names
  ) {
    const value = stringListOption(options, field);
    return value.length > 0 ? value : undefined;
  }
  return optionalStringOption(options, field);
}

function renderTypeScriptValue(value: unknown): string {
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `    ${renderTypeScriptValue(item)},`).join("\n")}\n  ]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return `{\n${entries.map(([key, entry]) => `    ${key}: ${renderTypeScriptValue(entry)},`).join("\n")}\n  }`;
  }
  return JSON.stringify(value);
}

export function baseFactoryOptions(options: Record<string, unknown>) {
  const fixDescription = optionalStringOption(options, AuthoringOption.FixDescription);
  return {
    id: stringOption(options, AuthoringOption.Id),
    topics: stringListOption(options, AuthoringOption.Topics),
    severity: severityOption(options),
    related: stringListOption(options, AuthoringOption.Related),
    docs: stringListOption(options, AuthoringOption.Docs),
    message: stringOption(options, AuthoringOption.Message),
    fix: fixDescription ? { safety: AuthoringFixSafety.Manual, description: fixDescription } : undefined,
  };
}

function sourceFieldName(field: AuthoringOptionValue): string {
  if (field === AuthoringOption.HeaderLines) return "maxHeaderLines";
  return field === AuthoringOption.FixDescription ? "fix" : field;
}

export function stringOption(options: Record<string, unknown>, key: AuthoringOptionValue): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

export function optionalStringOption(options: Record<string, unknown>, key: AuthoringOptionValue): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringListOption(options: Record<string, unknown>, key: AuthoringOptionValue): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

export function regexListOption(options: Record<string, unknown>, key: AuthoringOptionValue): RegExp[] {
  return stringListOption(options, key).map(parseRegex);
}

export function regexListDiagnostics(value: unknown): string[] {
  return stringListValue(value).flatMap((item) => {
    try {
      parseRegex(item);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}

function parseRegex(value: string): RegExp {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("empty regular expression.");
  if (trimmed.startsWith("/")) {
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) return new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1));
  }
  return new RegExp(trimmed);
}

export function numberOption(options: Record<string, unknown>, key: AuthoringOptionValue, fallback: number): number {
  const value = options[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

export function booleanOption(options: Record<string, unknown>, key: AuthoringOptionValue, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : fallback;
}

export function severityOption(options: Record<string, unknown>): "error" | "warning" {
  return options[AuthoringOption.Severity] === AuthoringSeverity.Error ? AuthoringSeverity.Error : AuthoringSeverity.Warning;
}

export function isEmptyOption(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\r?\n/);
  return [];
}

export function importNameForValidator(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, value: string) => value.toUpperCase());
}

export function normalizeFixturePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized !== "." && !normalized.startsWith("../") && !normalized.split("/").includes("..");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function authoringDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: "authoring-invalid", message });
}
