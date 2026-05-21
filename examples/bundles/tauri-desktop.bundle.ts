export default {
  id: "tauri-desktop",
  description: "Adds Tauri desktop validators for typed IPC gateways, command parity, local-first capabilities, and Rust command hygiene.",
  topics: ["tauri", "ipc", "security", "runtime-hygiene"],
  validators: [
    "tauri-command-parity",
    "tauri-ipc-no-raw-invoke-outside-gateway",
    "tauri-ipc-no-raw-listen-outside-gateway",
    "tauri-ipc-command-names-centralized",
    "tauri-ipc-event-names-centralized",
    "tauri-capabilities-no-wildcards",
    "tauri-csp-locked",
    "tauri-command-no-unwrap-panic",
    "tauri-async-command-no-blocking-fs",
  ],
  options: {
    frontendGlobs: {
      type: "string[]",
      default: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      description: "Frontend TypeScript files that may call or wrap Tauri IPC.",
    },
    rustGlobs: {
      type: "string[]",
      default: ["src-tauri/src/**/*.rs", "packages/*/src-tauri/src/**/*.rs"],
      description: "Rust Tauri source files that declare commands and emit events.",
    },
    ipcGlobs: {
      type: "string[]",
      default: ["src/ipc/**/*.ts", "packages/*/src/ipc/**/*.ts"],
      description: "Typed IPC wrapper files checked for centralized command and event names.",
    },
    invokeGateways: {
      type: "string[]",
      default: ["src/lib/tauri.ts", "src/ipc/commands/core.ts", "packages/*/src/lib/tauri.ts", "packages/*/src/ipc/commands/core.ts"],
      description: "Files allowed to call the low-level Tauri invoke API.",
    },
    listenGateways: {
      type: "string[]",
      default: ["src/lib/tauri.ts", "src/ipc/events.ts", "packages/*/src/lib/tauri.ts", "packages/*/src/ipc/events.ts"],
      description: "Files allowed to call the low-level Tauri listen API.",
    },
    namesFiles: {
      type: "string[]",
      default: ["src/ipc/names.ts", "packages/*/src/ipc/names.ts"],
      description: "Files allowed to define frontend command and event string literals.",
    },
    invokeFunctions: {
      type: "string[]",
      default: ["invoke"],
      description: "Frontend function names treated as Tauri command invocations.",
    },
    listenFunctions: {
      type: "string[]",
      default: ["listen"],
      description: "Frontend function names treated as Tauri event subscriptions.",
    },
    capabilitiesGlobs: {
      type: "string[]",
      default: ["src-tauri/capabilities/*.json", "packages/*/src-tauri/capabilities/*.json"],
      description: "Tauri capability JSON files checked for broad permissions.",
    },
    tauriConfigGlobs: {
      type: "string[]",
      default: ["src-tauri/tauri.conf.json", "packages/*/src-tauri/tauri.conf.json"],
      description: "Tauri config files checked for local-first CSP settings.",
    },
  },
  docs: [
    {
      path: "docs/opencanon/canon/tauri-desktop.md",
      heading: "Tauri Desktop Boundaries",
      body: [
        "Tauri desktop code keeps low-level IPC, command names, permissions, and command errors explicit.",
        "",
        "Rules:",
        "",
        "- Route frontend command calls through typed IPC gateway files.",
        "- Route frontend event subscriptions through typed event gateway files.",
        "- Keep command and event string names centralized.",
        "- Keep frontend command and event names in parity with Rust command handlers and emitted events.",
        "- Avoid broad Tauri permissions and unsafe CSP directives.",
        "- Propagate Tauri command errors instead of panicking in runtime handlers.",
      ].join("\n"),
    },
  ],
  decisions: [
    {
      id: "tauri-desktop-boundaries-current",
      date: "2026-05-22",
      status: "current",
      title: "Tauri desktop IPC and runtime boundaries are explicit",
      topics: ["tauri", "ipc", "security", "runtime-hygiene"],
      applies: ["{{frontendGlobs}}", "{{rustGlobs}}"],
      summary: "Desktop code uses typed IPC gateways, centralized names, narrow Tauri permissions, and non-panicking command handlers.",
      rationale: ["Agents need mechanical checks for cross-language IPC drift and desktop runtime side effects."],
      required: [
        "Use typed IPC gateways instead of low-level Tauri invoke/listen calls in feature code.",
        "Keep command and event string literals centralized.",
        "Keep frontend IPC names in parity with Rust Tauri handlers and emitted events.",
        "Keep Tauri permissions and CSP narrow.",
        "Propagate runtime command errors through typed results.",
      ],
      replaced: [],
      agentPolicy: ["When adding Tauri IPC, update frontend names, typed wrappers, Rust handlers, and registration together."],
      exceptions: [],
      docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
      validatorIds: [
        "tauri-command-parity",
        "tauri-ipc-no-raw-invoke-outside-gateway",
        "tauri-ipc-no-raw-listen-outside-gateway",
        "tauri-ipc-command-names-centralized",
        "tauri-ipc-event-names-centralized",
        "tauri-capabilities-no-wildcards",
        "tauri-csp-locked",
        "tauri-command-no-unwrap-panic",
        "tauri-async-command-no-blocking-fs",
      ],
    },
  ],
  files: [
    {
      path: ".agents/skills/opencanon/validators/tauri-desktop.ts",
      content: `import { defineValidator, tauriCommandParity } from "../index.ts";

const frontendGlobs = "{{frontendGlobs}}".split(",").map((item) => item.trim()).filter(Boolean);
const rustGlobs = "{{rustGlobs}}".split(",").map((item) => item.trim()).filter(Boolean);
const ipcGlobs = "{{ipcGlobs}}".split(",").map((item) => item.trim()).filter(Boolean);
const invokeGateways = new Set("{{invokeGateways}}".split(",").map((item) => item.trim()).filter(Boolean));
const listenGateways = new Set("{{listenGateways}}".split(",").map((item) => item.trim()).filter(Boolean));
const namesFiles = new Set("{{namesFiles}}".split(",").map((item) => item.trim()).filter(Boolean));
const invokeFunctions = "{{invokeFunctions}}".split(",").map((item) => item.trim()).filter(Boolean);
const listenFunctions = "{{listenFunctions}}".split(",").map((item) => item.trim()).filter(Boolean);

function lineNumber(source: string, index = 0): number {
  return source.slice(0, index).split(/\\r?\\n/).length;
}

function inSetOrGlob(path: string, patterns: Set<string>): boolean {
  for (const pattern of patterns) {
    if (pattern === path) return true;
    const regex = new RegExp("^" + pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*\\*/g, ".*").replace(/\\*/g, "[^/]*") + "$");
    if (regex.test(path)) return true;
  }
  return false;
}

function commandBlocks(source: string): string[] {
  return source.split(/(?=#\\s*\\[\\s*tauri::command)/g);
}

export const tauriCommandParityValidator = tauriCommandParity({
  id: "tauri-command-parity",
  topics: ["tauri", "ipc"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  frontend: frontendGlobs,
  rust: rustGlobs,
  invokeFunctions,
  listenFunctions,
  checkEvents: true,
  checkHandlerRegistration: true,
  severity: "error",
  message: "Tauri frontend calls must resolve to Rust declarations.",
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
});

export const noRawInvokeOutsideGateway = defineValidator({
  id: "tauri-ipc-no-raw-invoke-outside-gateway",
  topics: ["tauri", "ipc", "frontend"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: frontendGlobs,
  severity: "error",
  scope: "file",
  facts: ["calls", "imports"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Only configured IPC gateway files may call low-level Tauri invoke.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      if (inSetOrGlob(file.path, invokeGateways)) return [];
      const match = file.text.match(/\\binvoke\\s*(?:<[^>]*>)?\\s*\\(/);
      if (!match) return [];
      return [file.report({
        line: lineNumber(file.text, match.index),
        message: "Runtime code must use the typed IPC command gateway instead of raw invoke.",
        fix: { safety: "manual", description: "Add or use a typed command wrapper in the configured IPC gateway." },
        docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
      })];
    });
  },
});

export const noRawListenOutsideGateway = defineValidator({
  id: "tauri-ipc-no-raw-listen-outside-gateway",
  topics: ["tauri", "ipc", "frontend"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: frontendGlobs,
  severity: "error",
  scope: "file",
  facts: ["calls", "imports"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Only configured IPC event gateway files may call low-level Tauri listen.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      if (inSetOrGlob(file.path, listenGateways)) return [];
      const match = file.text.match(/\\blisten\\s*(?:<[^>]*>)?\\s*\\(/);
      if (!match) return [];
      return [file.report({
        line: lineNumber(file.text, match.index),
        message: "Runtime code must use the typed IPC event gateway instead of raw listen.",
        fix: { safety: "manual", description: "Add or use a typed event wrapper in the configured IPC gateway." },
        docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
      })];
    });
  },
});

export const commandNamesCentralized = defineValidator({
  id: "tauri-ipc-command-names-centralized",
  topics: ["tauri", "ipc", "frontend"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: ipcGlobs,
  severity: "error",
  scope: "file",
  facts: ["literals"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Command string literals live in configured IPC names files.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      if (inSetOrGlob(file.path, namesFiles)) return [];
      const match = file.text.match(/command(?:<[^>]+>)?\\(\\s*["'\`][a-zA-Z0-9_|:-]+["'\`]/);
      if (!match) return [];
      return [file.report({
        line: lineNumber(file.text, match.index),
        message: "Command literals must be referenced through centralized IPC names.",
        fix: { safety: "manual", description: "Move the command literal to the configured names file." },
        docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
      })];
    });
  },
});

export const eventNamesCentralized = defineValidator({
  id: "tauri-ipc-event-names-centralized",
  topics: ["tauri", "ipc", "frontend"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: ipcGlobs,
  severity: "error",
  scope: "file",
  facts: ["literals"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Event string literals live in configured IPC names files.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      if (inSetOrGlob(file.path, namesFiles)) return [];
      const match = file.text.match(/event(?:<[^>]+>)?\\(\\s*["'\`][a-zA-Z0-9_-]+["'\`]/);
      if (!match) return [];
      return [file.report({
        line: lineNumber(file.text, match.index),
        message: "Event literals must be referenced through centralized IPC names.",
        fix: { safety: "manual", description: "Move the event literal to the configured names file." },
        docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
      })];
    });
  },
});

export const capabilitiesNoWildcards = defineValidator({
  id: "tauri-capabilities-no-wildcards",
  topics: ["tauri", "security"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: "{{capabilitiesGlobs}}".split(",").map((item) => item.trim()).filter(Boolean),
  severity: "error",
  scope: "file",
  facts: ["literals"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Tauri capabilities avoid wildcard and broad process, shell, fs, and HTTP permissions.",
  validate({ ctx }) {
    const denied = /^(?:fs|shell|http):|^[a-z-]+:\\*$|^[a-z-]+:allow-.*(?:all|execute)/i;
    return ctx.targetFiles.flatMap((file) => {
      const data = ctx.json(file.path) as { permissions?: unknown } | null;
      const permissions = Array.isArray(data?.permissions) ? data.permissions : [];
      return permissions.flatMap((permission) => {
        if (typeof permission !== "string" || !denied.test(permission)) return [];
        return [file.report({
          line: 1,
          message: \`Tauri permission \${permission} is too broad for a local-first desktop surface.\`,
          fix: { safety: "manual", description: "Replace broad capability permissions with explicit allowlisted permissions." },
          docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
        })];
      });
    });
  },
});

export const cspLocked = defineValidator({
  id: "tauri-csp-locked",
  topics: ["tauri", "security"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: "{{tauriConfigGlobs}}".split(",").map((item) => item.trim()).filter(Boolean),
  severity: "error",
  scope: "file",
  facts: ["literals"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Tauri CSP stays local-first and avoids unsafe script execution.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      const data = ctx.json(file.path) as { app?: { security?: { csp?: string } } } | null;
      const csp = data?.app?.security?.csp ?? "";
      const findings = [];
      if (!csp.includes("default-src 'self'")) {
        findings.push(file.report({ line: 1, message: "Tauri CSP must include default-src 'self'.", docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"] }));
      }
      if (/\\bscript-src\\b[^;]*'unsafe-(?:eval|inline)'/.test(csp)) {
        findings.push(file.report({ line: 1, message: "Tauri CSP must not allow unsafe script execution.", fix: { safety: "manual", description: "Remove unsafe script directives." }, docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"] }));
      }
      const connect = csp.match(/\\bconnect-src\\b([^;]*)/)?.[1] ?? "";
      if (/https?:\\/\\//.test(connect) && !/http:\\/\\/localhost:1420/.test(connect)) {
        findings.push(file.report({ line: 1, message: "Tauri CSP connect-src must not allow remote HTTP(S) origins by default.", fix: { safety: "manual", description: "Keep runtime network surfaces explicit and local." }, docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"] }));
      }
      return findings;
    });
  },
});

export const commandNoUnwrapPanic = defineValidator({
  id: "tauri-command-no-unwrap-panic",
  topics: ["tauri", "rust", "error-handling"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: rustGlobs,
  severity: "error",
  scope: "file",
  facts: ["calls"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Tauri command handlers propagate errors instead of panicking.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      if (!/#\\s*\\[\\s*tauri::command/.test(file.text)) return [];
      return [...file.text.matchAll(/\\b(?:unwrap|expect|panic)!\\s*\\(|\\.(?:unwrap|expect)\\s*\\(/g)].map((match) =>
        file.report({
          line: lineNumber(file.text, match.index),
          message: "Tauri command code must not unwrap, expect, or panic in runtime paths.",
          fix: { safety: "manual", description: "Propagate errors through the command result type." },
          docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
        }),
      );
    });
  },
});

export const asyncCommandNoBlockingFs = defineValidator({
  id: "tauri-async-command-no-blocking-fs",
  topics: ["tauri", "rust", "performance"],
  decisionIds: ["tauri-desktop-boundaries-current"],
  applies: rustGlobs,
  severity: "warning",
  scope: "file",
  facts: ["calls"],
  docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
  summary: "Async Tauri commands avoid blocking std::fs operations.",
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) => {
      const findings = [];
      for (const block of commandBlocks(file.text)) {
        if (!/\\b(?:pub\\s+)?async\\s+fn\\b/.test(block)) continue;
        const match = block.match(/\\b(?:std::fs|fs)::(?:read|write|copy|remove|create|rename|metadata|File)\\b/);
        if (!match) continue;
        findings.push(file.report({
          line: lineNumber(file.text, file.text.indexOf(block) + (match.index ?? 0)),
          message: "Async Tauri commands must not use blocking filesystem operations in runtime paths.",
          fix: { safety: "manual", description: "Use async filesystem APIs or move blocking work into spawn_blocking." },
          docs: ["docs/opencanon/canon/tauri-desktop.md#tauri-desktop-boundaries"],
        }));
      }
      return findings;
    });
  },
});

export default [
  tauriCommandParityValidator,
  noRawInvokeOutsideGateway,
  noRawListenOutsideGateway,
  commandNamesCentralized,
  eventNamesCentralized,
  capabilitiesNoWildcards,
  cspLocked,
  commandNoUnwrapPanic,
  asyncCommandNoBlockingFs,
];
`,
    },
  ],
  impactSurfaces: [],
  externalTools: {},
};
