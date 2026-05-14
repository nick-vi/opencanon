import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type HookFileAction = "create" | "update" | "unchanged";

export const HookInstallHost = {
  Codex: "codex",
  Claude: "claude",
  OpenCode: "opencode",
} as const;
export type HookInstallHost = (typeof HookInstallHost)[keyof typeof HookInstallHost];

export const HookInstallScope = {
  Project: "project",
  Global: "global",
} as const;
export type HookInstallScope = (typeof HookInstallScope)[keyof typeof HookInstallScope];

export type HookInstallFileResult = {
  path: string;
  action: HookFileAction;
};

export type HookInstallResult = {
  host: HookInstallHost;
  scope: HookInstallScope;
  dryRun: boolean;
  files: HookInstallFileResult[];
  diagnostics: string[];
};

export type HookInspection = {
  host: HookInstallHost;
  installed: boolean;
  valid: boolean;
  details: string[];
};

const codexMatcher = "Edit|Write|apply_patch";
const claudeMatcher = "Write|Edit|MultiEdit";
const hookTextEncoding = "utf8";

export function installHook(params: { rootDir: string; host: HookInstallHost; scope: HookInstallScope; dryRun: boolean }): HookInstallResult {
  if (params.host === HookInstallHost.Codex) return installCodexHook(params);
  if (params.host === HookInstallHost.Claude) return installClaudeHook(params);
  return installOpenCodeHook(params);
}

export function inspectHookInstallations(rootDir: string, scope: HookInstallScope = HookInstallScope.Project): HookInspection[] {
  return [
    inspectCodexHook(rootDir, scope),
    inspectClaudeHook(rootDir, scope),
    inspectOpenCodeHook(rootDir, scope),
  ];
}

export function renderHookInstallResult(result: HookInstallResult): string {
  const lines: string[] = [];
  lines.push(`# OpenCanon Hook Install`);
  lines.push("");
  lines.push(`Host: ${result.host}`);
  lines.push(`Scope: ${result.scope}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push("");
  for (const file of result.files) lines.push(`- [${file.action}] ${file.path}`);
  for (const diagnostic of result.diagnostics) lines.push(`- error: ${diagnostic}`);
  return lines.join("\n");
}

export function renderHookInspectionMarkdown(inspections: HookInspection[]): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Hook Status");
  lines.push("");
  for (const inspection of inspections) {
    const status = inspection.valid ? "pass" : inspection.installed ? "warn" : "missing";
    lines.push(`- [${status}] ${inspection.host}`);
    for (const detail of inspection.details) lines.push(`  - ${detail}`);
  }
  return lines.join("\n");
}

export function codexHookConfig() {
  return {
    event: "PostToolUse",
    matcher: codexMatcher,
    hook: {
      type: "command",
      command: `bun "$(git rev-parse --show-toplevel)/.agents/skills/opencanon/scripts/opencanon.ts" hook ${HookInstallHost.Codex}`,
      statusMessage: "Running OpenCanon feedback",
    },
  };
}

export function claudeHookConfig() {
  return {
    event: "PostToolUse",
    matcher: claudeMatcher,
    hook: {
      type: "command",
      command: `bun "$CLAUDE_PROJECT_DIR/.agents/skills/opencanon/scripts/opencanon.ts" hook ${HookInstallHost.Claude}`,
      statusMessage: "Running OpenCanon feedback",
    },
  };
}

export function openCodePluginSource(scope: HookInstallScope = "project"): string {
  const importPath =
    scope === HookInstallScope.Global
      ? "../../../.agents/skills/opencanon/scripts/opencode-plugin.ts"
      : "../../.agents/skills/opencanon/scripts/opencode-plugin.ts";
  return `export { OpenCanonPlugin } from "${importPath}";\n`;
}

function installCodexHook(params: { rootDir: string; scope: HookInstallScope; dryRun: boolean }): HookInstallResult {
  const paths = codexPaths(params.rootDir, params.scope);
  const files: HookInstallFileResult[] = [];
  const diagnostics: string[] = [];

  const configToml = updateCodexConfig(readText(paths.configToml));
  files.push(writeIfChanged(paths.configToml, configToml, params.dryRun));

  try {
    const hooksJson = updateHookJson(readJson(paths.hooksJson), codexHookConfig());
    files.push(writeJsonIfChanged(paths.hooksJson, hooksJson, params.dryRun));
  } catch (error) {
    diagnostics.push(`Could not update ${paths.hooksJson}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { host: HookInstallHost.Codex, scope: params.scope, dryRun: params.dryRun, files, diagnostics };
}

function installClaudeHook(params: { rootDir: string; scope: HookInstallScope; dryRun: boolean }): HookInstallResult {
  const settingsJson = claudeSettingsPath(params.rootDir, params.scope);
  const diagnostics: string[] = [];
  const files: HookInstallFileResult[] = [];

  try {
    const settings = updateHookJson(readJson(settingsJson), claudeHookConfig());
    files.push(writeJsonIfChanged(settingsJson, settings, params.dryRun));
  } catch (error) {
    diagnostics.push(`Could not update ${settingsJson}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { host: HookInstallHost.Claude, scope: params.scope, dryRun: params.dryRun, files, diagnostics };
}

function installOpenCodeHook(params: { rootDir: string; scope: HookInstallScope; dryRun: boolean }): HookInstallResult {
  const pluginPath = openCodePluginPath(params.rootDir, params.scope);
  const file = writeIfChanged(pluginPath, openCodePluginSource(params.scope), params.dryRun);
  return { host: HookInstallHost.OpenCode, scope: params.scope, dryRun: params.dryRun, files: [file], diagnostics: [] };
}

function inspectCodexHook(rootDir: string, scope: HookInstallScope): HookInspection {
  const paths = codexPaths(rootDir, scope);
  const details: string[] = [];
  const hasConfig = existsSync(paths.configToml);
  const hasHooks = existsSync(paths.hooksJson);

  if (!hasConfig && !hasHooks) {
    return { host: HookInstallHost.Codex, installed: false, valid: false, details: [`No Codex hook files found for ${scope} scope.`] };
  }

  if (!hasConfig || !codexHooksEnabled(readText(paths.configToml))) details.push("Missing [features] codex_hooks = true.");
  try {
    if (!hasHooks || !hookJsonHas(readJson(paths.hooksJson), codexHookConfig())) details.push(`Missing ${codexHookConfig().matcher} PostToolUse command hook.`);
  } catch (error) {
    details.push(`Could not read Codex hooks JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { host: HookInstallHost.Codex, installed: true, valid: details.length === 0, details: details.length > 0 ? details : ["Codex PostToolUse feedback hook is installed."] };
}

function inspectClaudeHook(rootDir: string, scope: HookInstallScope): HookInspection {
  const settingsPath = claudeSettingsPath(rootDir, scope);
  if (!existsSync(settingsPath)) {
    return { host: HookInstallHost.Claude, installed: false, valid: false, details: [`No Claude settings file found for ${scope} scope.`] };
  }

  try {
    const valid = hookJsonHas(readJson(settingsPath), claudeHookConfig());
    return {
      host: HookInstallHost.Claude,
      installed: true,
      valid,
      details: valid ? ["Claude PostToolUse feedback hook is installed."] : [`Missing ${claudeHookConfig().matcher} PostToolUse command hook.`],
    };
  } catch (error) {
    return { host: HookInstallHost.Claude, installed: true, valid: false, details: [`Could not read Claude settings JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function inspectOpenCodeHook(rootDir: string, scope: HookInstallScope): HookInspection {
  const pluginPath = openCodePluginPath(rootDir, scope);
  if (!existsSync(pluginPath)) {
    return { host: HookInstallHost.OpenCode, installed: false, valid: false, details: [`No OpenCode plugin found for ${scope} scope.`] };
  }
  const valid = readText(pluginPath).includes(".agents/skills/opencanon/scripts/opencode-plugin.ts");
  return {
    host: HookInstallHost.OpenCode,
    installed: true,
    valid,
    details: valid ? ["OpenCode feedback plugin points to .agents/skills/opencanon."] : [`${pluginPath} does not point to the OpenCanon .agents skill plugin.`],
  };
}

function updateHookJson(current: unknown, config: ReturnType<typeof codexHookConfig> | ReturnType<typeof claudeHookConfig>): Record<string, unknown> {
  const root = isRecord(current) ? { ...current } : {};
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  const entries = Array.isArray(hooks[config.event]) ? [...(hooks[config.event] as unknown[])] : [];
  const existing = entries.find((entry) => isRecord(entry) && entry.matcher === config.matcher) as Record<string, unknown> | undefined;

  if (existing) {
    existing.hooks = upsertCommandHook(existing.hooks, config.hook);
  } else {
    entries.push({ matcher: config.matcher, hooks: [config.hook] });
  }

  hooks[config.event] = entries;
  root.hooks = hooks;
  return root;
}

function hookJsonHas(current: unknown, config: ReturnType<typeof codexHookConfig> | ReturnType<typeof claudeHookConfig>): boolean {
  if (!isRecord(current) || !isRecord(current.hooks)) return false;
  const entries = current.hooks[config.event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!isRecord(entry) || entry.matcher !== config.matcher || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => isRecord(hook) && hook.type === config.hook.type && hook.command === config.hook.command);
  });
}

function upsertCommandHook(value: unknown, hook: { type: string; command: string; statusMessage: string }): unknown[] {
  const hooks = Array.isArray(value) ? [...value] : [];
  const existing = hooks.find((item) => isRecord(item) && item.type === hook.type && item.command === hook.command) as Record<string, unknown> | undefined;
  if (existing) {
    existing.statusMessage = hook.statusMessage;
    return hooks;
  }
  return [...hooks, hook];
}

function updateCodexConfig(current: string): string {
  const text = current.trimEnd();
  if (!text) return "[features]\ncodex_hooks = true\n";

  const lines = text.split(/\r?\n/);
  const featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (featuresIndex === -1) return `${text}\n\n[features]\ncodex_hooks = true\n`;

  let sectionEnd = lines.length;
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  for (let index = featuresIndex + 1; index < sectionEnd; index += 1) {
    if (/^\s*codex_hooks\s*=/.test(lines[index])) {
      lines[index] = "codex_hooks = true";
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
  return `${lines.join("\n")}\n`;
}

function codexHooksEnabled(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (featuresIndex === -1) return false;
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index])) return false;
    if (/^\s*codex_hooks\s*=\s*true\s*$/.test(lines[index])) return true;
  }
  return false;
}

function codexPaths(rootDir: string, scope: HookInstallScope): { configToml: string; hooksJson: string } {
  const dir = scope === HookInstallScope.Global ? path.join(homedir(), ".codex") : path.join(rootDir, ".codex");
  return {
    configToml: path.join(dir, "config.toml"),
    hooksJson: path.join(dir, "hooks.json"),
  };
}

function claudeSettingsPath(rootDir: string, scope: HookInstallScope): string {
  const dir = scope === HookInstallScope.Global ? path.join(homedir(), ".claude") : path.join(rootDir, ".claude");
  return path.join(dir, "settings.json");
}

function openCodePluginPath(rootDir: string, scope: HookInstallScope): string {
  const dir = scope === HookInstallScope.Global ? path.join(homedir(), ".config/opencode/plugins") : path.join(rootDir, ".opencode/plugins");
  return path.join(dir, "opencanon.ts");
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, hookTextEncoding)) as unknown;
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, hookTextEncoding) : "";
}

function writeJsonIfChanged(file: string, value: unknown, dryRun: boolean): HookInstallFileResult {
  return writeIfChanged(file, `${JSON.stringify(value, null, 2)}\n`, dryRun);
}

function writeIfChanged(file: string, next: string, dryRun: boolean): HookInstallFileResult {
  const exists = existsSync(file);
  const current = exists ? readFileSync(file, hookTextEncoding) : "";
  if (current === next) return { path: file, action: "unchanged" };
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return { path: file, action: exists ? "update" : "create" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
