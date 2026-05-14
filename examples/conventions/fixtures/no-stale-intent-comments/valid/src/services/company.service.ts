// Keep this check near the workflow because it mirrors the domain rule.
export function normalizeCompanyName(name: string): string {
  return name.trim();
}
