// Legacy shim for callers that still pass blank names.
export function normalizeCompanyName(name: string): string {
  return name.trim();
}
