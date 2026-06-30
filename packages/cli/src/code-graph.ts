import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPaths, discoverProjectFiles, engineSourceLanguage, fail, isCodeGraphIndexableFile } from "@opencanon/core";
import { openProjectStore, type ProjectStore } from "@opencanon/runtime";


export type CodeGraphSession = {
  store: ProjectStore;
  sourceFiles: string[];
  close(): void;
};

export function openCodeGraph(rootDir: string): CodeGraphSession {
  const paths = createPaths(rootDir);
  const discovery = discoverProjectFiles(paths);
  if (discovery.failed) fail(discovery.diagnostics.join("\n"));

  const store = openProjectStore({ rootDir, paths });
  try {
    const sourceFiles = discovery.files.filter(isCodeGraphIndexableFile);
    const scan = store.scanAndDiff(discovery.files);
    const graphIsEmpty = store.project.searchSymbols({ limit: 1 }).symbols.length === 0;
    const changedSource = (graphIsEmpty ? sourceFiles : scan.changedFiles).filter(isCodeGraphIndexableFile);
    const deletedSource = scan.deletedFiles.filter(isCodeGraphIndexableFile);
    if (changedSource.length > 0 || deletedSource.length > 0) {
      store.project.indexCodeGraph({
        // Read each changed source ONCE and pass content + its hash, so the graph
        // is built from and labelled with the same bytes (no scan->index TOCTOU).
        files: scan.files
          .filter((file) => changedSource.includes(file.path))
          .map((file) => {
            try {
              const content = readFileSync(path.join(rootDir, file.path), "utf8");
              return { path: file.path, contentHash: createHash("sha256").update(content).digest("hex"), language: engineSourceLanguage(file.path), content };
            } catch {
              return undefined;
            }
          })
          .filter((file): file is NonNullable<typeof file> => file !== undefined),
        deletedFiles: deletedSource,
      });
    }
    return {
      store,
      sourceFiles,
      close() {
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
