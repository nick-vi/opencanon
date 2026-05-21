import { createValidatorFactory } from "@opencanon/core";
import type { Finding } from "@opencanon/core";
import { manualFix, optionSummary } from "../shared.ts";
import type { TauriCommandParityOptions } from "../shared.ts";

export const tauriCommandParity = createValidatorFactory<TauriCommandParityOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.frontend,
  analysis: options.rust,
  severity: options.severity,
  scope: "project",
  decisionIds: options.decisionIds,
  docs: options.docs,
  summary: optionSummary(options, "Frontend Tauri invoke/listen calls must match Rust command and event declarations."),
  validate({ ctx }) {
    const rustFiles = ctx.projectFiles(options.rust);
    const rustCommands = new Set(rustFiles.flatMap((file) => rustCommandNames(file.text)));
    const registeredCommands = new Set(rustFiles.flatMap((file) => tauriHandlerNames(file.text)));
    const rustEvents = new Set(rustFiles.flatMap((file) => emittedEventNames(file.text)));
    const invokeFunctions = options.invokeFunctions ?? ["invoke"];
    const listenFunctions = options.listenFunctions ?? ["listen"];
    const findings: Finding[] = [];

    for (const file of ctx.targetFiles) {
      for (const invoke of frontendStringCalls(file.text, invokeFunctions)) {
        if (!rustCommands.has(invoke.value)) {
          findings.push(
            file.report({
              line: invoke.line,
              message: `${options.message} Missing Rust #[tauri::command] function for ${invoke.name}("${invoke.value}").`.trim(),
              fix: options.fix ?? manualFix("Add the Rust Tauri command or update the frontend invoke name."),
              docs: options.docs,
            }),
          );
          continue;
        }
        if (options.checkHandlerRegistration && registeredCommands.size > 0 && !registeredCommands.has(invoke.value)) {
          findings.push(
            file.report({
              line: invoke.line,
              message: `${options.message} Command "${invoke.value}" is not registered in generate_handler![...].`.trim(),
              fix: options.fix ?? manualFix("Register the Rust command in the Tauri handler list."),
              docs: options.docs,
            }),
          );
        }
      }

      if (!options.checkEvents) continue;
      for (const listen of frontendStringCalls(file.text, listenFunctions)) {
        if (rustEvents.has(listen.value)) continue;
        findings.push(
          file.report({
            line: listen.line,
            message: `${options.message} Missing Rust emit for ${listen.name}("${listen.value}").`.trim(),
            fix: options.fix ?? manualFix("Add a matching Rust emit call or update the frontend event name."),
            docs: options.docs,
          }),
        );
      }
    }

    return findings;
  },
}));

function frontendStringCalls(source: string, names: string[]): Array<{ name: string; value: string; line: number }> {
  const escapedNames = names.map((name) => escapeRegExp(name)).join("|");
  if (!escapedNames) return [];
  return [...source.matchAll(new RegExp(`\\b(${escapedNames})\\s*(?:<[^>]*>)?\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g"))].map((match) => ({
    name: match[1] ?? "",
    value: match[2] ?? "",
    line: lineNumber(source, match.index ?? 0),
  }));
}

function rustCommandNames(source: string): string[] {
  return [...source.matchAll(/#\s*\[\s*tauri::command[\s\S]*?\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]);
}

function tauriHandlerNames(source: string): string[] {
  return [...source.matchAll(/generate_handler!\s*(?:\[\s*([\s\S]*?)\s*\]|\{\s*([\s\S]*?)\s*\})/g)].flatMap((match) =>
    (match[1] ?? match[2] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^.*::/, "")),
  );
}

function emittedEventNames(source: string): string[] {
  return [...source.matchAll(/\bemit(?:_all|_to)?\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
