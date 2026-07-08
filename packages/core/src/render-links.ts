import path from "node:path";
import type { Area } from "./area.ts";
import type { Change } from "./change.ts";
import type { ContextPaths, ImpactSurface } from "./context.ts";
import type { Convention, ConventionDefinitionKind } from "./convention.ts";
import type { Spec } from "./spec.ts";

export type RenderLinkTarget = {
  id: string;
  title: string;
  docs?: string;
};

export type RenderLinkContext = {
  currentDocs?: string;
  conventions: ReadonlyMap<string, RenderLinkTarget>;
  areas: ReadonlyMap<string, RenderLinkTarget>;
  specs: ReadonlyMap<string, RenderLinkTarget>;
  changes: ReadonlyMap<string, RenderLinkTarget>;
  impactSurfaces: ReadonlyMap<string, RenderLinkTarget>;
};

export type RenderLinkContextInput = {
  conventions?: Convention[];
  areas?: Area[];
  specs?: Spec[];
  changes?: Change[];
  impactSurfaces?: ImpactSurface[];
};

export function createRenderLinkContext(input: RenderLinkContextInput = {}, currentDocs?: string): RenderLinkContext {
  return {
    currentDocs,
    conventions: new Map((input.conventions ?? []).map((convention) => [convention.id, definitionTarget(convention.id, convention.title, convention.render.kind === "generated" ? convention.render.docs : undefined)])),
    areas: new Map((input.areas ?? []).map((area) => [area.id, definitionTarget(area.id, area.title, area.render.kind === "generated" ? area.render.docs : undefined)])),
    specs: new Map((input.specs ?? []).map((spec) => [spec.id, definitionTarget(spec.id, spec.title, spec.render.kind === "generated" ? spec.render.docs : undefined)])),
    changes: new Map((input.changes ?? []).map((change) => [change.id, definitionTarget(change.id, change.title, change.render.kind === "generated" ? change.render.docs : undefined)])),
    impactSurfaces: new Map((input.impactSurfaces ?? []).map((surface) => [surface.id, definitionTarget(surface.id, surface.title ?? surface.id, firstDocsReference(surface.docs))])),
  };
}

export function renderLinkContextForDocs(context: RenderLinkContext | undefined, currentDocs: string | undefined): RenderLinkContext | undefined {
  if (!context) return undefined;
  return { ...context, currentDocs };
}

export function renderConventionMarkdownLink(context: RenderLinkContext | undefined, id: string): string {
  return renderTargetLink(context, context?.conventions.get(id), id);
}

export function renderAreaMarkdownLink(context: RenderLinkContext | undefined, id: string): string {
  return renderTargetLink(context, context?.areas.get(id), id);
}

export function renderSpecMarkdownLink(context: RenderLinkContext | undefined, id: string): string {
  return renderTargetLink(context, context?.specs.get(id), id);
}

export function renderChangeMarkdownLink(context: RenderLinkContext | undefined, id: string): string {
  return renderTargetLink(context, context?.changes.get(id), id);
}

export function renderImpactSurfaceMarkdownLink(context: RenderLinkContext | undefined, id: string): string {
  return renderTargetLink(context, context?.impactSurfaces.get(id), id);
}

export function renderDefinitionMarkdownLink(context: RenderLinkContext | undefined, kind: ConventionDefinitionKind | string, id: string): string {
  switch (kind) {
    case "area":
      return renderAreaMarkdownLink(context, id);
    case "spec":
      return renderSpecMarkdownLink(context, id);
    case "change":
      return renderChangeMarkdownLink(context, id);
    case "convention":
      return renderConventionMarkdownLink(context, id);
    default:
      return id;
  }
}

export function renderDocsMarkdownLink(context: RenderLinkContext | undefined, reference: string): string {
  return `[${escapeMarkdownLinkText(reference)}](${markdownHref(context, reference)})`;
}

function renderTargetLink(context: RenderLinkContext | undefined, target: RenderLinkTarget | undefined, fallbackId: string): string {
  if (!target) return fallbackId;
  if (!target.docs) return target.title;
  return `[${escapeMarkdownLinkText(target.title)}](${markdownHref(context, target.docs)})`;
}

function definitionTarget(id: string, title: string, docs?: string): RenderLinkTarget {
  return { id, title, docs };
}

function firstDocsReference(docs: string[] | undefined): string | undefined {
  return docs?.find((reference) => reference.trim().length > 0);
}

function markdownHref(context: RenderLinkContext | undefined, reference: string): string {
  const [targetPath, fragment] = splitReference(reference);
  const currentDocs = context?.currentDocs;
  if (!currentDocs) return encodeMarkdownHref(reference);

  const currentPath = splitReference(currentDocs)[0];
  const currentDir = path.posix.dirname(normalizePath(currentPath));
  const relativePath = normalizePath(path.posix.relative(currentDir, normalizePath(targetPath))) || path.posix.basename(normalizePath(targetPath));
  return encodeMarkdownHref(fragment ? `${relativePath}#${fragment}` : relativePath);
}

function splitReference(reference: string): [path: string, fragment: string] {
  const hashIndex = reference.indexOf("#");
  if (hashIndex === -1) return [reference, ""];
  return [reference.slice(0, hashIndex), reference.slice(hashIndex + 1)];
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function encodeMarkdownHref(value: string): string {
  return value.replace(/ /g, "%20");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
