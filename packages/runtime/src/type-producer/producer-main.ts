/**
 * Live TypeScript type-producer child process. Serves the interactive runtime
 * (the batch `analyze --typed` sidecar is the headless/CI producer). Instead of
 * fingerprinting a JSON cache, this process holds a persistent incremental
 * `ts.createWatchProgram`. The watch host auto-watches the FS and
 * rebuilds incrementally on every change, so each `resolveTypes` query runs
 * against an always-fresh program — freshness is the watch loop, not a hash.
 *
 * Protocol: newline-delimited JSON-RPC over stdin/stdout. stderr is logs only.
 *   request  {id, method:"resolveTypes", sites:[{file,line,column}]}
 *   response {id, result:{resolutions:[{key,display,symbolId?,typeSource,kind,...}], generation}}
 *   request  {id, method:"status"}   -> {id, result:{ready,building,generation}}
 *   unsolicited {event:"status", ready, building, generation} on each build start
 *     and completion, so the runtime observes warming/ready transitions without polling.
 *   request  {id, method:"shutdown"} -> flush + exit 0
 *   malformed line -> ignored (JSON parse failures are logged, never answered).
 *
 * This module imports `typescript`; it lives in packages/runtime (never core).
 */
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import type ts from "typescript";

type Sites = Array<{ file: string; line: number; column: number }>;
type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "symbolic"; display: string };
type Member = { name?: string; value?: LiteralValue; display: string };
type Resolution = {
  key: string;
  display: string;
  symbolId?: string;
  typeSource: "declared" | "flow-narrowed" | "inferred";
  kind: "literal-union" | "other";
  members?: Member[];
  syntax?: "ts-union" | "ts-enum" | "ts-const-object" | "py-literal" | "py-enum" | "rust-enum";
};

function log(message: string): void {
  process.stderr.write(`[type-producer] ${message}\n`);
}

/** `${file}:${line}:${column}` — mirrors core's `siteKey`, kept local so this child never imports core. */
function siteKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`;
}

function parseArgs(argv: string[]): { tsconfig: string; root: string } {
  let tsconfig: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tsconfig") tsconfig = argv[++i];
    else if (argv[i] === "--root") root = argv[++i];
  }
  if (!tsconfig || !root) {
    log("missing required --tsconfig / --root args");
    process.exit(2);
  }
  return { tsconfig: path.resolve(tsconfig), root: path.resolve(root) };
}

async function main(): Promise<void> {
  const { tsconfig, root } = parseArgs(process.argv.slice(2));
  // Resolve `typescript` from the TARGET REPO, not relative to this bundled file.
  // In the installed runtime, a bare `import("typescript")` resolves against the
  // runtime dir (no target repo typescript) and the child dies. Resolve from the
  // SAME roots `canSpawn`/the live producer `status()` use ([root, cwd]) so
  // greenlight and load agree.
  const requireFrom = createRequire(import.meta.url);
  // Resolution roots mirror canSpawn EXACTLY: [root, runtime
  // cwd]. The runtime passes its own cwd via OPENCANON_RESOLVE_CWD because the
  // child's own cwd is rootDir, which would diverge from the greenlight.
  const resolveCwd = process.env.OPENCANON_RESOLVE_CWD ?? process.cwd();
  const resolveRoots = [root, resolveCwd];
  let tsPath: string;
  try {
    tsPath = requireFrom.resolve("typescript", { paths: resolveRoots });
  } catch {
    process.stderr.write(
      `[type-producer] cannot resolve 'typescript' from ${resolveRoots.join(" or ")}; ` +
        `install it as a devDependency in the target repo. Exiting.\n`,
    );
    process.exit(2);
  }
  const tsModule = (await import(pathToFileURL(tsPath).href)) as { default?: typeof ts } & typeof ts;
  const TS = tsModule.default ?? tsModule;

  // The current builder program. The watch host swaps this on every rebuild.
  let builder: ts.SemanticDiagnosticsBuilderProgram | undefined;
  let building = true; // assume building until the first idle status arrives
  // Monotonic build generation: incremented on each watch-program rebuild
  // (afterProgramCreate). Producer identity is {language, generation}; the runtime
  // reports it through status so a ValidationResult can bind to the exact
  // generation it used and a warming->ready transition is observable.
  let generation = 0;
  // Promises waiting for the next idle (build-complete) tick.
  let idleWaiters: Array<() => void> = [];

  function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
  // Push an unsolicited status event so the project runtime observes warming->ready
  // transitions (and generation advances) without polling. The runtime keys on
  // `event:"status"` (no `id`) and ignores it for the RPC correlation map.
  function emitStatus(): void {
    send({ event: "status", ready: Boolean(builder) && !building, building, generation });
  }

  const host = TS.createWatchCompilerHost(
    tsconfig,
    {},
    TS.sys,
    TS.createSemanticDiagnosticsBuilderProgram,
    () => {
      // Swallow per-file tsc diagnostics. We answer type queries, not type errors;
      // echoing the target repo's parse/type diagnostics to the runtime log is pure
      // noise (it spammed hundreds of lines on real repos). Set OPENCANON_PRODUCER_DEBUG
      // to surface them when debugging the producer itself.
      // (intentionally no-op)
    },
    (diagnostic) => {
      // Watch-status: TS emits a "starting compilation" code when a rebuild
      // begins and a "compilation complete" code when it finishes. We track a
      // coarse building flag and release idle waiters on completion.
      const code = diagnostic.code;
      // 6031: starting (initial), 6032: file change detected (incremental start).
      if (code === 6031 || code === 6032) {
        building = true;
        emitStatus();
        return;
      }
      // 6193/6194: compilation complete (with/without errors). Treat any other
      // status as "settled" so we never hang waiters on an unexpected code.
      building = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    },
  );

  // Capture each successive program as the watch loop rebuilds.
  const originalAfterCreate = host.afterProgramCreate;
  host.afterProgramCreate = (program) => {
    builder = program;
    building = false;
    generation += 1;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
    emitStatus();
    originalAfterCreate?.(program);
  };

  TS.createWatchProgram(host);

  function whenIdle(): Promise<void> {
    if (!building && builder) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  }

  function resolveSites(sites: Sites): Resolution[] {
    const program = builder?.getProgram();
    if (!program) return [];
    const checker = program.getTypeChecker();
    const comparisons = new Set<ts.SyntaxKind>([
      TS.SyntaxKind.EqualsEqualsEqualsToken,
      TS.SyntaxKind.ExclamationEqualsEqualsToken,
      TS.SyntaxKind.EqualsEqualsToken,
      TS.SyntaxKind.ExclamationEqualsToken,
    ]);
    const out: Resolution[] = [];
    for (const site of sites) {
      const abs = path.resolve(root, site.file);
      const sf = program.getSourceFile(abs);
      if (!sf) continue;
      // sites are 1-based (line/column); TS positions are 0-based.
      let pos: number;
      try {
        pos = sf.getPositionOfLineAndCharacter(site.line - 1, site.column - 1);
      } catch {
        continue;
      }
      const literal = findStringLiteralAt(TS, sf, pos);
      if (!literal) continue;
      const parent = literal.parent;
      if (!parent || !TS.isBinaryExpression(parent) || !comparisons.has(parent.operatorToken.kind)) continue;
      const opposite = parent.left === literal ? parent.right : parent.left;
      const type = checker.getTypeAtLocation(opposite);
      const typeName = checker.typeToString(type);
      if (!typeName || typeName === "string" || typeName === "any" || typeName === "unknown") continue;
      out.push({ key: siteKey(site.file, site.line, site.column), ...extractResolution(TS, checker, type, opposite, typeName) });
    }
    return out;
  }

  const rl = readline.createInterface({ input: process.stdin });
  // C2: never outlive the runtime. The parent owns our stdin; when it dies (crash
  // or SIGKILL) the pipe closes, so exit on stdin end / readline close. Also poll
  // ppid: if it becomes 1 we were reparented to init (orphaned) — exit so the
  // ~2.5GB watch program is reclaimed.
  rl.on("close", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  const ppidTimer = setInterval(() => {
    if (process.ppid === 1) process.exit(0);
  }, 5000);
  if (typeof ppidTimer === "object" && "unref" in ppidTimer) ppidTimer.unref();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: { id?: unknown; method?: unknown; sites?: unknown };
    try {
      request = JSON.parse(trimmed);
    } catch {
      // Unparseable line — no id to correlate; ignore (never crash).
      log(`ignoring malformed line`);
      return;
    }
    const id = request.id;
    try {
      if (request.method === "status") {
        send({ id, result: { ready: Boolean(builder) && !building, building, generation } });
        return;
      }
      if (request.method === "shutdown") {
        send({ id, result: { ok: true } });
        rl.close();
        process.exit(0);
      }
      if (request.method === "resolveTypes") {
        const sites = Array.isArray(request.sites) ? (request.sites as Sites) : [];
        // Await the next idle for correctness: a query mid-build resolves against
        // the COMPLETED program, never a half-built one.
        await whenIdle();
        // Capture the generation of the program we resolve against AT the moment
        // of resolution (after whenIdle, before any further await/program swap),
        // and carry it in the response. This binds the facts to the EXACT
        // generation that produced them, so the consumer never samples a newer
        // generation from a `status` event that races in afterward.
        const resolutions = resolveSites(sites);
        send({ id, result: { resolutions, generation } });
        return;
      }
      send({ id, error: `unknown method: ${String(request.method)}` });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });

  log(`started (tsconfig=${tsconfig})`);
}

/**
 * Map a tsc `Type` into the serialized resolution fields. Mirrors the sidecar
 * producer's `extractResolution` (packages/cli/src/analyze.ts).
 */
function extractResolution(
  TS: typeof ts,
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  display: string,
): Omit<Resolution, "key"> {
  const symbolId = type.getSymbol()?.getName();
  let typeSource: Resolution["typeSource"] = "declared";
  try {
    // flow-narrowing detection covers plain identifiers and simple property
    // accesses (e.g. `state.kind`); other expression forms keep "declared".
    const declared = TS.isIdentifier(node) || TS.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
    if (declared) {
      const declaredType = checker.getTypeOfSymbolAtLocation(declared, node);
      if (declaredType !== type && checker.typeToString(declaredType) !== display) typeSource = "flow-narrowed";
    }
  } catch {
    // best-effort
  }
  const other: Omit<Resolution, "key"> = { display, symbolId, typeSource, kind: "other" };
  const lit = literalMembers(TS, checker, type);
  if (!lit) return other;
  return { display, symbolId, typeSource, kind: "literal-union", members: lit.members, syntax: lit.syntax };
}

function literalMembers(
  TS: typeof ts,
  checker: ts.TypeChecker,
  type: ts.Type,
): { members: Member[]; syntax: Resolution["syntax"] } | undefined {
  const Flags = TS.TypeFlags;
  const isEnumLike = Boolean(type.flags & Flags.EnumLike);
  const arms = (type as ts.UnionType).isUnion?.() ? (type as ts.UnionType).types : [type];
  const members: Member[] = [];
  let sawEnumMember = false;
  for (const arm of arms) {
    const m = literalMemberOf(TS, checker, arm);
    if (!m) return undefined;
    if (arm.flags & (Flags.EnumLiteral | Flags.Enum)) sawEnumMember = true;
    members.push(m);
  }
  if (members.length === 0) return undefined;
  return { members, syntax: isEnumLike || sawEnumMember ? "ts-enum" : "ts-union" };
}

function literalMemberOf(TS: typeof ts, checker: ts.TypeChecker, arm: ts.Type): Member | undefined {
  const Flags = TS.TypeFlags;
  const name = arm.symbol?.getName();
  if (arm.flags & Flags.StringLiteral) {
    const value = (arm as ts.StringLiteralType).value;
    return { name, value: { kind: "string", value }, display: JSON.stringify(value) };
  }
  if (arm.flags & Flags.NumberLiteral) {
    const value = (arm as ts.NumberLiteralType).value;
    return { name, value: { kind: "number", value }, display: String(value) };
  }
  if (arm.flags & Flags.BooleanLiteral) {
    const display = checker.typeToString(arm);
    return { name, value: { kind: "boolean", value: display === "true" }, display };
  }
  if (arm.flags & Flags.Null) return { name, value: { kind: "null" }, display: "null" };
  if (arm.flags & (Flags.EnumLiteral | Flags.Enum)) {
    const raw = (arm as ts.LiteralType as { value?: string | number }).value;
    const value =
      typeof raw === "string" ? ({ kind: "string", value: raw } as const)
      : typeof raw === "number" ? ({ kind: "number", value: raw } as const)
      : undefined;
    return { name, value, display: checker.typeToString(arm) };
  }
  return undefined;
}

function findStringLiteralAt(TS: typeof ts, sf: ts.SourceFile, pos: number): ts.StringLiteral | undefined {
  let found: ts.StringLiteral | undefined;
  const visit = (node: ts.Node): void => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return;
    if (TS.isStringLiteral(node) && node.getStart(sf) === pos) {
      found = node;
      return;
    }
    TS.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
