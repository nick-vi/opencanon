import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, initialize, type BuildOptions, type BuildResult, type Plugin } from "esbuild-wasm/esm/browser.js";

export type { Plugin };

const NodeBuiltinModules = new Set([...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)]);
const ResolveExtensions = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];
let initializePromise: Promise<void> | undefined;

export async function buildWithEsbuildWasm<T extends BuildOptions>(options: T): Promise<BuildResult<T>> {
  await initializeEsbuildWasm();
  const buildOptions: BuildOptions = {
    ...options,
    plugins: [...(options.plugins ?? []), nodeFileSystemPlugin()],
  };
  return (await build(buildOptions)) as BuildResult<T>;
}

function initializeEsbuildWasm(): Promise<void> {
  initializePromise ??= initializeEsbuildWasmOnce();
  return initializePromise;
}

async function initializeEsbuildWasmOnce(): Promise<void> {
  ensureBrowserApiNodeGlobals();
  await initialize({
    wasmModule: new WebAssembly.Module(readFileSync(resolveEsbuildWasmPath())),
    worker: false,
  });
}

function ensureBrowserApiNodeGlobals(): void {
  const currentSelf = (globalThis as { self?: unknown }).self;
  if (currentSelf && currentSelf !== globalThis) return;
  const browserSelf = Object.create(globalThis) as Record<string, unknown>;
  Object.defineProperties(browserSelf, {
    console: { value: globalThis.console },
    crypto: { value: globalThis.crypto },
    fs: { value: createBrowserFsStub() },
    path: { value: { resolve: (...segments: string[]) => segments.join("/") } },
    performance: { value: globalThis.performance },
    process: { value: createBrowserProcessStub() },
    TextDecoder: { value: globalThis.TextDecoder },
    TextEncoder: { value: globalThis.TextEncoder },
  });
  Object.defineProperty(globalThis, "self", {
    value: browserSelf,
    configurable: true,
  });
}

function createBrowserFsStub(): Record<string, unknown> {
  const enosys = () => {
    const error = new Error("not implemented") as Error & { code: string };
    error.code = "ENOSYS";
    return error;
  };
  let outputBuffer = "";
  const fsStub = {
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1, O_DIRECTORY: -1 },
    writeSync(_fd: number, buffer: Uint8Array) {
      outputBuffer += new TextDecoder().decode(buffer);
      const newline = outputBuffer.lastIndexOf("\n");
      if (newline !== -1) {
        console.log(outputBuffer.substring(0, newline));
        outputBuffer = outputBuffer.substring(newline + 1);
      }
      return buffer.length;
    },
    write(this: { writeSync(fd: number, buffer: Uint8Array): number }, _fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: Error | null, count?: number) => void) {
      if (offset !== 0 || length !== buffer.length || position !== null) {
        callback(enosys());
        return;
      }
      callback(null, this.writeSync(_fd, buffer));
    },
    fsync(_fd: number, callback: (error: Error | null) => void) {
      callback(null);
    },
  } as Record<string, unknown>;

  for (const name of ["chmod", "chown", "close", "fchmod", "fchown", "fstat", "ftruncate", "lchown", "link", "lstat", "mkdir", "open", "read", "readdir", "readlink", "rename", "rmdir", "stat", "symlink", "truncate", "unlink", "utimes"]) {
    fsStub[name] = (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback(enosys());
    };
  }

  return fsStub;
}

function createBrowserProcessStub(): Record<string, unknown> {
  return {
    getuid: () => -1,
    getgid: () => -1,
    geteuid: () => -1,
    getegid: () => -1,
    getgroups() {
      const error = new Error("not implemented") as Error & { code: string };
      error.code = "ENOSYS";
      throw error;
    },
    pid: -1,
    ppid: -1,
    umask() {
      const error = new Error("not implemented") as Error & { code: string };
      error.code = "ENOSYS";
      throw error;
    },
    cwd() {
      const error = new Error("not implemented") as Error & { code: string };
      error.code = "ENOSYS";
      throw error;
    },
    chdir() {
      const error = new Error("not implemented") as Error & { code: string };
      error.code = "ENOSYS";
      throw error;
    },
  };
}

function resolveEsbuildWasmPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimePath = path.join(moduleDir, "esbuild.wasm");
  if (existsSync(runtimePath)) return runtimePath;

  const packagePath = resolvePackageEsbuildWasmPath();
  if (packagePath && existsSync(packagePath)) return packagePath;

  const checkoutPath = path.resolve(moduleDir, "../../../node_modules/esbuild-wasm/esbuild.wasm");
  if (existsSync(checkoutPath)) return checkoutPath;

  throw new Error(`Could not resolve esbuild.wasm next to the OpenCanon runtime or in node_modules/esbuild-wasm.`);
}

function resolvePackageEsbuildWasmPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("esbuild-wasm/esbuild.wasm");
  } catch {
    return undefined;
  }
}

function nodeFileSystemPlugin(): Plugin {
  return {
    name: "opencanon-node-fs",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace && args.namespace !== "file") return undefined;
        if (NodeBuiltinModules.has(args.path)) return { path: args.path, external: true };

        if (args.kind === "entry-point" || path.isAbsolute(args.path) || isRelativeImport(args.path)) {
          const basePath = path.isAbsolute(args.path)
            ? args.path
            : path.resolve(resolveDirFor(args), args.path);
          const resolved = resolveFilePath(basePath);
          return resolved ? { path: resolved } : { errors: [{ text: `Could not resolve ${args.path}` }] };
        }

        try {
          return { path: createRequire(path.join(resolveDirFor(args), "noop.js")).resolve(args.path) };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });

      builder.onLoad({ filter: /.*/, namespace: "file" }, (args) => ({
        contents: readFileSync(args.path, "utf8"),
        loader: loaderFor(args.path),
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}

function resolveDirFor(args: { kind: string; resolveDir: string }): string {
  return args.kind === "entry-point" || !args.resolveDir || args.resolveDir === "/" ? process.cwd() : args.resolveDir;
}

function resolveFilePath(basePath: string): string | undefined {
  if (isFile(basePath)) return basePath;
  for (const extension of ResolveExtensions) {
    const candidate = `${basePath}${extension}`;
    if (isFile(candidate)) return candidate;
  }
  if (!isDirectory(basePath)) return undefined;
  const packageMain = resolvePackageMain(basePath);
  if (packageMain) return packageMain;
  for (const extension of ResolveExtensions) {
    const candidate = path.join(basePath, `index${extension}`);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function resolvePackageMain(directory: string): string | undefined {
  const packageJsonPath = path.join(directory, "package.json");
  if (!isFile(packageJsonPath)) return undefined;
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(packageJson)) return undefined;
  for (const field of ["main", "module"]) {
    const value = packageJson[field];
    if (typeof value !== "string") continue;
    const resolved = resolveFilePath(path.resolve(directory, value));
    if (resolved) return resolved;
  }
  return undefined;
}

function loaderFor(filePath: string): "js" | "jsx" | "json" | "ts" | "tsx" {
  const extension = path.extname(filePath);
  if (extension === ".ts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".json") return "json";
  return "js";
}

function isRelativeImport(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
