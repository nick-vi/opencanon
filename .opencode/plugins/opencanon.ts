const editTools = new Set(["write", "edit", "apply_patch"]);

function appendOutput(output, text) {
  if (!text || !output || typeof output !== "object") return;
  output.output = [typeof output.output === "string" ? output.output : "", text].filter(Boolean).join("\n\n");
}

export const OpenCanonPlugin = async ({ directory, worktree }) => {
  const cwd = worktree ?? directory;
  return {
    "tool.execute.after": async (input, output) => {
      if (!editTools.has(String(input.tool))) return;
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("opencanon", ["hook", "opencode"], {
        cwd,
        input: JSON.stringify({ input: { ...input, cwd }, output }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      if (result.error) {
        appendOutput(output, `OpenCanon hook failed: ${result.error.message}`);
        return;
      }
      if (result.status !== 0) {
        const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        appendOutput(output, ["OpenCanon hook failed.", details].filter(Boolean).join("\n"));
        return;
      }
      const text = result.stdout.trim();
      if (!text || !output || typeof output !== "object") return;
      try {
        const parsed = JSON.parse(text);
        const additionalContext = typeof parsed.additionalContext === "string" ? parsed.additionalContext : "";
        appendOutput(output, additionalContext);
      } catch {
        appendOutput(output, text);
      }
    },
  };
};
