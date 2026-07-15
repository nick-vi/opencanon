/**
 * `TypeFactsProvider` backed by the runtime's live type-producer child process.
 * Sends one `resolveTypes` RPC per pre-warm and maps the response into the
 * `Map<siteKey, TypeResolution>` the validation seam expects (real type checker).
 * Only finite literal sets surface; a non-finite ("other") site is simply absent.
 * Returns an empty map only alongside a non-ready producer status when the
 * producer is unavailable or crashes.
 *
 * `status()` reflects the runtime's live state: `idle` before on-demand startup,
 * `ready` while a completed watch-program is live, `warming` while it is building;
 * `missing-package` / `missing-tsconfig` when it cannot spawn; `crashed` after a
 * failed query. It carries the current build `generation`.
 */
import type { ProducerStatus, TypeFactsProvider, TypeResolution, TypeSite } from "@opencanon/core";
import { TypeResolutionKind } from "@opencanon/core";
import type { TypeProducerRuntime } from "./runtime.ts";

export class LiveTypeProducerProvider implements TypeFactsProvider {
  readonly language = "typescript";

  private readonly runtime: TypeProducerRuntime;
  constructor(runtime: TypeProducerRuntime) {
    this.runtime = runtime;
  }

  // The generation the LAST resolveTypes facts were computed from, taken from
  // the RPC response and set SYNCHRONOUSLY when the query resolves. Distinct
  // from status().generation (availability) — this is the factSnapshot
  // generation a ValidationResult binds to. Undefined until the first
  // successful query, or when a query returned no facts with non-ready status.
  private lastFactGeneration?: number;

  status(): ProducerStatus {
    return this.runtime.status();
  }

  factGeneration(): number | undefined {
    return this.lastFactGeneration;
  }

  async resolveTypes(sites: TypeSite[]): Promise<Map<string, TypeResolution>> {
    const map = new Map<string, TypeResolution>();
    if (sites.length === 0) {
      // L3: no sites this run produced no facts — clear any stale generation so a
      // later ValidationResult never binds producerSnapshot.generation to a prior run.
      this.lastFactGeneration = undefined;
      return map;
    }
    let resolutions;
    try {
      const result = await this.runtime.query(sites);
      resolutions = result.resolutions;
      // Bind atomically: the generation carried by THIS response, not a later
      // status() sample that a racing rebuild may have advanced.
      this.lastFactGeneration = result.generation;
    } catch {
      // Defensive: the runtime query path records crashed status before returning
      // empty facts; clear stale generation because no facts were used this run.
      this.lastFactGeneration = undefined;
      return map;
    }
    for (const resolution of resolutions) {
      // A non-finite ("other") resolution never surfaces — binary contract.
      if (resolution.kind !== TypeResolutionKind.LiteralUnion) continue;
      // M2: an unkeyed resolution cannot be mapped to its site. Skip it rather
      // than guessing `sites[0]`, which would corrupt the multi-site map. Latent
      // today (the producer always sends a key) but kept safe by construction.
      const key = resolution.key;
      if (!key) continue;
      map.set(key, {
        language: "typescript",
        display: resolution.display,
        symbolId: resolution.symbolId,
        typeSource: resolution.typeSource,
        kind: "literal-union",
        members: resolution.members ?? [],
        syntax: resolution.syntax,
      });
    }
    return map;
  }
}
