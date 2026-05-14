import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const UiChunkName = {
  Diff: "opencanon-diff",
} as const;

const DeferredAssetName = ["MarkdownPreview", "opencanon-diff"] as const;

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 10_500,
    modulePreload: {
      resolveDependencies(_url, deps) {
        return deps.filter((dep) => !DeferredAssetName.some((name) => dep.includes(name)));
      },
    },
    rollupOptions: {
      output: {
        assetFileNames: assetFileName,
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/opencanon-ui-[hash].js",
        manualChunks: manualChunks,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4767",
    },
  },
  worker: {
    rollupOptions: {
      output: {
        assetFileNames: assetFileName,
        chunkFileNames: "assets/opencanon-worker-[name]-[hash].js",
        entryFileNames: "assets/opencanon-worker-[hash].js",
      },
    },
  },
});

function manualChunks(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");
  if (isDiffChunk(normalized)) return UiChunkName.Diff;
  return undefined;
}

function isDiffChunk(id: string): boolean {
  return (
    id.includes("/src/DiffViewer") ||
    id.includes("@codemirror/merge")
  );
}

function assetFileName(assetInfo: { name?: string }): string {
  if (assetInfo.name?.endsWith(".css")) return "assets/opencanon-ui-[hash][extname]";
  return "assets/[name]-[hash][extname]";
}
