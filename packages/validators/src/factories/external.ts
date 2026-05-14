import { spawnSync } from "node:child_process";
import { createValidatorFactory } from "@opencanon/core";
import { externalInvocation, isMissingCommandError, manualFix, optionSummary, parseExternalDiagnostics, truncate } from "../shared.ts";
import type { ExternalCommandOptions, ExternalDiagnosticsOptions } from "../shared.ts";

export const externalCommand = createValidatorFactory<ExternalCommandOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `External command must pass: ${[options.command, ...(options.args ?? [])].join(" ")}`),
  validate({ ctx, runtime }) {
    const invocation = externalInvocation(options, ctx, runtime);
    if (!invocation.ok) {
      return [
        ctx.report({
          file: options.reportFile ?? "<external-command>",
          line: options.reportLine ?? 1,
          message: `${options.message}\n${invocation.message}`,
          fix: options.fix,
          docs: options.docs,
        }),
      ];
    }
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      encoding: "utf8",
      env: process.env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
    });

    if (result.error && options.optional && isMissingCommandError(result.error)) {
      if (!options.missingMessage) return [];
      return [
        ctx.report({
          file: options.reportFile ?? "<external-command>",
          line: options.reportLine ?? 1,
          message: options.missingMessage,
          fix: options.fix ?? manualFix(`Install or configure external tool ${options.command}.`),
          docs: options.docs,
        }),
      ];
    }

    const successCodes = new Set(options.successCodes ?? [0]);
    if (typeof result.status === "number" && successCodes.has(result.status)) return [];
    const output = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim();

    return [
      ctx.report({
        file: options.reportFile ?? "<external-command>",
        line: options.reportLine ?? 1,
        message: output ? `${options.message}\n${truncate(output, 4000)}` : options.message,
        fix: options.fix,
        docs: options.docs,
      }),
    ];
  },
}));

export const externalDiagnostics = createValidatorFactory<ExternalDiagnosticsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  facts: ["diagnostics"],
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `External diagnostics must pass: ${[options.command, ...(options.args ?? [])].join(" ")}`),
  validate({ ctx, runtime }) {
    const invocation = externalInvocation(options, ctx, runtime);
    if (!invocation.ok) {
      return [
        ctx.report({
          file: options.reportFile ?? "<external-diagnostics>",
          line: options.reportLine ?? 1,
          message: `${options.message}\n${invocation.message}`,
          fix: options.fix,
          docs: options.docs,
        }),
      ];
    }
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      encoding: "utf8",
      env: process.env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
    });

    if (result.error) {
      if (options.optional && isMissingCommandError(result.error)) {
        if (!options.missingMessage) return [];
        return [
          ctx.report({
            file: options.reportFile ?? "<external-diagnostics>",
            line: options.reportLine ?? 1,
            message: options.missingMessage,
            fix: options.fix ?? manualFix(`Install or configure external tool ${options.command}.`),
            docs: options.docs,
          }),
        ];
      }
      return [
        ctx.report({
          file: options.reportFile ?? "<external-diagnostics>",
          line: options.reportLine ?? 1,
          message: `${options.message}\n${result.error.message}`,
          fix: options.fix,
          docs: options.docs,
        }),
      ];
    }

    const successCodes = new Set(options.successCodes ?? [0]);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const diagnostics = parseExternalDiagnostics(output, options);
    if (diagnostics.length === 0 && typeof result.status === "number" && successCodes.has(result.status)) return [];
    if (diagnostics.length === 0) {
      return [
        ctx.report({
          file: options.reportFile ?? "<external-diagnostics>",
          line: options.reportLine ?? 1,
          message: output ? `${options.message}\n${truncate(output, 4000)}` : options.message,
          fix: options.fix,
          docs: options.docs,
        }),
      ];
    }

    return diagnostics.map((diagnostic) =>
      ctx.report({
        file: diagnostic.file ?? options.reportFile ?? "<external-diagnostics>",
        line: diagnostic.line ?? options.reportLine ?? 1,
        column: diagnostic.column,
        message: diagnostic.code ? `${options.message} ${diagnostic.code}: ${diagnostic.message}` : `${options.message} ${diagnostic.message}`,
        fix: options.fix,
        docs: options.docs,
      }),
    );
  },
}));
