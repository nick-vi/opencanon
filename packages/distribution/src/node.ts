export const requiredNodeVersion = "24.12.0";
export const requiredNodeRequirement = `>=${requiredNodeVersion}`;

export function currentNodeVersion(): string {
  return process.versions.node ?? "<not-node>";
}
