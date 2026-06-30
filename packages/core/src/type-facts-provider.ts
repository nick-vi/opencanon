/**
 * Async batch type-facts seam. A per-language type PRODUCER resolves the
 * surrounding type at comparison sites. The validation pipeline pre-warms a
 * `Map<siteKey, TypeResolution>` from a `TypeFactsProvider` (the headless sidecar
 * producer, or the runtime's live producer) and the query path reads that map
 * synchronously.
 *
 * Binary contract: a site resolves to a typed fact ONLY when the file's language
 * producer is `ready`. Otherwise nothing surfaces — never a guess. There is no
 * confidence tier; a producer either serves a checked fact or it does not.
 */

/** A code location to resolve a surrounding type for. */
export type TypeSite = { file: string; line: number; column: number };

/**
 * Where the resolved type came from.
 * - "declared": the binding's declared/annotated type.
 * - "flow-narrowed": a control-flow narrowing of the declared type.
 * - "inferred": inferred (no explicit annotation).
 */
export type TypeSource = "declared" | "flow-narrowed" | "inferred";

/** A tagged literal value carried by a finite-set member. */
export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "symbolic"; display: string };

/** One member of a finite literal set (a union arm, enum member, or const-object value). */
export type LiteralMember = { name?: string; value?: LiteralValue; display: string };

/** The surface syntax a finite literal set was authored in. */
export type LiteralUnionSyntax = "ts-union" | "ts-enum" | "ts-const-object" | "py-literal" | "py-enum" | "rust-enum";

/** Fields common to every resolution shape. */
type TypeBase = {
  language: string;
  display: string;
  symbolId?: string;
  typeSource: TypeSource;
};

/**
 * A resolved surrounding type. THE SHAPE IS A HIDDEN DETAIL: rules must never
 * switch on `kind` — they go through the capability accessors below
 * (`asFiniteLiteralSet`, `finiteLiteralIncludes`). Only the accessors,
 * producers, and tests inspect the union directly.
 *
 * Every resolution that reaches a rule is a finite literal set. A non-finite or
 * unresolvable type yields NO resolution at all (the site is simply absent from
 * the resolved map) — never an `other` object.
 */
// Single source of truth for the (internal) TypeResolution discriminant; producers/accessors/tests
// inspect this directly — reference the member instead of inlining the raw string.
export const TypeResolutionKind = { LiteralUnion: "literal-union", Other: "other" } as const;
export type TypeResolutionKind = (typeof TypeResolutionKind)[keyof typeof TypeResolutionKind];

export type TypeResolution = TypeBase & { kind: "literal-union"; members: LiteralMember[]; syntax?: LiteralUnionSyntax };

/** A type whose literal members can be enumerated. */
export type FiniteLiteralSet = { members: LiteralMember[] };

/**
 * Rule API: "can I enumerate this type's literal members?" Returns the member
 * set when the resolution is a finite literal set (a string/number/boolean
 * union, enum, or const-object), otherwise `undefined`. This is the ONLY
 * sanctioned way a rule inspects literal-set-ness — never `r.kind`.
 */
export function asFiniteLiteralSet(r: TypeResolution | undefined): FiniteLiteralSet | undefined {
  if (!r || r.kind !== TypeResolutionKind.LiteralUnion) return undefined;
  return { members: r.members };
}

/** Convenience: does the finite literal set contain this string literal value? */
export function finiteLiteralIncludes(r: TypeResolution | undefined, value: string): boolean {
  const set = asFiniteLiteralSet(r);
  if (!set) return false;
  return set.members.some((m) => m.value?.kind === "string" && m.value.value === value);
}

/**
 * State of a per-language type producer. First-class surface: shown in
 * `doctor`/`project status`, gated in CI by `--require-producer`.
 * - "ready": the producer can serve type-checker-accurate facts now.
 * - "warming": a live producer exists but its program is not yet built (cold
 *   ts.Program / first incremental rebuild). Distinct from `stale`/`crashed`:
 *   it WILL become ready; queries against it must skip, not bake a stale result.
 * - "missing-tsconfig" / "missing-package": user-fixable setup gaps.
 * - "crashed": the producer ran and failed.
 * - "stale": a content-addressed producer (sidecar) is out of date.
 * - "disabled": opt-out (e.g. OPENCANON_TYPED_PRODUCER=off).
 * - "not-implemented": no producer registered for the language (expected, silent zero).
 */
/**
 * Producer-status kinds as a const value-set (the single source of truth). Code
 * compares against the declared members (`ProducerStatusKind.Ready`) instead of
 * inlining the raw strings, so the soft-enum stays refactor-safe and self-documents.
 */
export const ProducerStatusKind = {
  Ready: "ready",
  Warming: "warming",
  MissingTsconfig: "missing-tsconfig",
  MissingPackage: "missing-package",
  Crashed: "crashed",
  Stale: "stale",
  Disabled: "disabled",
  NotImplemented: "not-implemented",
} as const;
export type ProducerStatusKind = (typeof ProducerStatusKind)[keyof typeof ProducerStatusKind];

/** A non-fatal producer warning (e.g. membership drift) surfaced alongside status. */
export type ProducerWarning = { code: string; message: string };

/**
 * First-class producer state for one language. ANSWERS ONE QUESTION: "can this
 * producer serve facts right now?" (availability) plus the monotonic
 * `generation` of the program backing that answer. It does NOT describe which
 * generation a particular result was computed from — that binding lives on
 * `ValidationResult.producerSnapshot`. Producer identity is
 * `{ language, generation }` (workspaceRoot is implicit per runtime); a future
 * Python/Rust producer registers with its own language + generation and needs no
 * contract change here.
 */
export type ProducerStatus = {
  language: string;
  kind: ProducerStatusKind;
  detail?: string;
  warnings?: ProducerWarning[];
  /**
   * Monotonic build generation of the program backing this status. A live
   * producer increments it on each watch-program rebuild (afterProgramCreate).
   * Absent/0 for producers without an incremental program (sidecar, none).
   */
  generation?: number;
};

/**
 * Authoritative precedence among candidate producer statuses for ONE language.
 * Lower index = stronger. The single resolver (`pickAuthoritativeStatus`) uses
 * this so every surface (skip logic, /api/producers, --require-producer, doctor,
 * UI) reads ONE value and a sidecar can never override a live producer. A ready
 * OR warming live producer beats any sidecar state.
 */
const ProducerStatusPrecedence: ProducerStatusKind[] = [
  "ready", // live-ready (strongest)
  "warming", // live-warming — still beats any sidecar
  "crashed", // live-crashed
  "stale", // sidecar-stale (only reached when no live producer)
  "missing-package",
  "missing-tsconfig",
  "disabled",
  "not-implemented", // weakest
];

function precedenceRank(kind: ProducerStatusKind): number {
  const index = ProducerStatusPrecedence.indexOf(kind);
  return index === -1 ? ProducerStatusPrecedence.length : index;
}

/**
 * THE single authoritative producer-status resolver. Given the candidate
 * statuses for one language (e.g. a live producer's status and the sidecar's),
 * return the one that wins by precedence. The caller is responsible for ONLY
 * passing the sidecar candidate when there is no live producer for the
 * language — but even if both are passed, precedence guarantees a live
 * ready/warming/crashed status beats sidecar-stale/-ready. Stable: ties keep the
 * first candidate.
 */
export function pickAuthoritativeStatus(candidates: ProducerStatus[]): ProducerStatus {
  if (candidates.length === 0) throw new Error("pickAuthoritativeStatus requires at least one candidate");
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (precedenceRank(candidate.kind) < precedenceRank(best.kind)) best = candidate;
  }
  return best;
}

/** A producer generation a result was actually computed from: `{ kind, generation }` per language. */
export type ProducerSnapshotEntry = { kind: ProducerStatusKind; generation: number };
/** Map of language -> the producer state+generation that backed a ValidationResult. */
export type ProducerSnapshot = Record<string, ProducerSnapshotEntry>;

/**
 * Pluggable per-language batch type-info provider. The validation pipeline
 * collects every comparison literal site, calls `resolveTypes(sites)` once, and
 * caches the returned map on the validation context for synchronous reads.
 */
export interface TypeFactsProvider {
  /** Language this provider resolves, e.g. "typescript". */
  readonly language: string;
  /** Current state of this producer. Binary: only a `ready` producer serves facts. */
  status(): ProducerStatus;
  /**
   * Resolve every requested site. Returns a map keyed by `siteKey(...)`; missing
   * keys mean "no surrounding type found". Async so a future provider can talk to
   * a live type-producer process; today's backends resolve synchronously and wrap
   * the result in a resolved promise.
   */
  resolveTypes(sites: TypeSite[]): Promise<Map<string, TypeResolution>>;
  /**
   * The generation the facts from the LAST `resolveTypes` call were ACTUALLY
   * computed from — bound atomically with those facts (carried by the RPC
   * response for the live producer), NOT sampled from `status()` afterwards.
   * This is the factSnapshot generation, distinct from `status().generation`
   * (availability): a `status` event for a newer generation may land between the
   * resolveTypes response and a `status()` sample, so a result must bind THIS
   * value to avoid claiming a generation newer than the facts it used.
   *
   * Returns `undefined` when this provider has no generation concept or no
   * `resolveTypes` has happened yet (live: before the first RPC; regex/no-facts
   * path). The sidecar returns its loaded sidecar generation (or 0).
   */
  factGeneration(): number | undefined;
}

/** Stable map key for a site: `${file}:${line}:${column}`. */
export function siteKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`;
}
