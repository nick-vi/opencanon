/**
 * Reference sketch for the unified Convention model.
 *
 * Source of truth: packages/core/src/convention.ts. This file is intentionally
 * abridged so the design shape can be read without the surrounding runtime code.
 *
 * Design rules baked in (from the Nick + 2-agent + codex discussion):
 *  - ONE umbrella concept: Convention. "Decision" becomes a render style, not a separate type.
 *  - NO persisted status. Writing+committing the definition IS ratification. A convention
 *    with a runtime validator enforces immediately, so the act of committing it = agreement.
 *  - Composition over a god-kind: independent axes (render / runtime / applies) are each their
 *    OWN small discriminated union. We compose them — we do NOT make one top-level `kind` that
 *    explodes into docs×runtime×gate combinations.
 *  - Invariant: Definition Markdown is ALWAYS render(definition) when present. There is no
 *    hand-edited Markdown opt-out. The agent's freedom lives in the definition fields,
 *    never in the rendered .md.
 */

// ── abridged supporting types from @opencanon/core ───────────────────────────
type Severity = "error" | "warning";
type ValidatorScope = "file" | "folder" | "import-edge" | "package" | "project";
type FactKind = "imports" | "exports" | "symbols" | "calls" | "literals" | "comments" | "declarations" | "references";
type Finding = { line: number; message: string };
type ValidatorArgs = { ctx: unknown; runtime: unknown };
type ConventionId = string; // stable machine identity AND the cross-reference key (never the title)

// ── AXIS 1: applies — where the convention is in scope ───────────────────────
// Structured enough for the engine; render() turns it into "Applies to: …" prose.
type Applies =
  | { kind: "files"; globs: string[] }
  | { kind: "symbols"; globs: string[]; symbolKinds?: ("function" | "class" | "type")[] }
  | { kind: "imports"; from?: string[]; to?: string[] }
  | { kind: "impact-surface"; surfaceIds: string[] }
  | { kind: "custom"; describe: string }; // free prose when it can't be structured

// ── AXIS 2: render — how (and whether) docs are produced ─────────────────────
// `generated`: OpenCanon owns the .md; it is render(definition); doctor re-renders + diffs.
// `none`:      no doc (e.g. a pure-test convention).
type Render =
  | { kind: "generated"; docs: string; style: RenderStyle }
  | { kind: "none" };

type RenderStyle = "narrative" | "checklist" | "reference" | "architecture-note" | "decision-record";

// ── AXIS 3: runtime — whether/how it is enforced ─────────────────────────────
// `none`:      docs-only advisory.
// `validator`: produces findings (advisory by default — surfaced, not blocking).
// `gate`:      blocks commit until the user resolves it (intent-sensitive).
// `test`:      validator-only convention with no docs (kind of validator that ships as canon).
type Runtime =
  | { kind: "none" }
  | { kind: "validator"; severity: Severity; scope: ValidatorScope; facts: FactKind[]; validate(args: ValidatorArgs): Finding[] }
  | { kind: "gate"; question: string; scope: ValidatorScope; facts: FactKind[]; validate(args: ValidatorArgs): Finding[] }
  | { kind: "test"; severity: Severity; scope: ValidatorScope; facts: FactKind[]; validate(args: ValidatorArgs): Finding[] };

// ── The Convention: common identity + the three composed axes ────────────────
// Common fields exist on EVERY convention (needed even for validator-only ones so they're
// legible in gates + history). The agent fills `why`/`rule`/`examples`; render() consumes them.
type Convention = {
  id: ConventionId;
  title: string; // human heading; the doc anchor derives from this (kebab), links use `id`
  why?: string;
  rule: string;
  examples?: { good?: string; bad?: string; note?: string }[];
  related?: ConventionId[]; // backlinks to other conventions
  impactSurfaces?: string[]; // surfaces this convention touches (impact-surface backlinks the other way)
  applies: Applies;
  render: Render;
  runtime: Runtime;
};

// ── examples: same shape covers every "a convention can be …" bullet ─────────

// docs-only: rendered narrative, no enforcement.
const _decisionLike: Convention = {
  id: "service-db-boundary",
  title: "Service database boundary",
  why: "Services must not import DB clients directly; routing through the DAL keeps data access auditable.",
  rule: "A *.service.ts file may not import from db/client.",
  applies: { kind: "imports", from: ["**/*.service.ts"], to: ["**/db/client*"] },
  render: { kind: "generated", docs: "docs/opencanon/service-db-boundary.md", style: "narrative" },
  runtime: { kind: "none" },
};

// docs + enforced (advisory): generated reference doc AND a validator.
const _docsAndRuntime: Convention = {
  id: "no-native-enums",
  title: "No native enums in contracts",
  rule: "Contract files use const value-sets, not `enum`.",
  applies: { kind: "files", globs: ["src/contracts/**"] },
  render: { kind: "generated", docs: "docs/opencanon/no-native-enums.md", style: "reference" },
  runtime: { kind: "validator", severity: "error", scope: "file", facts: ["declarations"], validate: () => [] },
};

// approval-gated: blocks commit, asks the user a question (reuses the gate/ask mechanism).
const _gated: Convention = {
  id: "sensitive-change-requires-approval",
  title: "Sensitive change requires approval",
  rule: "Edits to impact-surface files need explicit user approval before commit.",
  applies: { kind: "impact-surface", surfaceIds: ["billing", "auth"] },
  render: { kind: "generated", docs: "docs/opencanon/sensitive-changes.md", style: "reference" },
  runtime: { kind: "gate", question: "Do you approve this sensitive change?", scope: "project", facts: ["references"], validate: () => [] },
};

// pure-test: validator-only canon, no docs.
const _pureTest: Convention = {
  id: "python-no-bare-except",
  title: "No bare except in Python",
  rule: "`except:` must name an exception type.",
  applies: { kind: "files", globs: ["**/*.py"] },
  render: { kind: "none" },
  runtime: { kind: "test", severity: "warning", scope: "file", facts: ["calls"], validate: () => [] },
};

export type { Convention, Applies, Render, Runtime, RenderStyle, ConventionId };
