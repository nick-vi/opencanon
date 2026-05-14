import picomatch from "picomatch";

export type PatternExplanation = {
  pattern: string;
  negated: boolean;
  matched: boolean;
};

const options = {
  dot: true,
  noextglob: true,
  strictBrackets: true,
};

export function matchesPath(file: string, patterns: string[]): boolean {
  const { include, exclude } = splitPatterns(patterns);
  if (include.length === 0) return false;
  return matchesAnyPositive(file, include) && !matchesAnyPositive(file, exclude);
}

export function matchesAnyPath(files: string[], patterns: string[]): boolean {
  return files.some((file) => matchesPath(file, patterns));
}

export function explainPatterns(file: string, patterns: string[]): PatternExplanation[] {
  return patterns.map((pattern) => {
    const negated = pattern.startsWith("!");
    const normalized = negated ? pattern.slice(1) : pattern;
    return {
      pattern,
      negated,
      matched: picomatch.isMatch(file, normalized, options),
    };
  });
}

export function matchingPatterns(file: string, patterns: string[]): string[] {
  return explainPatterns(file, patterns)
    .filter((item) => item.matched)
    .map((item) => item.pattern);
}

export function validatePatterns(patterns: string[]): string[] {
  const diagnostics: string[] = [];
  const include = patterns.filter((pattern) => !pattern.startsWith("!"));

  if (include.length === 0) diagnostics.push("Pattern set needs at least one positive pattern.");

  for (const pattern of patterns) {
    const normalized = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!normalized.trim()) diagnostics.push("Empty glob pattern.");
    if (hasExtglob(normalized)) diagnostics.push(`Extglob syntax is disabled: ${pattern}`);

    try {
      picomatch(normalized, options);
    } catch (error) {
      diagnostics.push(`Invalid glob ${pattern}: ${String(error)}`);
    }
  }

  return diagnostics;
}

function matchesAnyPositive(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(file, pattern, options));
}

function splitPatterns(patterns: string[]): { include: string[]; exclude: string[] } {
  return {
    include: patterns.filter((pattern) => !pattern.startsWith("!")),
    exclude: patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1)),
  };
}

function hasExtglob(pattern: string): boolean {
  return /(^|[^\\])[+*@?!]\(/.test(pattern);
}
