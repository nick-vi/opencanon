import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentEngineTarget } from "../packages/distribution/src/update.ts";
import { createOpenCanonRelease } from "./create-opencanon-release.ts";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceCliScript = path.join(rootDir, "packages/cli/src/index.ts");

type RehearsalOptions = {
  keep: boolean;
  manifest?: string;
  noRuntime: boolean;
};

type CommandResult = {
  command: string;
  status: number;
  stderr: string;
  stdout: string;
};

type RehearsalResult = {
  badManifestRejected: boolean;
  commands: Array<{ command: string; status: number }>;
  manifest: string;
  repo: string;
  root: string;
};

export function runOpenCanonInstallRehearsal(
  options: RehearsalOptions,
): RehearsalResult {
  const root = mkdtempSync(path.join(tmpdir(), "opencanon-install-rehearsal-"));
  const repo = path.join(root, "repo");
  const releaseDir = path.join(root, "release");
  const runtimeRoot = path.join(root, "installed-runtime");
  const registryPath = path.join(root, "service.json");
  const commands: CommandResult[] = [];
  let runtimeStarted = false;

  try {
    const manifest = options.manifest
      ? path.resolve(options.manifest)
      : createLocalManifest(releaseDir);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(
      path.join(repo, "package.json"),
      `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(repo, "src/company.ts"),
      "export const company = true;\n",
    );

    run(commands, "git", ["init"], repo);
    run(commands, "git", ["add", "package.json", "src/company.ts"], repo);

    const setupArgs = [
      "init",
      "--yes",
      "--hooks",
      "codex",
      "--format",
      "json",
    ];
    if (options.noRuntime) setupArgs.push("--no-runtime");
    const setup = run(commands, process.execPath, [sourceCliScript, ...setupArgs], repo, runtimeEnv(runtimeRoot, registryPath));
    const setupOutput = JSON.parse(setup.stdout) as {
      steps: Array<{ id: string; status: string }>;
    };
    runtimeStarted = setupOutput.steps.some(
      (step) => step.id === "runtime" && step.status === "pass",
    );

    run(
      commands,
      process.execPath,
      [sourceCliScript, "context", "--files", "src/company.ts"],
      repo,
      runtimeEnv(runtimeRoot, registryPath),
    );
    run(commands, process.execPath, [sourceCliScript, "validate", "--project"], repo, runtimeEnv(runtimeRoot, registryPath));
    stopRehearsalProcesses(commands, repo, runtimeRoot, registryPath);
    runtimeStarted = false;
    run(
      commands,
      process.execPath,
      [sourceCliScript, "update", "check", "--manifest", manifest],
      repo,
      runtimeEnv(runtimeRoot, registryPath),
    );
    stopRehearsalProcesses(commands, repo, runtimeRoot, registryPath);
    run(
      commands,
      process.execPath,
      [
        sourceCliScript,
        "update",
        "apply",
        "--manifest",
        manifest,
        "--dry-run",
      ],
      repo,
      runtimeEnv(runtimeRoot, registryPath),
    );
    stopRehearsalProcesses(commands, repo, runtimeRoot, registryPath);
    runtimeStarted = false;

    const badManifest = writeBadChecksumManifest(root, manifest);
    const rejected = runExpectedFailure(
      commands,
      process.execPath,
      [sourceCliScript, "update", "apply", "--manifest", badManifest],
      repo,
      runtimeEnv(runtimeRoot, registryPath),
    );
    if (!/checksum|SHA-256/i.test(`${rejected.stdout}\n${rejected.stderr}`)) {
      throw new Error(
        [
          "Bad manifest failed, but not because of checksum validation.",
          rejected.stdout,
          rejected.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    stopRehearsalProcesses(commands, repo, runtimeRoot, registryPath);

    run(
      commands,
      process.execPath,
      [sourceCliScript, "update", "apply", "--manifest", manifest],
      repo,
      runtimeEnv(runtimeRoot, registryPath),
    );
    run(commands, process.execPath, [sourceCliScript, "project", "check"], repo, runtimeEnv(runtimeRoot, registryPath));
    if (!options.noRuntime) {
      run(commands, process.execPath, [sourceCliScript, "project", "start"], repo, runtimeEnv(runtimeRoot, registryPath));
      runtimeStarted = true;
      run(commands, process.execPath, [sourceCliScript, "project", "status"], repo, runtimeEnv(runtimeRoot, registryPath));
      run(commands, process.execPath, [sourceCliScript, "project", "stop"], repo, runtimeEnv(runtimeRoot, registryPath));
      runtimeStarted = false;
    }
    run(commands, process.execPath, [sourceCliScript, "doctor"], repo, runtimeEnv(runtimeRoot, registryPath));
    stopRehearsalProcesses(commands, repo, runtimeRoot, registryPath);

    return {
      badManifestRejected: true,
      commands: commands.map((command) => ({
        command: command.command,
        status: command.status,
      })),
      manifest,
      repo,
      root,
    };
  } finally {
    if (runtimeStarted || existsSync(repo))
      stopRehearsalProcesses(undefined, repo, runtimeRoot, registryPath);
    if (!options.keep) rmSync(root, { recursive: true, force: true });
  }
}

function createLocalManifest(releaseDir: string): string {
  const release = createOpenCanonRelease({
    assetDir: path.join(rootDir, "packages/engine/binaries"),
    clean: true,
    outDir: releaseDir,
  });
  return release.manifestPath;
}

function runtimeEnv(runtimeRoot: string, registryPath: string, extra?: Record<string, string>): Record<string, string> {
  return {
    OPENCANON_CLI: sourceCliScript,
    OPENCANON_SERVICE_REGISTRY_PATH: registryPath,
    OPENCANON_RUNTIME_ROOT: runtimeRoot,
    ...(extra ?? {}),
  };
}

function stopRehearsalProcesses(
  commands: CommandResult[] | undefined,
  repo: string,
  runtimeRoot: string,
  registryPath: string,
): void {
  if (!existsSync(repo)) return;
  const env = runtimeEnv(runtimeRoot, registryPath);
  runBestEffort(commands, process.execPath, [sourceCliScript, "project", "stop"], repo, env);
  runBestEffort(commands, process.execPath, [sourceCliScript, "service", "stop"], repo, env);
}

function writeBadChecksumManifest(root: string, manifest: string): string {
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    bundles: Record<string, { sha256: string; url: string }>;
  };
  const target = currentEngineTarget();
  const bundle = parsed.bundles[target];
  if (!bundle)
    throw new Error(`Manifest has no bundle for current target ${target}.`);
  const bundleSource = path.resolve(path.dirname(manifest), bundle.url);
  const realHash = createHash("sha256")
    .update(readFileSync(bundleSource))
    .digest("hex");
  bundle.url = bundleSource;
  bundle.sha256 = realHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  const badManifest = path.join(root, "bad-manifest.json");
  writeFileSync(badManifest, `${JSON.stringify(parsed, null, 2)}\n`);
  return badManifest;
}

function run(
  commands: CommandResult[],
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  const commandText = `${command} ${args.join(" ")}`;
  const commandResult = {
    command: commandText,
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
  commands.push(commandResult);
  if (commandResult.status !== 0) {
    throw new Error(
      [
        `Command failed: ${commandText}`,
        commandResult.stdout,
        commandResult.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return commandResult;
}

function runBestEffort(
  commands: CommandResult[] | undefined,
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  const commandResult = {
    command: `${command} ${args.join(" ")}`,
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
  commands?.push(commandResult);
  return commandResult;
}

function runExpectedFailure(
  commands: CommandResult[],
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  const commandResult = {
    command: `${command} ${args.join(" ")}`,
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
  commands.push(commandResult);
  if (commandResult.status === 0)
    throw new Error(`Command unexpectedly passed: ${commandResult.command}`);
  return commandResult;
}

function parseOptions(args: string[]): RehearsalOptions {
  const options: RehearsalOptions = { keep: false, noRuntime: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--manifest")
      options.manifest = requiredValue(args, ++index, arg);
    else if (arg === "--no-runtime") options.noRuntime = true;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown rehearsal option: ${arg}`);
    }
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  npm run rehearse:install -- [options]

Options:
  --manifest <path>  Use an existing release manifest. Default: generate one from packages/engine/binaries.
  --no-runtime       Skip project runtime startup during init.
  --keep             Keep the rehearsal directory.
`);
}

if (import.meta.main) {
  try {
    if (!existsSync(sourceCliScript))
      throw new Error(`Missing OpenCanon CLI source: ${sourceCliScript}`);
    const result = runOpenCanonInstallRehearsal(
      parseOptions(process.argv.slice(2)),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
