import type { StudioFactoryDescriptor, StudioFieldDescriptor, StudioFixtureSet, StudioRequest } from "./types.ts";
import { StudioFieldGroups, StudioFieldKind, StudioFixtureCase, StudioOption, type StudioForm, type StudioOption as StudioOptionValue } from "./validator-studio-constants.ts";

export function formFromDefaults(factory: StudioFactoryDescriptor): StudioForm {
  const form: StudioForm = {};
  for (const field of factory.fields) {
    const value = factory.defaults[field.key];
    if (field.kind === StudioFieldKind.Boolean) {
      form[field.key] = Boolean(value);
    } else if (Array.isArray(value)) {
      form[field.key] = value.join("\n");
    } else {
      form[field.key] = value === undefined ? "" : String(value);
    }
  }
  return form;
}

export function requestFromState(factory: StudioFactoryDescriptor, form: StudioForm, fixtures: StudioFixtureSet): StudioRequest {
  const options: Record<string, unknown> = {};
  for (const field of factory.fields) {
    const value = form[field.key];
    options[field.key] = fieldValue(field, value);
  }
  return { factoryId: factory.id, options, fixtures };
}

export function fieldValue(field: StudioFieldDescriptor, value: string | boolean | undefined): unknown {
  if (field.kind === StudioFieldKind.Boolean) return Boolean(value);
  if (field.kind === StudioFieldKind.Number) return Number(value);
  if (field.kind === StudioFieldKind.Lines || field.kind === StudioFieldKind.RegexLines) return splitLines(String(value ?? ""));
  return String(value ?? "");
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function copyFixtures(fixtures: StudioFixtureSet): StudioFixtureSet {
  return {
    valid: fixtures.valid.map((file) => ({ ...file })),
    invalid: fixtures.invalid.map((file) => ({ ...file })),
  };
}

export function groupedStudioFields(fields: StudioFieldDescriptor[]): Array<{ id: string; label: string; fields: StudioFieldDescriptor[] }> {
  const grouped = StudioFieldGroups.map((group) => ({
    id: group.id,
    label: group.label,
    fields: fields.filter((field) => group.keys.includes(field.key as StudioOption)),
  })).filter((group) => group.fields.length > 0);
  const groupedKeys = new Set(grouped.flatMap((group) => group.fields.map((field) => field.key)));
  const otherFields = fields.filter((field) => !groupedKeys.has(field.key));
  return otherFields.length > 0 ? [...grouped, { id: "other", label: "Options", fields: otherFields }] : grouped;
}

export function fieldLines(value: string): string[] {
  return value.length > 0 ? value.split(/\r?\n/) : [""];
}

export function regexDiagnostic(pattern: string): string | null {
  if (!pattern) return null;
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression.";
  }
}

export function toKebabCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
