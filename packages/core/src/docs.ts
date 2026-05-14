import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./core.ts";

export type DocSnippet = {
  source: string;
  path: string;
  slug: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  body: string;
  contentHash: string;
  decisionIds: string[];
};

const TextEncoding = {
  Utf8: "utf8",
} as const;
const MarkdownExtensionPattern = /\.(md|markdown)$/i;

export function resolveDocsReferences(
  paths: Pick<ContextPaths, "rootDir" | "decisionsPath">,
  references: string[],
  decisionIdsByReference = new Map<string, string[]>,
): DocSnippet[] {
  const snippets: DocSnippet[] = [];
  for (const reference of unique(references)) {
    const resolved = resolveMarkdownDocsReference(paths, reference);
    if (!resolved.ok) continue;
    snippets.push({
      ...resolved.snippet,
      decisionIds: decisionIdsByReference.get(reference) ?? [],
    });
  }
  return snippets;
}

export function parseMarkdownDoc(markdown: string, filePath: string): DocSnippet[] {
  const lines = markdown.split(/\r?\n/);
  const headingStarts: Array<{ level: number; heading: string; slug: string; lineIndex: number }> = [];
  const slugCounts = new Map<string, number>();
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const heading = match[2].trim();
    const baseSlug = normalizeMarkdownHeading(heading);
    const duplicateCount = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, duplicateCount + 1);
    headingStarts.push({
      level: match[1].length,
      heading,
      slug: duplicateCount === 0 ? baseSlug : `${baseSlug}-${duplicateCount}`,
      lineIndex: index,
    });
  }

  return headingStarts.map((heading, index) => {
    const next = headingStarts.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine = next ? next.lineIndex : lines.length;
    const body = lines.slice(heading.lineIndex, endLine).join("\n").trim();
    return {
      source: `${filePath}#${heading.slug}`,
      path: filePath,
      slug: heading.slug,
      heading: heading.heading,
      level: heading.level,
      startLine: heading.lineIndex + 1,
      endLine,
      body,
      contentHash: createHash("sha256").update(body).digest("hex"),
      decisionIds: [],
    };
  });
}

export function normalizeMarkdownHeading(value: string): string {
  const normalized = value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return normalized || "heading";
}

export function validateDocsReference(
  owner: string,
  reference: string,
  context: { decisionIds: Set<string>; paths?: ContextPaths },
): string[] {
  const diagnostics: string[] = [];
  const trimmed = reference.trim();
  if (!trimmed) return [`${owner} has an empty docs reference.`];
  const parsed = parseDocsReference(trimmed);
  if (!parsed.ok) return parsed.diagnostics.map((diagnostic) => `${owner} ${diagnostic}: ${reference}`);
  if (!context.paths) return diagnostics;

  const decisionsPath = relative(context.paths.rootDir, context.paths.decisionsPath);
  if (parsed.normalizedPath === decisionsPath) {
    if (!parsed.fragment) diagnostics.push(`${owner} docs reference to decisions must include #<decision-id>: ${reference}`);
    else if (!context.decisionIds.has(parsed.fragment)) diagnostics.push(`${owner} docs reference points at missing decision: ${reference}`);
    return diagnostics;
  }

  const resolved = resolveMarkdownDocsReference(context.paths, trimmed);
  if (!resolved.ok) {
    diagnostics.push(`${owner} ${resolved.diagnostic}: ${reference}`);
    return diagnostics;
  }

  return diagnostics;
}

function resolveMarkdownDocsReference(
  paths: Pick<ContextPaths, "rootDir" | "decisionsPath">,
  reference: string,
): { ok: true; snippet: DocSnippet } | { ok: false; diagnostic: string } {
  const parsed = parseDocsReference(reference);
  if (!parsed.ok) return { ok: false, diagnostic: parsed.diagnostics.join(" ") };
  const decisionsPath = relative(paths.rootDir, paths.decisionsPath);
  if (parsed.normalizedPath === decisionsPath) return { ok: false, diagnostic: "docs reference points at a decision record, not a Markdown heading" };
  if (!MarkdownExtensionPattern.test(parsed.normalizedPath)) return { ok: false, diagnostic: "docs reference must point at a Markdown file" };
  if (!parsed.fragment) return { ok: false, diagnostic: "docs reference must include #<heading-slug>" };

  const absolutePath = path.resolve(paths.rootDir, parsed.normalizedPath);
  const rootDir = path.resolve(paths.rootDir);
  if (!absolutePath.startsWith(`${rootDir}${path.sep}`) && absolutePath !== rootDir) {
    return { ok: false, diagnostic: "docs reference must stay inside the project" };
  }
  if (!existsSync(absolutePath)) return { ok: false, diagnostic: "docs reference points at missing file" };

  const snippets = parseMarkdownDoc(readFileSync(absolutePath, TextEncoding.Utf8), parsed.normalizedPath);
  const snippet = snippets.find((item) => item.slug === parsed.fragment);
  if (!snippet) return { ok: false, diagnostic: "docs reference points at missing heading" };
  return { ok: true, snippet };
}

function parseDocsReference(
  reference: string,
): { ok: true; filePath: string; fragment: string; normalizedPath: string } | { ok: false; diagnostics: string[] } {
  const hashIndex = reference.indexOf("#");
  const filePath = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
  if (!filePath) return { ok: false, diagnostics: ["docs reference must include a relative file path"] };
  if (path.isAbsolute(filePath)) return { ok: false, diagnostics: ["docs reference must be project-relative"] };
  const normalizedPath = normalizePath(path.posix.normalize(filePath.replace(/\\/g, "/")));
  if (normalizedPath === "." || normalizedPath.startsWith("../") || normalizedPath.split("/").includes("..")) {
    return { ok: false, diagnostics: ["docs reference must stay inside the project"] };
  }
  return { ok: true, filePath, fragment, normalizedPath };
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function relative(rootDir: string, value: string): string {
  return normalizePath(path.relative(rootDir, value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
