import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectLiteralFact } from "./validator-types.ts";
import { LiteralContext } from "./typescript.ts";
import { safeRelativePath } from "./paths.ts";
import {
  siteKey,
  ProducerStatusKind,
  TypeResolutionKind,
  type LiteralMember,
  type LiteralUnionSyntax,
  type ProducerStatus,
  type ProducerWarning,
  type TypeFactsProvider,
  type TypeResolution,
  type TypeSite,
} from "./type-facts-provider.ts";

export type {
  TypeFactsProvider,
  TypeResolution,
  TypeSite,
  TypeSource,
  LiteralValue,
  LiteralMember,
  LiteralUnionSyntax,
  FiniteLiteralSet,
  ProducerStatus,
  ProducerWarning,
  ProducerSnapshot,
  ProducerSnapshotEntry,
} from "./type-facts-provider.ts";
export { siteKey, asFiniteLiteralSet, finiteLiteralIncludes, pickAuthoritativeStatus, ProducerStatusKind, TypeResolutionKind } from "./type-facts-provider.ts";

/**
 * Stable symbol identifier used by the declaration index. Matches the
 * `${file}#${name}` form used elsewhere in the engine for cheap interop.
 */
export type SymbolId = string;

/**
 * Sync index of declaration-member literals (const-object / type-union with a
 * `declarationSourceId`). Backs `ctx.typed.literal({ declarationSourceId })` —
 * this is a SYNTACTIC fact (built from facts in the literal stream), cheap and
 * synchronous, so it needs NO pre-warm and never touches a `TypeFactsProvider`.
 */
export class DeclarationIndex {
  private index = new Map<string, Set<SymbolId>>();

  constructor(literals: ProjectLiteralFact[]) {
    for (const literal of literals) {
      if (!literal.declarationSourceId) continue;
      if (literal.context !== LiteralContext.ConstObject && literal.context !== LiteralContext.TypeUnion) continue;
      const key = `${literal.valueKind}:${literal.value}`;
      const symbolId = `${literal.file.path}#${literal.declarationSourceId}`;
      const bucket = this.index.get(key) ?? new Set<SymbolId>();
      bucket.add(symbolId);
      this.index.set(key, bucket);
    }
  }

  declaresFor(value: string, valueKind: "string" | "number" | "boolean"): SymbolId[] {
    return [...(this.index.get(`${valueKind}:${value}`) ?? [])];
  }
}

/**
 * One resolved comparison site in the sidecar. Carries the serialized
 * `TypeResolution` fields (minus `language`, which is always "typescript" for
 * the tsc producer). The `kind` is serialized so a producer can record a
 * non-finite site internally as `"other"`, but such an entry NEVER surfaces as a
 * resolution — only `"literal-union"` entries reconstruct into a `TypeResolution`.
 */
export type SidecarEntry = {
  file: string;
  line: number;
  column: number;
  /** Mirrors `TypeResolution.display`. */
  display: string;
  symbolId?: string;
  typeSource: TypeResolution["typeSource"];
  kind: "literal-union" | "other";
  /** Present only when `kind === "literal-union"`. */
  members?: LiteralMember[];
  syntax?: LiteralUnionSyntax;
};

/** Fingerprint of one analyzed source file. mtime+size is the cheap fast-path; sha256 is the proof. */
export type SidecarSourceFile = {
  /** Repo-relative, slash-normalized path. */
  path: string;
  sha256: string;
  mtimeMs: number;
  size: number;
};

export type SidecarPayload = {
  version: 1;
  generatedAt: string;
  /** Repo-relative path of the tsconfig that was loaded when the sidecar was produced. */
  tsconfigPath: string;
  /** sha256 of the file at `tsconfigPath` at generation time. */
  tsconfigHash: string;
  /** `typescript` package version used to produce the sidecar. Type resolution can shift across versions. */
  tsVersion: string;
  /** `git rev-parse HEAD` at generation. Metadata only — NOT a freshness gate. */
  gitHead: string;
  /** Content fingerprint of every analyzed source file. The actual freshness proof. */
  sourceFiles: SidecarSourceFile[];
  /**
   * Hash of the sorted set of type-relevant files (git-tracked TS/TSX/d.ts).
   * Catches ADDED/REMOVED ambient files that change existing sites' types but
   * aren't in `sourceFiles`. Recomputed reproducibly by the reader, no tsc.
   */
  membershipHash: string;
  /** Coverage at generation time — observability, NOT a freshness gate. */
  coverage: SidecarCoverage;
  entries: SidecarEntry[];
};

/** What the producer saw. `checkedSites/comparisonSites` is the typed-coverage ratio. */
export type SidecarCoverage = {
  /** Non-declaration, non-node_modules files in the tsc program. */
  programFiles: number;
  /** String-literal comparison sites the walk visited. */
  comparisonSites: number;
  /** Sites that resolved to a non-trivial type (i.e. entries written). */
  checkedSites: number;
};

/**
 * Headless/CI type-facts producer backed by the `opencanon analyze --typed`
 * sidecar JSON. `status()` reports `ready` when a fresh sidecar is loaded; the
 * caller constructs the provider with a pre-computed `ProducerStatus` derived
 * from `readSidecarPayloadDetailed` + setup probes (see `resolveSidecarStatus`).
 * A producer that is not `ready` carries an empty payload and resolves nothing.
 */
export class SidecarTypeFactsProvider implements TypeFactsProvider {
  readonly language = "typescript";
  private byLocation = new Map<string, SidecarEntry>();
  private readonly statusValue: ProducerStatus;

  constructor(payload: SidecarPayload | null, status: ProducerStatus) {
    this.statusValue = status;
    if (payload) {
      for (const entry of payload.entries) {
        this.byLocation.set(siteKey(entry.file, entry.line, entry.column), entry);
      }
    }
  }

  status(): ProducerStatus {
    return this.statusValue;
  }

  factGeneration(): number | undefined {
    // The sidecar serves a single loaded payload; its facts come from the
    // sidecar's generation (0 when sidecars don't carry one). Unlike the live
    // producer there is no in-process rebuild that could race the read, so the
    // loaded generation IS the fact generation.
    return this.statusValue.generation ?? 0;
  }

  resolveTypes(sites: TypeSite[]): Promise<Map<string, TypeResolution>> {
    return Promise.resolve(this.resolveTypesSync(sites));
  }

  resolveTypesSync(sites: TypeSite[]): Map<string, TypeResolution> {
    const map = new Map<string, TypeResolution>();
    // Binary: serve facts ONLY when ready.
    if (this.statusValue.kind !== ProducerStatusKind.Ready) return map;
    for (const site of sites) {
      const key = siteKey(site.file, site.line, site.column);
      const exact = this.byLocation.get(key);
      if (!exact) continue;
      const resolution = entryToResolution(exact);
      // A non-finite ("other") site never surfaces — it is simply absent.
      if (resolution) map.set(key, resolution);
    }
    return map;
  }
}

/** Reconstruct a `TypeResolution` from a serialized sidecar entry, or `undefined` for a non-finite site. */
function entryToResolution(entry: SidecarEntry): TypeResolution | undefined {
  if (entry.kind !== TypeResolutionKind.LiteralUnion) return undefined;
  return {
    language: "typescript",
    display: entry.display,
    symbolId: entry.symbolId,
    typeSource: entry.typeSource,
    kind: "literal-union",
    members: entry.members ?? [],
    syntax: entry.syntax,
  };
}

// Single source of truth for sidecar stale reasons; reference members instead of inlining the strings.
export const SidecarStaleReason = {
  Missing: "missing",
  Malformed: "malformed",
  Version: "version",
  Tsconfig: "tsconfig",
  TsVersion: "ts-version",
  SourceDrift: "source-drift",
  MembershipDrift: "membership-drift",
} as const;
export type SidecarStaleReason = (typeof SidecarStaleReason)[keyof typeof SidecarStaleReason];

/** Why a sidecar was rejected. `null` reason means it loaded clean. */
export type SidecarReadResult = { payload: SidecarPayload; staleReason: null } | { payload: null; staleReason: SidecarStaleReason };

/**
 * True when `value` is a repo-relative path that stays inside the root after
 * normalization (not absolute, no `..` escape). Backs the C3 sidecar guard.
 */
function isRootContainedRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (path.isAbsolute(value)) return false;
  return safeRelativePath(value, { allowEmpty: false }).ok;
}

/**
 * Validate + load the sidecar. Freshness is content-addressed: every analyzed
 * source file is verified by (size, mtime) with a sha256 fallback when mtime
 * drifts. This closes the mid-commit hole — editing any analyzed `.ts` changes
 * its content fingerprint and rejects the sidecar, regardless of git state.
 */
export function readSidecarPayloadDetailed(
  sidecarPath: string,
  expected: {
    rootDir: string;
    tsconfigHash: (tsconfigPath: string) => string;
    tsVersion: () => string | null;
    /** Current membership hash, when the caller can enumerate it (e.g. the producer-status gate). */
    membershipHash?: string;
  },
): SidecarReadResult {
  if (!existsSync(sidecarPath)) return { payload: null, staleReason: "missing" };
  let raw: SidecarPayload;
  try {
    raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as SidecarPayload;
  } catch {
    return { payload: null, staleReason: "malformed" };
  }
  if (raw.version !== 1) return { payload: null, staleReason: "version" };
  if (typeof raw.tsconfigPath !== "string" || raw.tsconfigPath.length === 0) return { payload: null, staleReason: "version" };
  if (!Array.isArray(raw.sourceFiles)) return { payload: null, staleReason: "version" };
  if (typeof raw.membershipHash !== "string") return { payload: null, staleReason: "version" };

  // C3: path-traversal guard. A tampered sidecar could carry an absolute or
  // `../../etc/passwd`-style `tsconfigPath`/`sourceFiles[].path` and make the
  // freshness checks stat/read/hash arbitrary files OUTSIDE rootDir. Reject any
  // such sidecar (treat as stale) BEFORE any FS access.
  if (!isRootContainedRelativePath(raw.tsconfigPath)) return { payload: null, staleReason: "malformed" };
  for (const sf of raw.sourceFiles) {
    if (typeof sf?.path !== "string" || !isRootContainedRelativePath(sf.path)) return { payload: null, staleReason: "malformed" };
  }

  // Hash the *same* tsconfig the sidecar was built from (handles `--tsconfig <alt>`).
  const currentHash = expected.tsconfigHash(raw.tsconfigPath);
  if (!currentHash || raw.tsconfigHash !== currentHash) return { payload: null, staleReason: "tsconfig" };

  // Membership: added/removed ambient files change existing sites' types without
  // appearing in sourceFiles. Only enforced when the caller supplies the current hash.
  if (expected.membershipHash !== undefined && expected.membershipHash !== raw.membershipHash) {
    return { payload: null, staleReason: "membership-drift" };
  }

  // TypeScript version: type resolution can shift across versions. Skip the check
  // when the current version can't be determined (don't hard-fail offline/odd installs).
  const currentTsVersion = expected.tsVersion();
  if (currentTsVersion && raw.tsVersion && currentTsVersion !== raw.tsVersion) {
    return { payload: null, staleReason: "ts-version" };
  }

  // Per-file content verification. stat fast-path: matching (size, mtime) trusts the
  // recorded hash; only re-hash when mtime drifts (mtime can change without content change).
  for (const sf of raw.sourceFiles) {
    const abs = path.isAbsolute(sf.path) ? sf.path : path.join(expected.rootDir, sf.path);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return { payload: null, staleReason: "source-drift" };
    }
    if (stat.size !== sf.size) return { payload: null, staleReason: "source-drift" };
    if (stat.mtimeMs === sf.mtimeMs) continue;
    let actual: string;
    try {
      actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch {
      return { payload: null, staleReason: "source-drift" };
    }
    if (actual !== sf.sha256) return { payload: null, staleReason: "source-drift" };
  }
  return { payload: raw, staleReason: null };
}

export type LiteralQuery = {
  declarationSourceId?: string | string[];
  surroundingTypeName?: string | string[];
  contexts?: Array<string>;
  valueKind?: "string" | "number" | "boolean";
};

/** A literal fact enriched with the resolved surrounding type (present only when a `ready` producer served it). */
export type ResolvedLiteralFact = ProjectLiteralFact & { surroundingType?: TypeResolution };

function toSet(value: string | string[] | undefined): Set<string> | null {
  if (value === undefined) return null;
  return new Set(Array.isArray(value) ? value : [value]);
}

/**
 * Query helper used by `ctx.typed.literal()`. Filters the supplied literal
 * stream by `declarationSourceId` (cheap, sync, syntactic) and
 * `surroundingTypeName` (read from the PRE-WARMED type map, keyed by `siteKey`).
 * The map is produced once by `prewarmTypeFacts` and only ever contains facts
 * from a `ready` producer; this function never resolves types itself.
 */
export function queryLiterals(
  literals: ProjectLiteralFact[],
  typeMap: Map<string, TypeResolution>,
  declarations: DeclarationIndex,
  query: LiteralQuery,
  onSurroundingTypeAccess?: (language: string) => void,
): ResolvedLiteralFact[] {
  void declarations; // declarationSourceId is carried on the literal facts directly.
  const declarationFilter = toSet(query.declarationSourceId);
  const types = toSet(query.surroundingTypeName);
  const contexts = toSet(query.contexts);
  const results: ResolvedLiteralFact[] = [];
  for (const literal of literals) {
    if (query.valueKind && literal.valueKind !== query.valueKind) continue;
    if (contexts && !contexts.has(literal.context)) continue;
    if (declarationFilter && (!literal.declarationSourceId || !declarationFilter.has(literal.declarationSourceId))) continue;

    // surroundingType is present only when a ready producer resolved this site;
    // it may be undefined when the producer was stale/warming/crashed.
    const surroundingType = typeMap.get(siteKey(literal.file.path, literal.line, literal.column));
    if (types && (!surroundingType || !types.has(surroundingType.display))) continue;

    // CRITICAL1: surroundingType is a LAZY getter. Reading it (even when it
    // resolves to undefined because the producer was not ready) records that
    // this validator ACTUALLY depended on producer-enriched data for this file's
    // language — so the pipeline can catch a forgetful author whose producer is
    // non-ready and undeclared, instead of silently degrading to zero findings.
    // The backing value is captured in `surroundingType` above WITHOUT going
    // through the getter, so building the result never self-triggers consumption.
    // NON-ENUMERABLE on purpose: `{ ...literal }`, `Object.assign`, `Object.entries`,
    // and `JSON.stringify(literal)` must NOT invoke the getter — only an EXPLICIT
    // `literal.surroundingType` read counts as a typed-fact dependency. Otherwise a
    // validator that merely spreads/logs the fact would trip a spurious producer outcome.
    const result = { ...literal } as ResolvedLiteralFact;
    let accessed = false;
    Object.defineProperty(result, "surroundingType", {
      enumerable: false,
      configurable: true,
      get() {
        if (!accessed) {
          accessed = true;
          onSurroundingTypeAccess?.(literal.language);
        }
        return surroundingType;
      },
    });
    results.push(result);
  }
  return results;
}

/** Sites for every comparison literal in the fact stream — the pre-warm input. */
export function comparisonSites(literals: ProjectLiteralFact[]): TypeSite[] {
  return literals
    .filter((literal) => literal.context === LiteralContext.Comparison)
    .map((literal) => ({ file: literal.file.path, line: literal.line, column: literal.column }));
}

/**
 * Map a sidecar read result + setup probes into the headless producer's
 * `ProducerStatus`. Shared by `resolveTypeFactsProvider` and the producer-status
 * surfaces (doctor/gates) so they agree on the same binary state.
 */
export function sidecarStatusFromRead(
  read: SidecarReadResult,
  setup: { hasTsconfig: boolean; hasTypeScript: boolean; typeScriptSupport?: { supported: boolean; detail?: string }; currentMembershipHash?: string },
): ProducerStatus {
  if (read.payload) {
    const warnings: ProducerWarning[] = [];
    return { language: "typescript", kind: ProducerStatusKind.Ready, ...(warnings.length ? { warnings } : {}) };
  }
  if (!setup.hasTypeScript) {
    return { language: "typescript", kind: ProducerStatusKind.MissingPackage, detail: "`typescript` is not installed in this workspace." };
  }
  if (!setup.hasTsconfig) {
    return { language: "typescript", kind: ProducerStatusKind.MissingTsconfig, detail: "no tsconfig.json found at the project root." };
  }
  if (setup.typeScriptSupport && !setup.typeScriptSupport.supported) {
    return {
      language: "typescript",
      kind: ProducerStatusKind.UnsupportedPackage,
      detail: setup.typeScriptSupport.detail,
    };
  }
  if (read.staleReason === SidecarStaleReason.Missing) {
    return {
      language: "typescript",
      kind: ProducerStatusKind.Stale,
      detail: "no typed-comparisons sidecar (run `opencanon analyze --typed`).",
    };
  }
  const warnings: ProducerWarning[] =
    read.staleReason === SidecarStaleReason.MembershipDrift
      ? [{ code: "membership-drift", message: "the set of type-relevant files changed since the sidecar was built." }]
      : [];
  return {
    language: "typescript",
    kind: ProducerStatusKind.Stale,
    detail: `typed-comparisons sidecar is stale (${read.staleReason}); re-run \`opencanon analyze --typed\`.`,
    ...(warnings.length ? { warnings } : {}),
  };
}
