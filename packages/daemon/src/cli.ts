import { cac } from "cac";
import { isLoopbackHost } from "./auth.ts";
import { startOpenCanonDaemon, checkDaemonPrerequisites } from "./server.ts";
import {
  inspectAllDaemons,
  inspectProjectDaemon,
  openDaemonUrl,
  readDaemonRegistryDiagnostics,
  renderDaemonListMarkdown,
  renderDaemonStatusMarkdown,
  startSupervisedDaemon,
  stopProjectDaemon,
} from "./supervisor.ts";

const DaemonCliOptionFlag = {
  AllowRemote: "--allow-remote",
} as const;

const BindAllHost = {
  Ipv4: "0.0.0.0",
  Ipv6: "::",
} as const;

export async function runDaemonCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "start", ...rest] = args;
  if (command === "start") {
    await runStartCommand(rest, cwd);
    return;
  }
  if (command === "serve") {
    await runServeCommand(rest, cwd);
    return;
  }
  if (command === "status") {
    await runStatusCommand(rest, cwd);
    return;
  }
  if (command === "list") {
    await runListCommand(rest);
    return;
  }
  if (command === "stop") {
    await runStopCommand(rest, cwd);
    return;
  }
  if (command === "open") {
    await runOpenCommand(rest, cwd);
    return;
  }
  if (command === "check") {
    console.log(await checkDaemonPrerequisites());
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printDaemonHelp();
    return;
  }
  throw new Error(`Unknown daemon command: ${command}`);
}

export async function runDevCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  await runServeCommand(args, cwd);
}

async function runStartCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon daemon start");
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option("--no-ui", "Do not serve the built UI.");
  cli.option("--foreground", "Run in the current process instead of the global supervisor.");
  cli.option(DaemonCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }

  if (options.foreground) {
    await runServeCommand(args.filter((arg) => arg !== "--foreground"), cwd);
    return;
  }

  const result = await startSupervisedDaemon({
    cwd,
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeDaemonPort(options.port),
    serveUi: options.ui !== false,
    allowRemote: options.allowRemote === true,
  });
  console.log(`# OpenCanon Daemon`);
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`Root: ${result.entry.rootDir}`);
  console.log(`URL: ${result.entry.url}`);
  console.log(`PID: ${result.entry.pid}`);
  console.log(`Log: ${result.entry.logPath}`);
}

async function runServeCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon daemon serve");
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option("--no-ui", "Do not serve the built UI.");
  cli.option(DaemonCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }

  const server = await startOpenCanonDaemon({
    cwd,
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeDaemonPort(options.port),
    serveUi: options.ui !== false,
    allowRemote: options.allowRemote === true,
  });
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(`OpenCanon daemon listening at ${server.url}`);
  await new Promise(() => undefined);
}

async function runStatusCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon daemon status");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }
  console.log(renderDaemonStatusMarkdown(await inspectProjectDaemon(cwd), cwd));
}

async function runListCommand(args: string[]): Promise<void> {
  const cli = cac("opencanon daemon list");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }
  const diagnostics = readDaemonRegistryDiagnostics();
  console.log(renderDaemonListMarkdown(await inspectAllDaemons(), diagnostics));
}

async function runStopCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon daemon stop");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }
  const result = await stopProjectDaemon(cwd);
  console.log(`# OpenCanon Daemon`);
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`Root: ${result.rootDir}`);
  console.log(`Message: ${result.message}`);
}

async function runOpenCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon daemon open");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  if (options.help || options.h) {
    printDaemonHelp();
    return;
  }
  const inspection = await inspectProjectDaemon(cwd);
  if (!inspection || inspection.status !== "running") {
    console.log(renderDaemonStatusMarkdown(inspection, cwd));
    return;
  }
  const url = daemonOpenUrl(inspection.entry);
  openDaemonUrl(url);
  console.log(url);
}

export function normalizeDaemonPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port: ${String(value)}`);
    process.exit(1);
  }
  return port;
}

function daemonOpenUrl(entry: { url: string; host: string; authToken: string }): string {
  const url = new URL(entry.url);
  if (entry.host === BindAllHost.Ipv4) url.hostname = "127.0.0.1";
  if (entry.host === BindAllHost.Ipv6) url.hostname = "[::1]";
  if (isLoopbackHost(entry.host)) return url.href;
  url.searchParams.set("token", entry.authToken);
  return url.href;
}

function printDaemonHelp(): void {
  console.log(`Usage:
  bun run opencanon daemon start --port 4767
  bun run opencanon daemon start --foreground
  bun run opencanon daemon start --host 0.0.0.0 ${DaemonCliOptionFlag.AllowRemote}
  bun run opencanon daemon status
  bun run opencanon daemon list
  bun run opencanon daemon stop
  bun run opencanon daemon open
  bun run opencanon daemon check
  bun run opencanon dev

Commands:
  start   Start this project's daemon in the global supervisor.
  serve   Run this project's daemon in the current process.
  status  Show this project's daemon status.
  list    List all globally registered project daemons.
  stop    Stop this project's daemon.
  open    Open this project's daemon UI.
  check   Verify pinned Bun and engine prerequisites.
`);
}
