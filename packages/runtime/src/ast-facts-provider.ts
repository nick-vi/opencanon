/**
 * Engine-backed `ProjectAstFactsProvider` (AST facts). Core defines the seam
 * (`setProjectAstFactsProviderFactory`) and stays engine-free; this module — which
 * owns @opencanon/engine — supplies the implementation. Shared by the runtime (which
 * reuses its long-lived open project) and the CLI (which opens a per-process
 * temp project lazily on first AST fact query).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  createPaths,
  engineSourceLanguage,
  setProjectAstFactsProviderFactory,
  type FileFacts,
  type ProjectAstFactsProvider,
  type ProjectAstFactsProviderFactory,
} from "@opencanon/core";
import type { EngineProject } from "@opencanon/engine";
import { openProjectStore, type ProjectStore } from "./state.ts";

/** The engine parser version every extract request is tagged with (covers all
 * engine parsers — oxc for TS/JS, rustpython for Python). Mirrors the Rust
 * PARSER_VERSION (crates/opencanon-engine/src/constants.rs); single source for
 * the runtime so the provider and snapshot extract can't drift. */
export const ENGINE_PARSER_VERSION = "oxc-0.128.0";

function factFileRequest(filePath: string, text: string) {
  return {
    path: filePath,
    contentHash: createHash("sha256").update(text).digest("hex"),
    language: engineSourceLanguage(filePath),
    content: text,
  };
}

/** Every base fact kind — extracted in ONE engine call per file (single parse). */
const ALL_FACT_KINDS = ["imports", "exports", "symbols", "declarations", "calls", "literals", "comments"] as const;

/**
 * Engine-backed provider: returns raw language-neutral FileFacts (all kinds, ONE
 * parse), cached per (path, content hash). Core (packages/core/src/ast-fact-mappers)
 * adapts them to the per-language accessor shapes — this module is pure extraction.
 */
export function engineProjectAstFactsProvider(project: EngineProject): ProjectAstFactsProvider {
  const cache = new Map<string, { hash: string; facts: FileFacts | undefined }>();
  return {
    factsFor(filePath, text) {
      const hash = createHash("sha256").update(text).digest("hex");
      const hit = cache.get(filePath);
      if (hit && hit.hash === hash) return hit.facts;
      const result = project.extractFacts({ files: [factFileRequest(filePath, text)], facts: [...ALL_FACT_KINDS], parserVersion: ENGINE_PARSER_VERSION });
      const facts = result.files[0];
      cache.set(filePath, { hash, facts });
      return facts;
    },
  };
}

/**
 * A LAZY CLI factory: opens (and caches) ONE engine project per rootDir, only on
 * the first AST fact query for that root — commands that never read AST facts
 * pay nothing. Each project uses an isolated per-process temp sqlite (pid + nonce) so
 * concurrent one-shot CLI runs never share state. Call `dispose()` in a `finally`
 * to close stores and remove the temp dirs.
 */
export function createCliAstFactsProvider(): { factory: ProjectAstFactsProviderFactory; dispose: () => void } {
  const stores = new Map<string, ProjectStore>();
  const providers = new Map<string, ProjectAstFactsProvider>();
  const tempDirs: string[] = [];
  const factory: ProjectAstFactsProviderFactory = (rootDir) => {
    const provider = providers.get(rootDir);
    if (provider) return provider;
    let store = stores.get(rootDir);
    if (!store) {
      const stateDir = mkdtempSync(path.join(tmpdir(), `opencanon-cli-${process.pid}-`));
      tempDirs.push(stateDir);
      try {
        store = openProjectStore({ rootDir, paths: createPaths(rootDir), statePath: path.join(stateDir, "state.sqlite") });
      } catch {
        return undefined;
      }
      stores.set(rootDir, store);
    }
    const nextProvider = engineProjectAstFactsProvider(store.project);
    providers.set(rootDir, nextProvider);
    return nextProvider;
  };
  const dispose = () => {
    for (const store of stores.values()) {
      try {
        store.close();
      } catch {
        // best effort
      }
    }
    stores.clear();
    providers.clear();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    tempDirs.length = 0;
  };
  return { factory, dispose };
}

/**
 * Install the engine-backed AST facts provider for the duration of `fn`, then
 * dispose it. The supported way for any in-process host (CLI, external @opencanon
 * consumers, tests) to satisfy the "provider required for TS facts" contract:
 *
 *   await withCliAstFactsProvider(() => runValidation({ ... }));
 *
 * Lazy per rootDir; a `process.exit` backstop disposes for callers that exit
 * without unwinding the `finally`.
 */
export async function withCliAstFactsProvider<T>(fn: () => Promise<T> | T): Promise<T> {
  const ast = createCliAstFactsProvider();
  setProjectAstFactsProviderFactory(ast.factory);
  const cleanup = () => {
    setProjectAstFactsProviderFactory(undefined);
    ast.dispose();
  };
  process.once("exit", cleanup);
  try {
    return await fn();
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
}
