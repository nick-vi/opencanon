import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { writeAtomicJsonFileSync } from "./atomic.ts";
import type { ContextPaths } from "./context.ts";
import { relative } from "./core-utils.ts";
import { getGitRoot } from "./git.ts";
import type { CommitGate, CommitGateApprovalScope } from "./validator-types.ts";

const TextEncoding = {
  Utf8: "utf8",
} as const;

const GitArg = {
  Cached: "--cached",
  Directory: "-C",
  NameOnly: "--name-only",
  Others: "--others",
  ExcludeStandard: "--exclude-standard",
} as const;

export type CommitApprovalRecord = {
  id: string;
  gateId: string;
  gateTitle: string;
  gateReason: string;
  validatorId: string;
  approvalScope: CommitGateApprovalScope;
  approvalFingerprint: string;
  changedFiles: string[];
  summary: string;
  approvedAt: string;
  approvedBy: string;
  approvedVia: "cli" | "agent" | "manual";
  configHash: string;
  validatorGraphHash: string;
  decisionIds: string[];
  impactSurfaceIds: string[];
  evidence: CommitGate["evidence"];
};

export type CommitApprovalsFile = {
  version: 1;
  approvals: CommitApprovalRecord[];
};

export type ResolvedCommitGate = CommitGate & {
  status: "unresolved" | "approved";
  approvalId?: string;
};

export type PendingCommitGate = ResolvedCommitGate & {
  status: "unresolved";
  question: string;
  agentAction: "request_user_input";
  agentProtocol: string[];
  preferredToolNames: string[];
  plainChatFallbackAllowed: true;
  fallbackProtocol: string;
  choices: CommitGateApprovalChoice[];
  approveCommand: string;
};

export type CommitGateApprovalChoice = {
  label: "Approve" | "Reject";
  description: string;
};

export type PendingCommitGatesFile = {
  version: 1;
  generatedAt: string;
  context: CommitApprovalContext;
  pending: PendingCommitGate[];
  approved: ResolvedCommitGate[];
  diagnostics: string[];
};

export type CommitApprovalContext = {
  rootDir: string;
  diffFingerprint: string;
  stagedDiffFingerprint: string;
  worktreeDiffFingerprint: string;
  changedFiles: string[];
  stagedFiles: string[];
  worktreeFiles: string[];
  untrackedFiles: string[];
  configHash: string;
  validatorGraphHash: string;
  diagnostics: string[];
};

export function loadCommitApprovalsWithDiagnostics(paths: ContextPaths): { approvals: CommitApprovalsFile; diagnostics: string[] } {
  if (!existsSync(paths.commitApprovalsPath)) return { approvals: { version: 1, approvals: [] }, diagnostics: [] };
  try {
    const value = JSON.parse(readFileSync(paths.commitApprovalsPath, TextEncoding.Utf8)) as Partial<CommitApprovalsFile>;
    const rawApprovals = Array.isArray(value.approvals) ? value.approvals : [];
    const validApprovals = rawApprovals.filter(isCommitApprovalRecord);
    const diagnostics = Array.isArray(value.approvals)
      ? rawApprovals.length === validApprovals.length
        ? []
        : [`Ignored ${rawApprovals.length - validApprovals.length} invalid commit approval record(s) in ${relative(process.cwd(), paths.commitApprovalsPath)}.`]
      : [`Commit approvals file is invalid: approvals must be an array at ${relative(process.cwd(), paths.commitApprovalsPath)}.`];
    return {
      approvals: {
        version: 1,
        approvals: validApprovals,
      },
      diagnostics,
    };
  } catch {
    return {
      approvals: { version: 1, approvals: [] },
      diagnostics: [`Commit approvals file is not valid JSON: ${relative(process.cwd(), paths.commitApprovalsPath)}.`],
    };
  }
}

export function saveCommitApprovals(paths: ContextPaths, approvals: CommitApprovalsFile): void {
  writeAtomicJsonFileSync(paths.commitApprovalsPath, approvals);
}

export function upsertCommitApproval(approvals: CommitApprovalsFile, record: CommitApprovalRecord): CommitApprovalsFile {
  return {
    version: 1,
    approvals: [...approvals.approvals.filter((approval) => !sameCommitApprovalScope(approval, record)), record],
  };
}

export function resolveCommitGates(gates: CommitGate[], approvals: CommitApprovalsFile, context: CommitApprovalContext): ResolvedCommitGate[] {
  return sortCommitGates(gates).map((gate) => {
    const approval = approvals.approvals.find((record) => commitApprovalMatches(record, gate, context));
    if (!approval) return { ...gate, status: "unresolved" };
    return { ...gate, status: "approved", approvalId: approval.id };
  });
}

export function createCommitApprovalRecord(params: {
  gate: CommitGate;
  summary: string;
  approvedBy?: string;
  approvedVia?: CommitApprovalRecord["approvedVia"];
  context: CommitApprovalContext;
}): CommitApprovalRecord {
  return {
    id: `cap_${randomUUID()}`,
    gateId: params.gate.id,
    gateTitle: params.gate.title,
    gateReason: params.gate.reason,
    validatorId: params.gate.validatorId,
    approvalScope: approvalScope(params.gate),
    approvalFingerprint: approvalFingerprint(params.gate, params.context),
    changedFiles: params.context.changedFiles,
    summary: params.summary,
    approvedAt: new Date().toISOString(),
    approvedBy: params.approvedBy ?? process.env.USER ?? "unknown",
    approvedVia: params.approvedVia ?? "cli",
    configHash: params.context.configHash,
    validatorGraphHash: params.context.validatorGraphHash,
    decisionIds: params.gate.decisionIds ?? [],
    impactSurfaceIds: params.gate.impactSurfaceIds ?? [],
    evidence: params.gate.evidence ?? [],
  };
}

export function toPendingCommitGates(gates: ResolvedCommitGate[]): PendingCommitGate[] {
  return gates
    .filter((gate): gate is ResolvedCommitGate & { status: "unresolved" } => gate.status !== "approved")
    .map((gate) => ({
      ...gate,
      status: "unresolved",
      question: gate.question,
      agentAction: "request_user_input",
      agentProtocol: commitGateAgentProtocol(),
      preferredToolNames: ["request_user_input", "ask_user"],
      plainChatFallbackAllowed: true,
      fallbackProtocol: commitGateFallbackProtocol(),
      choices: commitGateApprovalChoices(),
      approveCommand: `bun run opencanon gate approve ${shellArg(gate.id)} --summary "<user explicit answer to the gate question>" --via agent`,
    }));
}

export function commitGateAgentProtocol(): string[] {
  return [
    "Pause the commit workflow.",
    "Inspect the staged diff for the gate files.",
    "Inspect the gate reason and evidence.",
    "Explain why OpenCanon blocked the commit.",
    "Explain why the validator cannot determine user intent from code alone.",
    "Use a structured ask-user tool when available.",
    "If unavailable, pause and ask in chat with explicit Approve/Reject choices.",
    "The user prompt must include the staged diff context, gate reason, ambiguity explanation, and exact gate question.",
    "Do not approve this gate yourself.",
    "Do not infer approval from the original commit request.",
    "Only run the approve command after the user explicitly approves.",
  ];
}

export function commitGateFallbackProtocol(): string {
  return "If no structured ask-user tool is available, pause and ask in chat with explicit Approve/Reject choices. Do not proceed until the user explicitly approves.";
}

export function commitGateApprovalChoices(): CommitGateApprovalChoice[] {
  return [
    {
      label: "Approve",
      description: "Record approval for this exact diff and retry the commit.",
    },
    {
      label: "Reject",
      description: "Do not approve; leave the commit blocked so the change can be revised or abandoned.",
    },
  ];
}

export function savePendingCommitGates(paths: ContextPaths, params: { context: CommitApprovalContext; gates: ResolvedCommitGate[]; diagnostics?: string[] }): PendingCommitGatesFile {
  const pending = toPendingCommitGates(params.gates);
  const file: PendingCommitGatesFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    context: params.context,
    pending,
    approved: params.gates.filter((gate) => gate.status === "approved"),
    diagnostics: params.diagnostics ?? [],
  };
  mkdirSync(paths.cacheDir, { recursive: true });
  writeAtomicJsonFileSync(pendingCommitGatesPath(paths), file);
  return file;
}

export function loadPendingCommitGates(paths: ContextPaths): PendingCommitGatesFile {
  const filePath = pendingCommitGatesPath(paths);
  if (!existsSync(filePath)) {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      context: emptyCommitApprovalContext(),
      pending: [],
      approved: [],
      diagnostics: [`No pending commit gate cache found. Run bun run opencanon validate --changed first.`],
    };
  }
  try {
    const value = JSON.parse(readFileSync(filePath, TextEncoding.Utf8)) as Partial<PendingCommitGatesFile>;
    return {
      version: 1,
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : new Date(0).toISOString(),
      context: isCommitApprovalContext(value.context) ? value.context : emptyCommitApprovalContext(),
      pending: Array.isArray(value.pending) ? value.pending.filter(isPendingCommitGate) : [],
      approved: Array.isArray(value.approved) ? value.approved.filter(isResolvedCommitGate) : [],
      diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      context: emptyCommitApprovalContext(),
      pending: [],
      approved: [],
      diagnostics: [`Pending commit gate cache is not valid JSON: ${relative(process.cwd(), filePath)}.`],
    };
  }
}

function pendingCommitGatesPath(paths: ContextPaths): string {
  return path.join(paths.cacheDir, "commit-gates.json");
}

export function createCommitApprovalContext(paths: ContextPaths, validatorGraphHash: string): CommitApprovalContext {
  const changed = changedFilesAndDiff(paths.rootDir);
  return {
    rootDir: paths.rootDir,
    diffFingerprint: sha256([
      "opencanon-commit-diff-v1",
      changed.stagedDiff,
      changed.worktreeDiff,
      ...changed.untrackedFiles.map((file) => {
        const absolute = path.join(paths.rootDir, file);
        return `untracked:${file}\n${existsSync(absolute) ? readFileSync(absolute, TextEncoding.Utf8) : ""}`;
      }),
    ]),
    stagedDiffFingerprint: sha256(["opencanon-commit-staged-diff-v1", changed.stagedDiff]),
    worktreeDiffFingerprint: sha256(["opencanon-commit-worktree-diff-v1", changed.worktreeDiff]),
    changedFiles: changed.files,
    stagedFiles: changed.stagedFiles,
    worktreeFiles: changed.worktreeFiles,
    untrackedFiles: changed.untrackedFiles,
    configHash: hashFileIfExists(paths.configPath),
    validatorGraphHash,
    diagnostics: changed.diagnostics,
  };
}

export function commitApprovalMatches(record: CommitApprovalRecord, gate: CommitGate, context: CommitApprovalContext): boolean {
  return (
    record.gateId === gate.id &&
    record.validatorId === gate.validatorId &&
    record.approvalScope === approvalScope(gate) &&
    record.approvalFingerprint === approvalFingerprint(gate, context) &&
    record.configHash === context.configHash &&
    record.validatorGraphHash === context.validatorGraphHash
  );
}

function sameCommitApprovalScope(left: CommitApprovalRecord, right: CommitApprovalRecord): boolean {
  return (
    left.gateId === right.gateId &&
    left.validatorId === right.validatorId &&
    left.approvalScope === right.approvalScope &&
    left.approvalFingerprint === right.approvalFingerprint &&
    left.configHash === right.configHash &&
    left.validatorGraphHash === right.validatorGraphHash
  );
}

export function sortCommitGates(gates: CommitGate[]): CommitGate[] {
  return [...gates].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.validatorId.localeCompare(right.validatorId) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.line ?? 0) - (right.line ?? 0),
  );
}

function approvalScope(gate: CommitGate): CommitGateApprovalScope {
  return gate.approvalScope ?? "staged-diff";
}

function approvalFingerprint(gate: CommitGate, context: CommitApprovalContext): string {
  const files = getCommitGateFiles(gate);
  const identity = commitGateFingerprintIdentity(gate);
  if (approvalScope(gate) === "file") {
    if (files.length === 0) return sha256(["opencanon-commit-gate-file-v1", identity, context.stagedDiffFingerprint]);
    return sha256(["opencanon-commit-gate-file-v1", identity, ...files.map((file) => `${file}\0${fileContent(context.rootDir, file)}`)]);
  }
  if (files.length === 0) return sha256(["opencanon-commit-gate-staged-diff-v1", identity, context.stagedDiffFingerprint]);
  return sha256(["opencanon-commit-gate-staged-diff-v1", identity, ...files.map((file) => `${file}\0${stagedFileState(context.rootDir, file)}`)]);
}

export function getCommitGateFiles(gate: CommitGate): string[] {
  return [...new Set([gate.file, ...(gate.evidence ?? []).map((item) => item.file)].filter((file): file is string => Boolean(file)).map(normalizeGitPath))].sort();
}

function commitGateFingerprintIdentity(gate: CommitGate): string {
  return JSON.stringify({
    id: gate.id,
    validatorId: gate.validatorId,
    title: gate.title,
    reason: gate.reason,
    question: gate.question,
    approvalScope: approvalScope(gate),
  });
}

function fileContent(rootDir: string, file: string): string {
  try {
    return readFileSync(path.join(rootDir, file), TextEncoding.Utf8);
  } catch {
    return "";
  }
}

function stagedFileDiff(rootDir: string, file: string): string {
  const gitRoot = getGitRoot(rootDir) ?? rootDir;
  const gitPath = gitRelativePath(rootDir, gitRoot, file);
  const result = spawnSync("git", [GitArg.Directory, gitRoot, "diff", GitArg.Cached, "--binary", "--", gitPath], {
    encoding: TextEncoding.Utf8,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : "";
}

function stagedFileState(rootDir: string, file: string): string {
  const gitRoot = getGitRoot(rootDir) ?? rootDir;
  const gitPath = gitRelativePath(rootDir, gitRoot, file);
  const status = spawnSync("git", [GitArg.Directory, gitRoot, "diff", GitArg.Cached, "--name-status", "--", gitPath], {
    encoding: TextEncoding.Utf8,
    maxBuffer: 1024 * 1024,
  });
  const object = spawnSync("git", [GitArg.Directory, gitRoot, "rev-parse", `:${gitPath}`], {
    encoding: TextEncoding.Utf8,
    maxBuffer: 1024 * 1024,
  });
  return [
    `status:${status.status === 0 ? status.stdout : ""}`,
    `index:${object.status === 0 ? object.stdout.trim() : "absent"}`,
    `diff:${stagedFileDiff(rootDir, file)}`,
  ].join("\n");
}

function changedFilesAndDiff(rootDir: string): {
  files: string[];
  stagedFiles: string[];
  worktreeFiles: string[];
  untrackedFiles: string[];
  stagedDiff: string;
  worktreeDiff: string;
  diagnostics: string[];
} {
  const gitRoot = getGitRoot(rootDir);
  if (!gitRoot) {
    return {
      files: [],
      stagedFiles: [],
      worktreeFiles: [],
      untrackedFiles: [],
      stagedDiff: "",
      worktreeDiff: "",
      diagnostics: [`No Git repository found for ${rootDir}; commit approval fingerprint is empty.`],
    };
  }

  const stagedDiff = runGit(gitRoot, ["diff", GitArg.Cached, "--binary"]);
  const worktreeDiff = runGit(gitRoot, ["diff", "--binary"]);
  const stagedFiles = runGit(gitRoot, ["diff", GitArg.Cached, GitArg.NameOnly]);
  const worktreeFiles = runGit(gitRoot, ["diff", GitArg.NameOnly]);
  const untrackedFiles = runGit(gitRoot, ["ls-files", GitArg.Others, GitArg.ExcludeStandard])
    .stdout.split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => rootRelativePath(rootDir, gitRoot, file));
  const stagedFileList = gitOutputFiles(rootDir, gitRoot, stagedFiles.stdout);
  const worktreeFileList = gitOutputFiles(rootDir, gitRoot, worktreeFiles.stdout);
  const files = [...new Set([...stagedFileList, ...worktreeFileList, ...untrackedFiles])].sort();
  const diagnostics = [stagedDiff, worktreeDiff, stagedFiles, worktreeFiles].flatMap((result) => result.diagnostics);
  return {
    files,
    stagedFiles: stagedFileList,
    worktreeFiles: worktreeFileList,
    untrackedFiles,
    stagedDiff: stagedDiff.stdout,
    worktreeDiff: worktreeDiff.stdout,
    diagnostics,
  };
}

function gitOutputFiles(rootDir: string, gitRoot: string, stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => rootRelativePath(rootDir, gitRoot, file))
    .sort();
}

function gitRelativePath(rootDir: string, gitRoot: string, file: string): string {
  const root = safeRealPath(rootDir);
  const repo = safeRealPath(gitRoot);
  const absolute = path.isAbsolute(file) ? safeRealPath(file) : path.join(root, file);
  return normalizeGitPath(relative(repo, absolute));
}

function rootRelativePath(rootDir: string, gitRoot: string, gitPath: string): string {
  const root = safeRealPath(rootDir);
  const repo = safeRealPath(gitRoot);
  return normalizeGitPath(relative(root, path.join(repo, gitPath)));
}

function safeRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function runGit(gitRoot: string, args: string[]): { stdout: string; diagnostics: string[] } {
  const result = spawnSync("git", [GitArg.Directory, gitRoot, ...args], {
    encoding: TextEncoding.Utf8,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return { stdout: result.stdout, diagnostics: [] };
  return { stdout: "", diagnostics: [(result.error?.message ?? result.stderr.trim()) || `git ${args.join(" ")} failed.`] };
}

function sha256(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashFileIfExists(filePath: string | null): string {
  if (!filePath || !existsSync(filePath)) return "sha256:absent";
  return sha256([readFileSync(filePath, TextEncoding.Utf8)]);
}

function emptyCommitApprovalContext(): CommitApprovalContext {
  return {
    rootDir: "",
    diffFingerprint: "",
    stagedDiffFingerprint: "",
    worktreeDiffFingerprint: "",
    changedFiles: [],
    stagedFiles: [],
    worktreeFiles: [],
    untrackedFiles: [],
    configHash: "",
    validatorGraphHash: "",
    diagnostics: [],
  };
}

function normalizeGitPath(file: string): string {
  return file.split(path.sep).join("/");
}

function isCommitApprovalRecord(value: unknown): value is CommitApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.gateId === "string" &&
    typeof record.approvalScope === "string" &&
    typeof record.approvalFingerprint === "string" &&
    typeof record.configHash === "string" &&
    typeof record.validatorGraphHash === "string" &&
    typeof record.summary === "string"
  );
}

function isCommitApprovalContext(value: unknown): value is CommitApprovalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.diffFingerprint === "string" &&
    typeof record.rootDir === "string" &&
    typeof record.stagedDiffFingerprint === "string" &&
    typeof record.worktreeDiffFingerprint === "string" &&
    Array.isArray(record.changedFiles) &&
    record.changedFiles.every((file) => typeof file === "string") &&
    Array.isArray(record.stagedFiles) &&
    record.stagedFiles.every((file) => typeof file === "string") &&
    Array.isArray(record.worktreeFiles) &&
    record.worktreeFiles.every((file) => typeof file === "string") &&
    Array.isArray(record.untrackedFiles) &&
    record.untrackedFiles.every((file) => typeof file === "string") &&
    typeof record.configHash === "string" &&
    typeof record.validatorGraphHash === "string" &&
    Array.isArray(record.diagnostics) &&
    record.diagnostics.every((diagnostic) => typeof diagnostic === "string")
  );
}

function isResolvedCommitGate(value: unknown): value is ResolvedCommitGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.validatorId === "string" && (record.status === "unresolved" || record.status === "approved");
}

function isPendingCommitGate(value: unknown): value is PendingCommitGate {
  if (!isResolvedCommitGate(value) || value.status !== "unresolved") return false;
  const record = value as Record<string, unknown>;
  return typeof record.question === "string" && typeof record.approveCommand === "string";
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
