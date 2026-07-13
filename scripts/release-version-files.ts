import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type ReleaseRustPackage = {
  name: string;
  manifestPath: string;
  lockPaths: string[];
};

export const ReleaseRustPackages: ReleaseRustPackage[] = [
  {
    name: "opencanon-engine",
    manifestPath: "crates/opencanon-engine/Cargo.toml",
    lockPaths: ["crates/opencanon-engine/Cargo.lock"],
  },
  {
    name: "opencanon-inference",
    manifestPath: "crates/opencanon-inference/Cargo.toml",
    lockPaths: [
      "crates/opencanon-inference/Cargo.lock",
      "crates/opencanon-engine/Cargo.lock",
    ],
  },
  {
    name: "opencanon-vector",
    manifestPath: "crates/opencanon-vector/Cargo.toml",
    lockPaths: [
      "crates/opencanon-vector/Cargo.lock",
      "crates/opencanon-engine/Cargo.lock",
    ],
  },
];

export function releasePackageJsonPaths(rootDir: string): string[] {
  const paths = ["package.json"];
  for (const workspaceRoot of ["apps", "packages"]) {
    const absoluteRoot = path.join(rootDir, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePath = path.posix.join(
        workspaceRoot,
        entry.name,
        "package.json",
      );
      if (existsSync(path.join(rootDir, relativePath))) paths.push(relativePath);
    }
  }
  return paths.sort((left, right) => {
    if (left === "package.json") return -1;
    if (right === "package.json") return 1;
    return left.localeCompare(right);
  });
}

export function packageLockWorkspaceKey(packageJsonPath: string): string {
  return packageJsonPath === "package.json"
    ? ""
    : packageJsonPath.slice(0, -"/package.json".length);
}
