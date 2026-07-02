import { cac } from "cac";
import { DiagnosticSeverity, Format, formatFeedbackResult } from "@opencanon/core";
import type { FeedbackDedupeScope, FeedbackHost, FeedbackResult } from "@opencanon/core";
import {
  claudeHookConfig,
  codexHookConfig,
  HookInstallHost,
  HookInstallScope,
  installHook,
  openCodePluginSource,
  renderHookInstallResult,
} from "@opencanon/core";
import {
  fail,
  getChangedFiles,
  createPaths,
  matchesProjectFileScope,
  resolveRootDir,
  splitList,
  toRepoRelativePath,
  unique,
} from "@opencanon/core";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";

export async function runFeedbackCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const cli = cac("opencanon feedback");
  cli.option("-h, --help", "Show help.");
  cli.option("--changed", "Validate changed Git files.");
  cli.option("--files <path>", "Validate file paths.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dedupe-scope <scope>", "Dedupe repeated findings: off, turn, or session.");
  cli.option("--strict-warnings", "Exit nonzero when warnings are present.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "changed", "files", "format", "dedupeScope", "strictWarnings"]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printFeedbackHelp();
    return;
  }

  let files = unique([...stringValues(options.files), ...parsed.args.map(String)].map((file) => toRepoRelativePath(rootDir, file, cwd)));
  if (booleanOption(options.changed)) {
    const changed = getChangedFiles(rootDir);
    if (!changed.gitRoot) fail(changed.diagnostics.join("\n"));
    files = unique([...files, ...changed.files.filter((file) => matchesProjectFileScope(paths, file))]);
  }

  if (files.length === 0) {
    printFeedbackHelp();
    process.exit(1);
  }

  const result = await withRuntimeClient(cwd, (client) =>
    client.post<FeedbackResult>(RuntimeApiRoute.Feedback, {
      files,
      host: "manual",
      dedupeScope: dedupeScopeOption(options.dedupeScope),
    }),
  );
  const format = formatOption(options.format);
  console.log(formatFeedbackResult(result, format, { emptyMessage: true }));
  process.exit(feedbackExitCode(result, booleanOption(options.strictWarnings)));
}

function feedbackExitCode(
  result: FeedbackResult,
  strictWarnings: boolean,
): number {
  if (result.diagnostics.length > 0) return 1;
  if (result.findings.some((finding) => finding.severity === DiagnosticSeverity.Error)) return 1;
  if (strictWarnings && result.findings.some((finding) => finding.severity === DiagnosticSeverity.Warning)) return 1;
  return 0;
}

export async function runHookCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command, ...rest] = args;

  if (!command || command === "-h" || command === "--help") {
    printHookHelp();
    return;
  }

  if (command === "config") {
    printHookConfig(rest);
    return;
  }

  if (command === "install") {
    runHookInstall(rest, cwd);
    return;
  }

  const host = hookHostOption(command);
  const payload = parseHookPayload(await readStdin());
  const { response } = await withRuntimeClient(cwd, (client) => client.post<{ response: string }>(RuntimeApiRoute.HookFeedback, { host, payload }));
  if (response) console.log(response);
}

function printHookConfig(args: string[]): void {
  const [host] = args;
  if (!host || host === "-h" || host === "--help") {
    console.log(`Usage:
  opencanon hook config codex
  opencanon hook config claude
  opencanon hook config opencode
`);
    return;
  }

  if (host === HookInstallHost.Codex) {
    const config = codexHookConfig();
    console.log(`# Enable Codex hooks in ~/.codex/config.toml or <repo>/.codex/config.toml:

[features]
codex_hooks = true

# Add this to ~/.codex/hooks.json or <repo>/.codex/hooks.json:

${JSON.stringify(
  {
    hooks: {
      [config.event]: [
        {
          matcher: config.matcher,
          hooks: [
            config.hook,
          ],
        },
      ],
    },
  },
  null,
  2,
)}`);
    return;
  }

  if (host === HookInstallHost.Claude) {
    const config = claudeHookConfig();
    console.log(`# Add this to .claude/settings.json or .claude/settings.local.json:

${JSON.stringify(
  {
    hooks: {
      [config.event]: [
        {
          matcher: config.matcher,
          hooks: [
            config.hook,
          ],
        },
      ],
    },
  },
  null,
  2,
)}`);
    return;
  }

  if (host === HookInstallHost.OpenCode) {
    console.log(`# OpenCode discovers project skills from .agents/skills/ and loads project plugins from .opencode/plugins/.
#
# Create .opencode/plugins/opencanon.ts:

${openCodePluginSource()}`);
    return;
  }

  fail(`Unknown hook config host: ${host}`);
}

function runHookInstall(args: string[], cwd: string): void {
  const rootDir = resolveRootDir(cwd);
  const cli = cac("opencanon hook install");
  cli.option("-h, --help", "Show help.");
  cli.option("--all", "Install all supported hook hosts.");
  cli.option("--local", "Install project-local hook config. Default.");
  cli.option("--global", "Install user-global hook config.");
  cli.option("--dry-run", "Show files that would change without writing.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "all", "local", "global", "dryRun", "format"]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printHookInstallHelp();
    return;
  }

  const scope = hookInstallScope(options);
  const hosts = hookInstallHosts(parsed.args.map(String), booleanOption(options.all));
  const results = hosts.map((host) =>
    installHook({
      rootDir,
      host,
      scope,
      dryRun: booleanOption(options.dryRun),
    }),
  );

  const format = formatOption(options.format);
  if (format === Format.Json) console.log(JSON.stringify(results, null, 2));
  else console.log(results.map(renderHookInstallResult).join("\n\n"));
  if (results.some((result) => result.diagnostics.length > 0)) process.exit(1);
}

function hookHostOption(value: string): FeedbackHost {
  if (value === HookInstallHost.Codex || value === HookInstallHost.Claude || value === HookInstallHost.OpenCode) return value;
  fail(`Unknown hook host: ${value}`);
}

function hookInstallHosts(values: string[], all: boolean): HookInstallHost[] {
  if (all || values.includes("all")) return [HookInstallHost.Codex, HookInstallHost.Claude, HookInstallHost.OpenCode];
  if (values.length === 0) fail("Missing hook host. Use codex, claude, opencode, or --all.");
  return values.map((value) => {
    if (value === HookInstallHost.Codex || value === HookInstallHost.Claude || value === HookInstallHost.OpenCode) return value;
    fail(`Unknown hook host: ${value}`);
  });
}

function hookInstallScope(options: Record<string, unknown>): HookInstallScope {
  const local = booleanOption(options.local);
  const global = booleanOption(options.global);
  if (local && global) fail("Use either --local or --global, not both.");
  return global ? HookInstallScope.Global : HookInstallScope.Project;
}

function dedupeScopeOption(value: unknown): FeedbackDedupeScope {
  if (value === undefined || value === false) return "off";
  const scope = stringValues(value).flatMap(splitList)[0] ?? "off";
  if (scope === "off" || scope === "turn" || scope === "session") return scope;
  fail(`Unknown dedupe scope: ${scope}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseHookPayload(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printFeedbackHelp(): void {
  console.log(`Usage:
  opencanon feedback --files <paths...>
  opencanon feedback --changed

Options:
  --format markdown|json       Output format. Default: markdown.
  --files <paths...>           Validate files and render concise agent feedback.
  --changed                    Validate changed Git files.
  --strict-warnings            Exit nonzero when warnings are present.
  --dedupe-scope off|turn|session
                                Suppress repeated findings for hook-style feedback. Default: off.
`);
}

function printHookHelp(): void {
  console.log(`Usage:
  opencanon hook codex < hook-payload.json
  opencanon hook claude < hook-payload.json
  opencanon hook opencode < hook-payload.json
  opencanon hook config codex
  opencanon hook install codex

Hosts:
  codex     PostToolUse JSON stdin/stdout for Codex hooks.
  claude    PostToolUse JSON stdin/stdout for Claude Code hooks.
  opencode  JSON bridge used by the OpenCode plugin adapter.
`);
}

function printHookInstallHelp(): void {
  console.log(`Usage:
  opencanon hook install codex
  opencanon hook install claude
  opencanon hook install opencode
  opencanon hook install --all

Options:
  --local      Install project-local config. Default.
  --global     Install user-global config.
  --dry-run    Show files that would change without writing.
  --format markdown|json
`);
}
