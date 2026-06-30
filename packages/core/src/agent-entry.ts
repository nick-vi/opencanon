const AgentEntryBlockStartPattern = /<opencanon(?:\s+[^>]*)?>/u;
const AgentEntryBlockPattern = /<opencanon(?:\s+[^>]*)?>[\s\S]*?<\/opencanon>/gu;

export const OpenCanonAgentEntryFile = {
  Agents: "AGENTS.md",
  Claude: "CLAUDE.md",
} as const;
export type OpenCanonAgentEntryFile = (typeof OpenCanonAgentEntryFile)[keyof typeof OpenCanonAgentEntryFile];

export const OpenCanonAgentEntryFiles: OpenCanonAgentEntryFile[] = [
  OpenCanonAgentEntryFile.Agents,
  OpenCanonAgentEntryFile.Claude,
];

export function renderOpenCanonAgentEntryBlock(): string {
  return `<opencanon>
This project uses OpenCanon for Project Canon, active Changes, scoped context, Proof, and validation.

Start with:
- \`opencanon brief --format json\`

Before editing known files:
- \`opencanon context --files <paths...>\`

Before finishing:
- \`opencanon validate --changed\`
- \`opencanon doctor\`

OpenCanon defines what is true, what is in scope, and how work is proven. Agents should use that context to complete coherent, verified work with minimal routine handoff.

Treat human attention as scarce. Spend agent effort on investigation, edge cases, validation, and clear handoff, while keeping changes simple and bounded by OpenCanon Changes, scoped context, impact surfaces, and Proof requirements.

Prefer finished, proven slices of work over partial edits. Do not expand scope unless it directly improves correctness, maintainability, or verification for the selected task.

Use OpenCanon CLI or MCP for live project state. Use the OpenCanon skill for the detailed workflow when your agent supports skills.
Do not copy detailed conventions, specs, or architecture here; load scoped OpenCanon context instead.
Put temporary markdown artifacts under \`{REPO_ROOT}/tmp/\`, not the project root.
</opencanon>`;
}

export function patchOpenCanonAgentEntryBlock(content: string, title = "Agent Instructions"): { content: string; changed: boolean; diagnostics: string[] } {
  const expected = renderOpenCanonAgentEntryBlock();
  const matches = [...content.matchAll(AgentEntryBlockPattern)];
  if (matches.length > 1) return { content, changed: false, diagnostics: ["Multiple <opencanon> managed blocks found. Keep exactly one block."] };
  if (matches.length === 1) {
    const current = matches[0]![0];
    const next = content.replace(current, expected);
    return { content: ensureTrailingNewline(next), changed: current !== expected || !next.endsWith("\n"), diagnostics: [] };
  }
  if (AgentEntryBlockStartPattern.test(content)) {
    return { content, changed: false, diagnostics: ["Found an opening <opencanon> tag without a closing </opencanon> tag."] };
  }

  const prefix = content.trim().length === 0 ? `# ${title}\n\n` : `${ensureTrailingNewline(content)}\n`;
  return { content: `${prefix}${expected}\n`, changed: true, diagnostics: [] };
}

export function validateOpenCanonAgentEntryContent(content: string, relativePath: string): string[] {
  const matches = [...content.matchAll(AgentEntryBlockPattern)];
  if (matches.length === 0) {
    if (AgentEntryBlockStartPattern.test(content)) {
      return [`${relativePath} has an opening <opencanon> tag without a closing </opencanon> tag.`];
    }
    return [`${relativePath} is missing the managed <opencanon> block. Run opencanon doctor --fix.`];
  }
  if (matches.length > 1) {
    return [`${relativePath} has multiple managed <opencanon> blocks. Keep exactly one block.`];
  }
  const actual = matches[0]![0];
  const expected = renderOpenCanonAgentEntryBlock();
  if (actual === expected) return [];
  if (!AgentEntryBlockStartPattern.test(actual)) return [`${relativePath} has an invalid managed <opencanon> block.`];
  return [`${relativePath} managed <opencanon> block drifted. Run opencanon doctor --fix.`];
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
