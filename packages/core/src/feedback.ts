import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths, Format } from "./core.ts";
import { createPaths, loadContextFiles, loadImpactSurfaces, pathToImportUrl, relative, resolveRootDir, toRepoRelativePath, unique, validateConfig, validateContext } from "./core.ts";
import type { Finding, Validator } from "./validator.ts";
import { resolveValidators } from "./validator.ts";
import { runValidation } from "./validation.ts";
import { writeAtomicJsonFileSync } from "./atomic.ts";

export type FeedbackHost = "manual" | "codex" | "claude" | "opencode";
export type FeedbackDedupeScope = "off" | "turn" | "session";

export type FeedbackInput = {
  cwd: string;
  files: string[];
  host?: FeedbackHost;
  sessionId?: string;
  turnId?: string;
  dedupeScope?: FeedbackDedupeScope;
};

export type FeedbackResult = {
  host: FeedbackHost;
  files: string[];
  diagnostics: string[];
  findingCount: number;
  suppressedCount: number;
  findings: Finding[];
};

type FeedbackCache = {
  scopes: Record<string, string[]>;
};

export async function runFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const rootDir = resolveRootDir(input.cwd);
  const paths = createPaths(rootDir);
  const host = input.host ?? "manual";
  const files = unique(input.files.map((file) => toRepoRelativePath(rootDir, file, input.cwd)));
  const diagnostics = validateConfig(paths);

  if (files.length === 0) {
    return {
      host,
      files,
      diagnostics,
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  if (diagnostics.length > 0) {
    return {
      host,
      files,
      diagnostics,
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  const { decisions } = loadContextFiles(paths);
  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const validators = await loadValidators(rootDir, paths);
  const contextDiagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];

  if (contextDiagnostics.length > 0) {
    return {
      host,
      files,
      diagnostics: contextDiagnostics,
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  const validation = await runValidation({
    rootDir,
    paths,
    decisions,
    validators,
    files,
  });
  const deduped = filterFeedbackFindings({
    cacheFile: path.join(paths.cacheDir, "feedback.json"),
    findings: validation.findings,
    scopeKey: feedbackScopeKey({
      host,
      sessionId: input.sessionId,
      turnId: input.turnId,
      dedupeScope: input.dedupeScope ?? "turn",
    }),
  });

  return {
    host,
    files,
    diagnostics: [...validation.diagnostics, ...deduped.diagnostics],
    findingCount: deduped.findings.length,
    suppressedCount: deduped.suppressedCount,
    findings: deduped.findings,
  };
}

export type FeedbackRenderOptions = {
  emptyMessage?: boolean;
  maxFindings?: number;
  maxChars?: number;
};

export function renderFeedbackMarkdown(result: FeedbackResult, options: FeedbackRenderOptions = {}): string {
  const maxFindings = options.maxFindings ?? 20;
  const maxChars = options.maxChars ?? 6000;
  const lines: string[] = [];

  if (result.findings.length === 0 && result.diagnostics.length === 0) {
    return options.emptyMessage ? "No OpenCanon feedback." : "";
  }

  lines.push("# OpenCanon Feedback");
  lines.push("");
  lines.push(`Host: ${result.host}`);
  lines.push(`Files: ${result.files.length > 0 ? result.files.join(", ") : "<none>"}`);
  if (result.files.length > 0) lines.push(`Run: ${validationCommand(result.files)}`);

  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push(`Findings: ${result.findings.length}`);
    let renderedFindings = 0;
    for (const [file, findings] of groupFindingsByFile(result.findings)) {
      if (renderedFindings >= maxFindings) break;
      lines.push("");
      lines.push(`## ${file}`);
      for (const finding of findings) {
        if (renderedFindings >= maxFindings) break;
        lines.push(`- [${finding.severity}] line ${finding.line} ${finding.validatorId}`);
        lines.push(`  ${finding.message}`);
        if (finding.fix) lines.push(`  Fix (${finding.fix.safety}): ${finding.fix.description}`);
        if (finding.fix?.command) lines.push(`  Command: ${finding.fix.command}`);
        if (finding.decisionIds && finding.decisionIds.length > 0) lines.push(`  Decisions: ${finding.decisionIds.join(", ")}`);
        if (finding.docs && finding.docs.length > 0) lines.push(`  Docs: ${finding.docs.join(", ")}`);
        renderedFindings += 1;
      }
    }
    const hiddenFindings = result.findings.length - renderedFindings;
    if (hiddenFindings > 0) lines.push(`- ${hiddenFindings} more finding(s) omitted from hook feedback.`);
    if (result.findings.length > 0) {
      lines.push("");
      lines.push("Finding Resolution Policy: any finding must be addressed before the agent completes the task. Fix code to current canon, or fix the validator plus fixtures if the rule is wrong. Ask the user before changing decisions; run the validation command above for the decision-update template.");
      lines.push("Audit exceptions: bun run opencanon context --list-exceptions");
    }
  }

  if (result.suppressedCount > 0) {
    lines.push("");
    lines.push(`Suppressed repeated findings in this hook scope: ${result.suppressedCount}`);
  }

  return trimToBudget(lines.join("\n"), maxChars);
}

export function formatFeedbackResult(result: FeedbackResult, format: Format, options: FeedbackRenderOptions = {}): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  return renderFeedbackMarkdown(result, options);
}

function groupFindingsByFile(findings: Finding[]): Array<[string, Finding[]]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = grouped.get(finding.file) ?? [];
    group.push(finding);
    grouped.set(finding.file, group);
  }
  return [...grouped.entries()];
}

function validationCommand(files: string[]): string {
  return `bun run opencanon validate --files ${files.map(quoteShell).join(" ")}`;
}

async function loadValidators(rootDir: string, paths: ContextPaths): Promise<Validator[]> {
  const module = await import(pathToImportUrl(paths.validatorsPath));
  const result = resolveValidators(module.default);
  if (result.diagnostics.length > 0) {
    throw new Error(`Invalid validators ${relative(rootDir, paths.validatorsPath)}:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return result.validators;
}

function quoteShell(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function trimToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const marker = "\n\nOutput truncated. Run the validation command above for the full report.";
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

function feedbackScopeKey(input: {
  host: FeedbackHost;
  sessionId?: string;
  turnId?: string;
  dedupeScope: FeedbackDedupeScope;
}): string | null {
  if (input.dedupeScope === "off") return null;
  if (input.dedupeScope === "turn") {
    if (!input.turnId) return null;
    return `${input.host}:turn:${input.sessionId ?? "unknown"}:${input.turnId}`;
  }
  if (!input.sessionId) return null;
  return `${input.host}:session:${input.sessionId}`;
}

function filterFeedbackFindings(params: {
  cacheFile: string;
  findings: Finding[];
  scopeKey: string | null;
}): { findings: Finding[]; suppressedCount: number; diagnostics: string[] } {
  if (!params.scopeKey) return { findings: params.findings, suppressedCount: 0, diagnostics: [] };
  const diagnostics: string[] = [];
  let cache = readFeedbackCache(params.cacheFile);
  const seen = new Set(cache.scopes[params.scopeKey] ?? []);
  const next: Finding[] = [];
  let suppressedCount = 0;

  for (const finding of params.findings) {
    const fingerprint = fingerprintFinding(finding);
    if (seen.has(fingerprint)) {
      suppressedCount += 1;
      continue;
    }
    seen.add(fingerprint);
    next.push(finding);
  }

  cache = {
    scopes: {
      ...cache.scopes,
      [params.scopeKey]: [...seen],
    },
  };

  try {
    mkdirSync(path.dirname(params.cacheFile), { recursive: true });
    writeAtomicJsonFileSync(params.cacheFile, cache);
  } catch (error) {
    diagnostics.push(`Could not write feedback cache: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { findings: next, suppressedCount, diagnostics };
}

function readFeedbackCache(cacheFile: string): FeedbackCache {
  if (!existsSync(cacheFile)) return { scopes: {} };
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as Partial<FeedbackCache>;
    if (!parsed || typeof parsed !== "object" || !parsed.scopes || typeof parsed.scopes !== "object") return { scopes: {} };
    return { scopes: parsed.scopes };
  } catch {
    return { scopes: {} };
  }
}

function fingerprintFinding(finding: Finding): string {
  return createHash("sha256")
    .update([finding.validatorId, finding.severity, finding.file, finding.line, finding.column ?? 0, finding.message].join("\0"))
    .digest("hex");
}
