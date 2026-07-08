import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ContextPaths } from "./core.ts";
import { discoverProjectFiles, listFiles, relative } from "./core.ts";
import { ProjectFileLanguage } from "./language-registry.ts";
import { comparisonSites, pickAuthoritativeStatus, ProducerStatusKind, readSidecarPayloadDetailed, sidecarStatusFromRead, SidecarTypeFactsProvider, siteKey, type ProducerStatus, type SidecarPayload, type TypeFactsProvider, type TypeResolution, type TypeSite } from "./language-analyzer.ts";
import { ProducerArtifactId, ProducerLiveWorkerId, installedTypeScriptVersion, producerDefinitionForLanguage, producerDefinitionHasArtifact, producerDefinitionHasLiveWorker, producerDefinitions, producerSetupStatus, typeScriptVersionSupport } from "./producer-registry.ts";
import type { ValidationContext, Validator } from "./validator-types.ts";

export const typeResolutionsSymbol = Symbol("opencanon.typeResolutions");
export const producerStatusesSymbol = Symbol("opencanon.producerStatuses");
export const consumedTypedFactsSymbol = Symbol("opencanon.consumedTypedFacts");

export type TypeFactsCacheableValidationContext = ValidationContext & {
  [typeResolutionsSymbol]?: Map<string, TypeResolution>;
  [producerStatusesSymbol]?: ProducerStatus[];
  [consumedTypedFactsSymbol]?: Set<string>;
};

/**
 * OPENCANON_TYPED_PRODUCER=off|0|false disables the TypeScript producer entirely.
 * Folded into status: a disabled producer reports `{kind:"disabled"}` and serves
 * no facts. Mirrors the runtime's env check so both paths agree.
 */
function typescriptProducerDisabledByEnv(): boolean {
  const value = (process.env.OPENCANON_TYPED_PRODUCER ?? "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/**
 * Compute the headless TypeScript producer's status for a project, from the
 * sidecar freshness machinery + setup probes (tsconfig present, typescript
 * resolvable). Single source of truth for the sidecar-backed status surface.
 */
export function resolveTypeScriptSidecarStatus(rootDir: string): { status: ProducerStatus; payload: SidecarPayload | null } {
  if (typescriptProducerDisabledByEnv()) {
    return {
      status: { language: "typescript", kind: "disabled", detail: "OPENCANON_TYPED_PRODUCER is set to off." },
      payload: null,
    };
  }
  const sidecarPath = path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json");
  const definition = producerDefinitionForLanguage(ProjectFileLanguage.TypeScript);
  if (!definition) {
    return {
      status: { language: ProjectFileLanguage.TypeScript, kind: ProducerStatusKind.NotImplemented },
      payload: null,
    };
  }
  const packageVersion = installedTypeScriptVersion(rootDir);
  const setupStatus = producerSetupStatus(definition, rootDir);
  const read = readSidecarPayloadDetailed(sidecarPath, {
    rootDir,
    tsconfigHash: (tsconfigRelPath: string) => typedSidecarTsconfigHash(rootDir, tsconfigRelPath),
    tsVersion: () => packageVersion,
    membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
  });
  const status = sidecarStatusFromRead(read, {
    hasTsconfig: existsSync(path.join(rootDir, "tsconfig.json")),
    hasTypeScript: packageVersion !== null,
    typeScriptSupport: packageVersion ? typeScriptVersionSupport(packageVersion) : undefined,
  });
  return { status: setupStatus ?? status, payload: read.payload };
}

/**
 * Select the headless type-facts provider for a project: a
 * `SidecarTypeFactsProvider` whose `status()` reflects the sidecar freshness
 * machinery (ready / stale / missing-package / missing-tsconfig / disabled). The
 * provider serves facts only when `ready` — binary, no degraded mode.
 */
export function resolveTypeFactsProvider(rootDir: string): TypeFactsProvider {
  const { status, payload } = resolveTypeScriptSidecarStatus(rootDir);
  return new SidecarTypeFactsProvider(payload, status);
}

export function resolveArtifactTypeFactsProvider(rootDir: string, language: string, artifactId: ProducerArtifactId): TypeFactsProvider {
  const definition = producerDefinitionForLanguage(language);
  if (!definition || !producerDefinitionHasArtifact(definition, artifactId)) {
    return notImplementedProvider(language, `${language} does not define producer artifact ${artifactId}.`);
  }
  if (language === ProjectFileLanguage.TypeScript && artifactId === ProducerArtifactId.TypedComparisons) {
    return resolveTypeFactsProvider(rootDir);
  }
  return notImplementedProvider(language, `${language} producer artifact ${artifactId} is not implemented.`);
}

export function resolveLiveTypeFactsProvider(rootDir: string, language: string, workerId: ProducerLiveWorkerId): TypeFactsProvider {
  const definition = producerDefinitionForLanguage(language);
  if (!definition || !producerDefinitionHasLiveWorker(definition, workerId)) {
    return notImplementedProvider(language, `${language} does not define live producer ${workerId}.`);
  }
  return liveTypeFactsProviderFactory?.(rootDir, definition.language) ?? notImplementedProvider(language, `live producer ${workerId} is not registered in this process.`);
}

/**
 * Resolve every known per-language producer's status for a run, decoupled from a
 * live validation context. Consults the live producer factory (runtime) when
 * installed; otherwise each registered producer's headless implementation.
 * Backs `--require-producer`, `doctor`, and `project status`.
 */
export function resolveProducerStatuses(rootDir: string): ProducerStatus[] {
  return producerDefinitions().map((definition) => resolveAuthoritativeProducerStatus(rootDir, definition.language).status);
}

export function normalizeProducerStatusesForProject(input: {
  paths: ContextPaths;
  validators?: Array<Pick<Validator, "requiresProducers">>;
  producers?: ProducerStatus[];
}): ProducerStatus[] {
  const producers = input.producers ?? resolveProducerStatuses(input.paths.rootDir);
  const requiredLanguages = new Set((input.validators ?? []).flatMap((validator) => validator.requiresProducers));
  const hasUserTypeScript = projectHasUserTypeScript(input.paths);
  return producers.map((status) => {
    if (status.language !== "typescript") return status;
    if (status.kind === ProducerStatusKind.Ready) return status;
    if (hasUserTypeScript || requiredLanguages.has("typescript")) return status;
    return {
      language: status.language,
      kind: ProducerStatusKind.NotImplemented,
      detail: "No root tsconfig.json or user TypeScript source files were discovered.",
    };
  });
}

function projectHasUserTypeScript(paths: ContextPaths): boolean {
  if (existsSync(path.join(paths.rootDir, "tsconfig.json"))) return true;
  const discovery = discoverProjectFiles(paths, (file) => /\.(?:ts|tsx|mts|cts)$/u.test(file));
  if (discovery.failed) return true;
  return discovery.files.some((file) => isUserTypeScriptFile(paths, file));
}

function isUserTypeScriptFile(paths: ContextPaths, file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!/\.(?:ts|tsx|mts|cts)$/u.test(normalized)) return false;
  return !authoringPrefixes(paths).some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function authoringPrefixes(paths: ContextPaths): string[] {
  const sourceDirs = [
    path.dirname(paths.conventionsPath),
    path.dirname(paths.areasPath),
    path.dirname(paths.specsPath),
    path.dirname(paths.changesPath),
    paths.fixturesDir,
    path.join(paths.rootDir, ".opencanon"),
    path.join(paths.rootDir, ".agents"),
  ];
  return [...new Set(sourceDirs.map((dir) => relative(paths.rootDir, dir).replace(/\\/g, "/")).filter((dir) => dir && dir !== "."))];
}

/**
 * Current producer-availability resolver for one language. Status/reporting
 * surfaces (`/api/producers`, `--require-producer`, doctor, UI health) read this
 * instead of independently reconstructing producer setup. Validation does not
 * use this as source selection; it receives an explicit producer policy.
 */
export function resolveAuthoritativeProducerStatus(
  rootDir: string,
  language: string,
): { status: ProducerStatus; provider: TypeFactsProvider } {
  const definition = producerDefinitionForLanguage(language);
  if (!definition) {
    const status: ProducerStatus = { language, kind: ProducerStatusKind.NotImplemented };
    return { status, provider: notImplementedProvider(language) };
  }
  const live = liveTypeFactsProviderFactory?.(rootDir, definition.language) ?? null;
  if (live) {
    // A live producer exists: it is authoritative. We do NOT consult the sidecar
    // (precedence would pick the live status regardless; skipping the read avoids
    // a needless sidecar parse and any disagreement surfaces as the live status).
    return { status: live.status(), provider: live };
  }
  if (!producerDefinitionHasArtifact(definition, ProducerArtifactId.TypedComparisons)) return { status: { language, kind: ProducerStatusKind.NotImplemented }, provider: notImplementedProvider(language) };
  const sidecar = resolveTypeFactsProvider(rootDir);
  return { status: pickAuthoritativeStatus([sidecar.status()]), provider: sidecar };
}

function notImplementedProvider(language: string, detail?: string): TypeFactsProvider {
  return {
    language,
    status: () => ({ language, kind: ProducerStatusKind.NotImplemented, ...(detail ? { detail } : {}) }),
    // No producer registered: no facts, hence no fact generation.
    factGeneration: () => undefined,
    resolveTypes: () => Promise.resolve(new Map()),
  };
}

/**
 * Async batch pre-warm: collect every comparison literal site from the context's
 * facts, resolve them once through `provider`, and cache the result map on the
 * context (keyed by `siteKey`). After this runs, `ctx.typed.literal()` reads the
 * map synchronously — the validation pipeline awaits this before validators run.
 * Idempotent; safe to call once per context.
 */
export async function prewarmTypeFacts(ctx: ValidationContext, provider: TypeFactsProvider): Promise<void> {
  const sites = comparisonSites(ctx.facts.literals());
  let map: Map<string, TypeResolution>;
  let status: ProducerStatus;
  try {
    map = await provider.resolveTypes(sites);
    status = provider.status();
  } catch (error) {
    status = producerCrashedStatus(provider, error);
    console.warn(`[opencanon] type-facts provider failed; ${provider.language} producer status is crashed: ${status.detail}`);
    map = new Map();
  }
  // H1: snapshot status AFTER awaiting resolveTypes — including the
  // success-but-empty path. A live producer that crashed DURING this query sets
  // its crash state before resolveTypes resolves, so `status()` now reports
  // `crashed`. Capturing it before would record a stale `ready`, letting
  // `requiresProducers` validators run against no facts.
  (ctx as TypeFactsCacheableValidationContext)[typeResolutionsSymbol] = map;
  (ctx as TypeFactsCacheableValidationContext)[producerStatusesSymbol] = [status];
}

/** Install an already-resolved type-facts map (and producer statuses) onto a context (shared per-run pre-warm). */
export function installContextTypeFacts(ctx: ValidationContext, map: Map<string, TypeResolution>, statuses: ProducerStatus[]): void {
  (ctx as TypeFactsCacheableValidationContext)[typeResolutionsSymbol] = map;
  (ctx as TypeFactsCacheableValidationContext)[producerStatusesSymbol] = statuses;
}

/**
 * Shared per-run type facts: the resolved site map, each producer's status
 * (availability), and `factGenerations` — the generation each language's facts
 * were ACTUALLY computed from, taken from the provider's `factGeneration()`
 * (bound atomically with the facts, not sampled from a racing `status` event).
 * `producerSnapshot` binds its generation from `factGenerations`, its `kind`
 * from `statuses`.
 */
export type RunTypeFacts = { map: Map<string, TypeResolution>; statuses: ProducerStatus[]; factGenerations: Record<string, number | undefined> };

/**
 * Resolve the UNION of every context's comparison sites a SINGLE time and return
 * one shared `Map<siteKey, TypeResolution>` plus the producer statuses. The
 * caller supplies the exact provider selected by the run's producer policy, so
 * validation never changes source based on process-local runtime state.
 *
 * `additionalStatuses` carries languages that were part of the policy but not
 * queried in this TypeScript batch. That keeps the snapshot explicit for
 * not-yet-implemented languages without pretending they produced facts.
 */
export async function resolveRunTypeFacts(
  contexts: ValidationContext[],
  provider: TypeFactsProvider,
  additionalStatuses: ProducerStatus[] = [],
): Promise<RunTypeFacts> {
  // H1: status is captured AFTER the query (below), never before — a producer
  // that crashes DURING this run's resolveTypes must report `crashed` to the skip
  // logic so `requiresProducers` validators skip loudly instead of running
  // silently against an empty map.
  if (contexts.length === 0) {
    const status = provider.status();
    // No query happened, so no facts were used: report the producer's current
    // generation (never newer than facts, because there are none).
    return {
      map: new Map(),
      statuses: [status, ...additionalStatuses],
      factGenerations: { [provider.language]: provider.factGeneration() ?? status.generation ?? 0 },
    };
  }
  // Union of comparison sites across all contexts, deduplicated by siteKey.
  const byKey = new Map<string, TypeSite>();
  for (const ctx of contexts) {
    for (const site of comparisonSites(ctx.facts.literals())) {
      byKey.set(siteKey(site.file, site.line, site.column), site);
    }
  }
  try {
    const map = await provider.resolveTypes([...byKey.values()]);
    // factGeneration() is set synchronously by resolveTypes from the facts it
    // just used — read it now, BEFORE any later status() can race ahead. This is
    // the generation bound to producerSnapshot; status() supplies only `kind`.
    const factGeneration = provider.factGeneration();
    return {
      map,
      statuses: [provider.status(), ...additionalStatuses],
      factGenerations: { [provider.language]: factGeneration },
    };
  } catch (error) {
    const status = producerCrashedStatus(provider, error);
    console.warn(`[opencanon] type-facts provider failed; ${provider.language} producer status is crashed: ${status.detail}`);
    return { map: new Map(), statuses: [status, ...additionalStatuses], factGenerations: { [provider.language]: provider.factGeneration() } };
  }
}

function producerCrashedStatus(provider: TypeFactsProvider, error: unknown): ProducerStatus {
  const existing = provider.status();
  const status: ProducerStatus = {
    language: provider.language,
    kind: ProducerStatusKind.Crashed,
    detail: error instanceof Error ? error.message : String(error),
  };
  const generation = provider.factGeneration() ?? existing.generation;
  if (generation !== undefined) status.generation = generation;
  if (existing.warnings && existing.warnings.length > 0) status.warnings = existing.warnings;
  return status;
}

/**
 * Module-level injection seam for a LIVE type-facts provider. The project
 * runtime owns a long-lived TypeScript type-producer child process and registers
 * a provider factory here at startup. Validation uses this factory only when
 * the selected producer policy asks for the live TypeScript worker.
 *
 * Core stays free of any `typescript`/child-process import; it only calls back
 * through this factory, which the project runtime supplies.
 */
export type TypeFactsProviderFactory = (rootDir: string, language: string) => TypeFactsProvider | null;
let liveTypeFactsProviderFactory: TypeFactsProviderFactory | undefined;

/** Runtime-only: install (or clear) the live type-facts provider factory. */
export function setLiveTypeFactsProviderFactory(factory: TypeFactsProviderFactory | undefined): void {
  liveTypeFactsProviderFactory = factory;
}

export async function prewarmContextTypeFacts(
  ctx: ValidationContext,
  provider: TypeFactsProvider,
): Promise<void> {
  await prewarmTypeFacts(ctx, provider);
}

export function typedSidecarTsconfigHash(rootDir: string, tsconfigRelPath: string = "tsconfig.json"): string {
  const candidate = path.isAbsolute(tsconfigRelPath) ? tsconfigRelPath : path.join(rootDir, tsconfigRelPath);
  if (!existsSync(candidate)) return "";
  try {
    return createHash("sha256").update(readFileSync(candidate, "utf8")).digest("hex");
  } catch {
    return "";
  }
}

const MembershipExtensions = /\.(ts|tsx|mts|cts)$/;

/**
 * Hash the sorted set of type-relevant files (git-tracked TS/TSX/d.ts, minus
 * node_modules). Reproducible from producer and reader without tsc. List-only —
 * content drift is caught by per-file fingerprints; this catches add/remove.
 */
export function membershipHashOf(paths: string[]): string {
  const normalized = [...new Set(paths.map((p) => p.replace(/\\/g, "/")))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

/**
 * TS/TSX/d.ts files visible to the project (minus node_modules), repo-relative.
 * Mirrors the runtime inventory: tracked + untracked-non-ignored (`--cached
 * --others --exclude-standard`) so a NEW uncommitted ambient `.d.ts` is counted,
 * not just committed ones. Sorted for a stable membership hash.
 */
export function listMembershipFiles(rootDir: string): string[] {
  const result = spawnSync(
    "git",
    ["-C", rootDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // H1: distinguish "git ran, zero files" (status 0, empty stdout — a real empty
  // set) from "git failed/absent" (non-zero). On failure, fall back to a
  // deterministic filesystem walk so producer and reader agree on the SAME set;
  // returning [] on failure made every set hash to the empty-set hash, so
  // added/removed files never invalidated the sidecar.
  if (result.status === 0) {
    return result.stdout
      .split("\0")
      .map((file) => file.trim())
      .filter((file) => file.length > 0 && MembershipExtensions.test(file) && !file.includes("node_modules/"));
  }
  return listMembershipFilesViaFs(rootDir);
}

/**
 * Deterministic non-git membership discovery for roots where git is unavailable
 * (non-git root, git not installed). Producer (`analyze --typed`) and reader use
 * the same path so their membership hashes match. Walks rootDir for TS/TSX/d.ts,
 * skips node_modules and dot-directories, repo-relative + sorted (the sort is
 * done by `membershipHashOf`).
 */
function listMembershipFilesViaFs(rootDir: string): string[] {
  const skipDir = (dir: string): boolean => {
    const base = path.basename(dir);
    return base === "node_modules" || base.startsWith(".");
  };
  return listFiles(rootDir, (file) => MembershipExtensions.test(file), skipDir)
    .map((abs) => path.relative(rootDir, abs).replace(/\\/g, "/"))
    .filter((file) => file.length > 0 && !file.includes("node_modules/"));
}
