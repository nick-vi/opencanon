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
import { currentEngineTarget } from "../packages/daemon/src/update.ts";
import { createOpenCanonRelease } from "./create-opencanon-release.ts";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSkillScript = path.join(
  rootDir,
  ".agents/skills/opencanon/scripts/opencanon.ts",
);

type RehearsalOptions = {
  keep: boolean;
  manifest?: string;
  noDaemon: boolean;
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
  const commands: CommandResult[] = [];
  let daemonStarted = false;

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
      "setup",
      "--yes",
      "--hooks",
      "codex",
      "--manifest",
      manifest,
      "--format",
      "json",
    ];
    if (options.noDaemon) setupArgs.push("--no-daemon");
    const setup = run(commands, "bun", [sourceSkillScript, ...setupArgs], repo);
    const setupOutput = JSON.parse(setup.stdout) as {
      steps: Array<{ id: string; status: string }>;
    };
    daemonStarted = setupOutput.steps.some(
      (step) => step.id === "daemon" && step.status === "pass",
    );

    const installedSkillScript = path.join(
      repo,
      ".agents/skills/opencanon/scripts/opencanon.ts",
    );
    run(
      commands,
      "bun",
      [installedSkillScript, "context", "--files", "src/company.ts"],
      repo,
    );
    run(commands, "bun", [installedSkillScript, "validate", "--project"], repo);
    run(
      commands,
      "bun",
      [installedSkillScript, "update", "check", "--manifest", manifest],
      repo,
    );
    run(
      commands,
      "bun",
      [
        installedSkillScript,
        "update",
        "apply",
        "--manifest",
        manifest,
        "--dry-run",
      ],
      repo,
    );
    if (daemonStarted)
      run(commands, "bun", [installedSkillScript, "daemon", "status"], repo);
    if (daemonStarted)
      run(commands, "bun", [installedSkillScript, "daemon", "stop"], repo);
    daemonStarted = false;

    const badManifest = writeBadChecksumManifest(root, manifest);
    const rejected = runExpectedFailure(
      commands,
      "bun",
      [installedSkillScript, "update", "apply", "--manifest", badManifest],
      repo,
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

    run(
      commands,
      "bun",
      [installedSkillScript, "update", "apply", "--manifest", manifest],
      repo,
    );
    run(commands, "bun", [installedSkillScript, "daemon", "check"], repo);
    if (!options.noDaemon) {
      run(commands, "bun", [installedSkillScript, "daemon", "start"], repo);
      daemonStarted = true;
      run(commands, "bun", [installedSkillScript, "daemon", "status"], repo);
      run(commands, "bun", [installedSkillScript, "daemon", "stop"], repo);
      daemonStarted = false;
    }
    run(commands, "bun", [installedSkillScript, "doctor"], repo);

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
    if (daemonStarted) {
      const installedSkillScript = path.join(
        repo,
        ".agents/skills/opencanon/scripts/opencanon.ts",
      );
      spawnSync("bun", [installedSkillScript, "daemon", "stop"], {
        cwd: repo,
        encoding: "utf8",
      });
    }
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

function writeBadChecksumManifest(root: string, manifest: string): string {
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    engine: Record<string, { sha256: string; url: string }>;
  };
  const target = currentEngineTarget();
  const asset = parsed.engine[target];
  if (!asset)
    throw new Error(`Manifest has no asset for current target ${target}.`);
  const assetSource = path.resolve(path.dirname(manifest), asset.url);
  const realHash = createHash("sha256")
    .update(readFileSync(assetSource))
    .digest("hex");
  asset.url = assetSource;
  asset.sha256 = realHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  const badManifest = path.join(root, "bad-manifest.json");
  writeFileSync(badManifest, `${JSON.stringify(parsed, null, 2)}\n`);
  return badManifest;
}

function run(
  commands: CommandResult[],
  command: string,
  args: string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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

function runExpectedFailure(
  commands: CommandResult[],
  command: string,
  args: string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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
  const options: RehearsalOptions = { keep: false, noDaemon: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--manifest")
      options.manifest = requiredValue(args, ++index, arg);
    else if (arg === "--no-daemon") options.noDaemon = true;
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
  bun scripts/rehearse-opencanon-install.ts [options]

Options:
  --manifest <path>  Use an existing release manifest. Default: generate one from packages/engine/binaries.
  --no-daemon        Skip daemon startup during setup.
  --keep             Keep the rehearsal directory.
`);
}

if (import.meta.main) {
  try {
    if (!existsSync(sourceSkillScript))
      throw new Error(`Missing skill script: ${sourceSkillScript}`);
    const result = runOpenCanonInstallRehearsal(
      parseOptions(Bun.argv.slice(2)),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
