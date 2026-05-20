import { createPaths, discoverProjectFiles, fail } from "@opencanon/core";
import { openProjectStore, type DaemonStore } from "@opencanon/daemon";

const oxcExtensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];

export type CodeGraphSession = {
  store: DaemonStore;
  sourceFiles: string[];
  close(): void;
};

export function openCodeGraph(rootDir: string): CodeGraphSession {
  const paths = createPaths(rootDir);
  const discovery = discoverProjectFiles(paths);
  if (discovery.failed) fail(discovery.diagnostics.join("\n"));

  const store = openProjectStore({ rootDir, paths });
  try {
    const sourceFiles = discovery.files.filter(isOxcSourceFile);
    const scan = store.scanAndDiff(discovery.files);
    const graphIsEmpty = store.project.searchSymbols({ limit: 1 }).symbols.length === 0;
    const changedSource = (graphIsEmpty ? sourceFiles : scan.changedFiles).filter(isOxcSourceFile);
    const deletedSource = scan.deletedFiles.filter(isOxcSourceFile);
    if (changedSource.length > 0 || deletedSource.length > 0) {
      store.project.indexCodeGraph({
        files: scan.files
          .filter((file) => changedSource.includes(file.path))
          .map((file) => ({ path: file.path, contentHash: file.contentHash, language: languageForFile(file.path) })),
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

function isOxcSourceFile(file: string): boolean {
  return oxcExtensions.some((extension) => file.endsWith(extension));
}

function languageForFile(file: string): "typescript" | "tsx" | "javascript" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".mts") || file.endsWith(".cts") || file.endsWith(".ts")) return "typescript";
  return "javascript";
}
