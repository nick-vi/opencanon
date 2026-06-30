/**
 * Runtime-owned lifecycle for the live TypeScript type-producer child process.
 * Lazy: nothing spawns on construct. The first `query` spawns the
 * child (a persistent `ts.createWatchProgram`), and an idle timer kills it after
 * a quiet window so the ~2.5GB program memory only lives while typed rules are
 * actively running. A subsequent query respawns transparently.
 *
 * This module imports `node:child_process`; it lives in packages/runtime (never
 * core). Core only sees the `LiveTypeProducerProvider` via the `TypeFactsProvider`
 * interface.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import type { ProducerStatus, TypeSite } from "@opencanon/core";

import type { LiteralMember, LiteralUnionSyntax, TypeSource } from "@opencanon/core";

/**
 * One resolution carried over JSON-RPC from the live producer. Mirrors the
 * serialized `TypeResolution` fields (minus `language`, always "typescript");
 * `live-provider` reconstructs the model from these.
 */
export type ProducerResolution = {
  key: string;
  display: string;
  symbolId?: string;
  typeSource: TypeSource;
  kind: "literal-union" | "other";
  members?: LiteralMember[];
  syntax?: LiteralUnionSyntax;
};

const DefaultIdleTimeoutMs = 5 * 60 * 1000;
// Hard ceiling on a single resolveTypes RPC. The initial query pays the full
// ts.Program build (seconds on a large repo), so this must comfortably exceed
// cold-start; beyond it we assume the producer is wedged, return no facts, and
// expose `crashed` status rather than stalling validation forever.
const DefaultRequestTimeoutMs = 60 * 1000;
// Explicit health/status warm-up is user-facing. It may pay the cold tsc watch
// build, but it should not leave the UI waiting as long as a validator RPC.
const DefaultWarmTimeoutMs = 30 * 1000;
const requireFromRuntime = createRequire(import.meta.url);

// Source (dev) runs producer-main.ts; the bundled OpenCanon runtime ships
// producer-main.js next to runtime.js. Prefer whichever sibling exists.
const defaultProducerMainPath = (() => {
  const sourcePath = fileURLToPath(new URL("./producer-main.ts", import.meta.url));
  return existsSync(sourcePath) ? sourcePath : fileURLToPath(new URL("./producer-main.js", import.meta.url));
})();

/**
 * A resolveTypes RPC result: the resolutions plus the producer `generation` the
 * facts were computed from (carried in the response so the binding is atomic
 * with the facts — never sampled from a later status). `generation` is
 * `undefined` when the producer was unavailable (no facts resolved).
 */
export type ProducerQueryResult = { resolutions: ProducerResolution[]; generation?: number };

export type TypeProducerRuntime = {
  /** Resolve the surrounding types for `sites`. Empty resolutions are paired with non-ready status when the producer is unavailable. */
  query(sites: TypeSite[]): Promise<ProducerQueryResult>;
  /** Spawn the producer if needed and wait until the first program generation is ready, returning the current status either way. */
  warm(): Promise<ProducerStatus>;
  /**
   * Producer status: `ready` when spawnable AND its program has finished
   * building (carries the build `generation`); `warming` when spawnable but the
   * program is still cold/rebuilding; `missing-*` on setup gaps; `crashed` after
   * a failed query.
   */
  status(): ProducerStatus;
  /** Register a callback fired when the producer reaches `ready` (generation advance). */
  onReady(callback: (generation: number) => void): void;
  /** Kill the child (if running) and stop the idle timer. Called on runtime stop. */
  stop(): Promise<void>;
  /** Whether a child process is currently spawned (for tests/diagnostics). */
  isRunning(): boolean;
};

export function createTypeProducerRuntime(input: {
  rootDir: string;
  tsconfigPath: string;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  warmTimeoutMs?: number;
  producerMainPath?: string;
}): TypeProducerRuntime {
  const idleTimeoutMs = input.idleTimeoutMs ?? DefaultIdleTimeoutMs;
  const requestTimeoutMs = input.requestTimeoutMs ?? DefaultRequestTimeoutMs;
  const warmTimeoutMs = input.warmTimeoutMs ?? DefaultWarmTimeoutMs;
  const producerMainPath = input.producerMainPath ?? defaultProducerMainPath;
  let child: ChildProcess | undefined;
  let rl: readline.Interface | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: ProducerQueryResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let activeQueries = 0;
  // Last query failure reason — surfaced via status() as `crashed` so a producer
  // that ran but failed reports loud, not a silent zero.
  let lastCrash: string | undefined;
  // Build state tracked from the child's status replies. `building` is true from
  // spawn until the first afterProgramCreate (warming); `generation` is the
  // child's monotonic build counter. The runtime reflects these synchronously in
  // status() and fires onReady when the generation advances into a ready state.
  let building = true;
  let generation = 0;
  const readyCallbacks: Array<(generation: number) => void> = [];
  const warmWaiters: Array<{ resolve: (status: ProducerStatus) => void; timer: ReturnType<typeof setTimeout> }> = [];
  // Serialize writes to the child's stdin: one in-flight at a time, honoring
  // backpressure (`write` returning false → await 'drain'). Without this, N
  // concurrent queries interleave/flood the pipe and ignored backpressure can
  // drop or corrupt framed lines.
  let writeChain: Promise<void> = Promise.resolve();
  const ProducerStopReason = {
    IdleTimeout: "idle-timeout",
    RuntimeStop: "runtime-stop",
    RequestTimeout: "request-timeout",
  } as const;
  type ProducerStopReason = (typeof ProducerStopReason)[keyof typeof ProducerStopReason];
  const expectedStops = new WeakMap<ChildProcess, ProducerStopReason>();

  class ControlledProducerStopError extends Error {
    constructor(reason: ProducerStopReason) {
      super(`type-producer stopped (${reason})`);
      this.name = "ControlledProducerStopError";
    }
  }

  function writeToChild(proc: ChildProcess, payload: string): Promise<void> {
    const run = writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const stdin = proc.stdin;
          if (!stdin || stdin.destroyed) {
            reject(new Error("type-producer stdin unavailable"));
            return;
          }
          let settled = false;
          const cleanup = (): void => {
            stdin.off("error", fail);
            stdin.off("close", close);
          };
          const ok = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const close = (): void => fail(new Error("type-producer stdin closed"));
          stdin.once("error", fail);
          stdin.once("close", close);
          try {
            stdin.write(payload, (error) => {
              if (error) fail(error);
              else ok();
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    // Keep the chain from rejecting permanently; swallow so the next write proceeds.
    writeChain = run.catch(() => undefined);
    return run;
  }

  function log(message: string): void {
    process.stderr.write(`[type-producer-runtime] ${message}\n`);
  }

  /** Only spawn when `typescript` resolves AND the tsconfig exists. */
  function canSpawn(): boolean {
    if (!existsSync(input.tsconfigPath)) return false;
    return typescriptResolvableFrom(input.rootDir);
  }

  function clearPending(error: Error): void {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function clearWarmWaiters(status: ProducerStatus): void {
    const waiters = warmWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(status);
    }
  }

  function detachChild(proc: ChildProcess): void {
    if (child !== proc) return;
    rl?.close();
    rl = undefined;
    proc.removeAllListeners();
    child = undefined;
  }

  function killChild(proc: ChildProcess): void {
    try {
      proc.kill();
    } catch {
      // The process may already be gone.
    }
  }

  function recordProducerCrash(message: string): void {
    if (lastCrash === message) return;
    lastCrash = message;
    log(`producer failed: ${message}`);
  }

  function producerExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const codePart = code === null ? "null" : String(code);
    const signalPart = signal ? `, signal ${signal}` : "";
    return `type-producer exited unexpectedly (code ${codePart}${signalPart})`;
  }

  function handleChildClose(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== proc) return;
    const expected = expectedStops.get(proc);
    expectedStops.delete(proc);
    detachChild(proc);
    if (expected) {
      clearPending(new ControlledProducerStopError(expected));
      clearWarmWaiters(currentStatus());
      return;
    }
    const message = producerExitMessage(code, signal);
    recordProducerCrash(message);
    clearPending(new Error(message));
    clearWarmWaiters(currentStatus());
  }

  function handleChildError(proc: ChildProcess, error: Error): void {
    if (child !== proc) return;
    const message = `type-producer process error: ${error.message}`;
    recordProducerCrash(message);
    detachChild(proc);
    clearPending(new Error(message));
    clearWarmWaiters(currentStatus());
  }

  // Apply a build-state update from the child. Generation is monotonic; a
  // transition into a ready state (not building, generation advanced) fires the
  // onReady callbacks so the runtime can refresh the snapshot (warming->ready).
  function handleStatusEvent(nextBuilding: boolean, nextGeneration: number): void {
    const advanced = nextGeneration > generation;
    if (nextGeneration >= generation) generation = nextGeneration;
    const wasBuilding = building;
    building = nextBuilding;
    const reachedReady = !nextBuilding && Boolean(child) && (advanced || wasBuilding);
    if (reachedReady) {
      lastCrash = undefined;
      resetIdleTimer();
      for (const callback of readyCallbacks) callback(generation);
      clearWarmWaiters(currentStatus());
    }
  }

  function spawnChild(): void {
    // Each spawn starts cold: warming until the first afterProgramCreate.
    building = true;
    const proc = spawn(
      process.execPath,
      [producerMainPath, "--tsconfig", input.tsconfigPath, "--root", input.rootDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: input.rootDir,
        // The child's cwd is rootDir (for TS watch correctness), but its
        // `typescript` MUST resolve from the SAME roots `canSpawn` used —
        // [rootDir, runtime cwd] — not the child's cwd. Pass the runtime cwd so
        // the producer's resolution exactly mirrors the greenlight.
        env: { ...process.env, OPENCANON_RESOLVE_CWD: process.cwd() },
      },
    );
    child = proc;
    proc.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    proc.on("error", (error) => handleChildError(proc, error));
    proc.on("close", (code, signal) => handleChildClose(proc, code, signal));
    proc.stdin?.on("error", (error) => handleChildError(proc, error));
    const out = proc.stdout;
    if (out) {
      rl = readline.createInterface({ input: out });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: { id?: number; event?: string; ready?: boolean; building?: boolean; generation?: number; result?: { resolutions?: ProducerResolution[]; generation?: number }; error?: string };
        try {
          message = JSON.parse(trimmed);
        } catch {
          return;
        }
        // Unsolicited build-state event (no id): track warming/ready + generation
        // and fire onReady callbacks when the producer advances into ready.
        if (message.event === "status") {
          handleStatusEvent(message.building ?? false, message.generation ?? generation);
          return;
        }
        if (typeof message.id !== "number") return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error));
        // Bind the response's own generation to these facts — NOT the runtime's
        // `generation`, which a racing `status` event may have already advanced.
        else waiter.resolve({ resolutions: message.result?.resolutions ?? [], generation: message.result?.generation });
      });
    }
  }

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (stopped || activeQueries > 0 || !child) {
      idleTimer = undefined;
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void shutdownChild(ProducerStopReason.IdleTimeout);
    }, idleTimeoutMs);
    // Don't keep the runtime event loop alive solely for the idle timer.
    if (typeof idleTimer === "object" && "unref" in idleTimer) (idleTimer as { unref: () => void }).unref();
  }

  function beginQuery(): void {
    activeQueries += 1;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function endQuery(): void {
    activeQueries = Math.max(0, activeQueries - 1);
    resetIdleTimer();
  }

  function currentStatus(): ProducerStatus {
    if (!existsSync(input.tsconfigPath)) {
      return { language: "typescript", kind: "missing-tsconfig", detail: `no tsconfig at ${input.tsconfigPath}.` };
    }
    if (!typescriptResolvableFrom(input.rootDir)) {
      return { language: "typescript", kind: "missing-package", detail: "`typescript` is not resolvable from the project root." };
    }
    if (lastCrash) {
      return { language: "typescript", kind: "crashed", detail: lastCrash, generation };
    }
    // A spawned child whose program has not finished its first build is
    // WARMING (distinct from stale/crashed). Once it has built at least one
    // generation it is ready; an idle-killed child that previously built stays
    // ready (the next query re-warms transparently).
    if (child && building) {
      return { language: "typescript", kind: "warming", detail: "type program is building.", generation };
    }
    if (generation === 0) {
      // Spawnable but never warmed (no query yet, or building before first
      // afterProgramCreate). Report warming so a boot snapshot skips loudly
      // instead of baking a stale/empty result.
      return { language: "typescript", kind: "warming", detail: "type producer not yet warmed.", generation };
    }
    return { language: "typescript", kind: "ready", generation };
  }

  async function shutdownChild(reason: ProducerStopReason): Promise<void> {
    if (!child) return;
    const proc = child;
    expectedStops.set(proc, reason);
    if (reason !== ProducerStopReason.IdleTimeout) {
      clearPending(new ControlledProducerStopError(reason));
    }
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 250);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Route through writeToChild (the serialized write chain) so the shutdown
    // line can never interleave with an in-flight resolveTypes write and corrupt
    // a framed line. Errors are irrelevant — we kill the child next regardless.
    await writeToChild(proc, `${JSON.stringify({ id: nextId++, method: "shutdown" })}\n`).catch(() => {});
    await closed;
    if (child === proc) {
      detachChild(proc);
      killChild(proc);
    }
  }

  return {
    async query(sites) {
      if (stopped || sites.length === 0 || !canSpawn()) return { resolutions: [] };
      if (!child) {
        try {
          spawnChild();
        } catch (error) {
          log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
          if (child) detachChild(child);
          return { resolutions: [] };
        }
      }
      const id = nextId++;
      const proc = child;
      if (!proc?.stdin) return { resolutions: [] };
      beginQuery();
      const result = await new Promise<ProducerQueryResult>((resolve, reject) => {
        // Reject (and respawn-on-next-query) if the producer never answers — a
        // wedged child must never stall validation indefinitely.
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          const message = `type-producer request ${id} timed out after ${requestTimeoutMs}ms`;
          recordProducerCrash(message);
          // teardownChild removes the exit listener, so reject siblings here too —
          // they share the now-dead child and would otherwise wait out their own timers.
          const timedOutChild = child;
          if (timedOutChild) {
            expectedStops.set(timedOutChild, ProducerStopReason.RequestTimeout);
            detachChild(timedOutChild);
            killChild(timedOutChild);
          }
          clearPending(new Error("type-producer killed after request timeout"));
          reject(new Error(message));
        }, requestTimeoutMs);
        if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();
        pending.set(id, { resolve, reject, timer });
        writeToChild(proc, `${JSON.stringify({ id, method: "resolveTypes", sites })}\n`).catch((error) => {
          const waiter = pending.get(id);
          if (waiter) {
            clearTimeout(waiter.timer);
            pending.delete(id);
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      })
        .then((result) => {
          lastCrash = undefined;
          return result;
        })
        .catch((error) => {
          if (error instanceof ControlledProducerStopError) return { resolutions: [] };
          // Do not throw through validation: a crashed/unavailable producer yields
          // no facts and status() reports `crashed` for loud validator outcomes.
          const message = error instanceof Error ? error.message : String(error);
          if (lastCrash !== message) {
            lastCrash = message;
            log(`query failed: ${lastCrash}`);
          }
          return { resolutions: [] };
        });
      endQuery();
      return result;
    },
    async warm() {
      if (stopped || !canSpawn()) return currentStatus();
      const status = currentStatus();
      if (status.kind !== "warming") return status;
      if (!child) {
        try {
          spawnChild();
        } catch (error) {
          log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
          if (child) detachChild(child);
          return currentStatus();
        }
      }
      const afterSpawnStatus = currentStatus();
      if (afterSpawnStatus.kind !== "warming") return afterSpawnStatus;
      return await new Promise<ProducerStatus>((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const index = warmWaiters.indexOf(waiter);
            if (index >= 0) warmWaiters.splice(index, 1);
            resolve(currentStatus());
          }, warmTimeoutMs),
        };
        if (typeof waiter.timer === "object" && "unref" in waiter.timer) (waiter.timer as { unref: () => void }).unref();
        warmWaiters.push(waiter);
      });
    },
    onReady(callback) {
      readyCallbacks.push(callback);
    },
    status() {
      return currentStatus();
    },
    async stop() {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      await shutdownChild(ProducerStopReason.RuntimeStop);
      if (child) {
        const proc = child;
        detachChild(proc);
        killChild(proc);
      }
      clearPending(new ControlledProducerStopError(ProducerStopReason.RuntimeStop));
      clearWarmWaiters(currentStatus());
    },
    isRunning() {
      return Boolean(child);
    },
  };
}

/**
 * Whether `typescript` resolves from a target repo, using the SAME roots the
 * live producer (`producer-main`) uses to load it ([rootDir, process.cwd()]).
 * Single source of truth so the spawn greenlight and the child's actual load
 * never disagree. Shared by `canSpawn` and the live producer's `status()`.
 */
export function typescriptResolvableFrom(rootDir: string): boolean {
  try {
    requireFromRuntime.resolve("typescript", { paths: [rootDir, process.cwd()] });
    return true;
  } catch {
    return false;
  }
}

/** Default tsconfig location for a project root; undefined when absent. */
export function defaultTsconfigPath(rootDir: string): string | undefined {
  const candidate = path.join(rootDir, "tsconfig.json");
  return existsSync(candidate) ? candidate : undefined;
}
