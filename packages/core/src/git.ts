import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type GitCommitInfo = {
  hash: string;
  fullHash: string;
  date: string;
  author: string;
  subject: string;
};

export type GitFileHistory = {
  file: string;
  commits: GitCommitInfo[];
  diagnostics: string[];
};

export type GitFileDiff = {
  gitRoot: string | null;
  file: string;
  commit: string;
  beforeContent: string;
  afterContent: string;
  diagnostics: string[];
};

const TextEncoding = {
  Utf8: "utf8",
} as const;

const GitCommand = {
  Git: "git",
} as const;
const GitSubcommand = {
  Diff: "diff",
  Log: "log",
  LsFiles: "ls-files",
  RevParse: "rev-parse",
  Show: "show",
} as const;
const GitArg = {
  Cached: "--cached",
  DateShort: "--date=short",
  Directory: "-C",
  ExcludeStandard: "--exclude-standard",
  Follow: "--follow",
  NameOnly: "--name-only",
  Others: "--others",
  Separator: "--",
  ShowTopLevel: "--show-toplevel",
} as const;
const GitDiffFilter = {
  AddedCopiedModifiedRenamed: "--diff-filter=ACMR",
} as const;
const GitLogFormat = {
  FileHistory: "%h%x09%H%x09%ad%x09%an%x09%s",
} as const;
export const GitProjectFileArgs = [GitSubcommand.LsFiles, GitArg.Cached, GitArg.Others, GitArg.ExcludeStandard] as const;
const GitUntrackedFileArgs = [GitSubcommand.LsFiles, GitArg.Others, GitArg.ExcludeStandard] as const;
const GitHistoryLimit = {
  TimeoutMs: 10_000,
  MaxBuffer: 16 * 1024 * 1024,
} as const;
const GitDiffLimit = {
  TimeoutMs: 10_000,
  MaxBuffer: 8 * 1024 * 1024,
} as const;

export function getGitRoot(rootDir: string): string | null {
  const result = spawnSync(GitCommand.Git, [GitArg.Directory, rootDir, GitSubcommand.RevParse, GitArg.ShowTopLevel], {
    encoding: TextEncoding.Utf8,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function getChangedFiles(rootDir: string): { files: string[]; gitRoot: string | null; diagnostics: string[] } {
  const gitRoot = getGitRoot(rootDir);
  if (!gitRoot) {
    return {
      files: [],
      gitRoot: null,
      diagnostics: [`No Git repository found for ${rootDir}.`],
    };
  }

  const diagnostics: string[] = [];
  const files = unique([
    ...runGitFiles(gitRoot, [GitSubcommand.Diff, GitArg.NameOnly, GitDiffFilter.AddedCopiedModifiedRenamed]),
    ...runGitFiles(gitRoot, [GitSubcommand.Diff, GitArg.Cached, GitArg.NameOnly, GitDiffFilter.AddedCopiedModifiedRenamed]),
    ...runGitFiles(gitRoot, GitUntrackedFileArgs),
  ]);

  return {
    files: files
      .map((file) => toRealRootRelative(rootDir, path.join(gitRoot, file)))
      .filter((file) => !file.startsWith("..") && !path.isAbsolute(file))
      .sort(),
    gitRoot,
    diagnostics,
  };
}

export function getGitFileHistory(rootDir: string, files: string[], limit = 5): { gitRoot: string | null; histories: GitFileHistory[]; diagnostics: string[] } {
  const gitRoot = getGitRoot(rootDir);
  if (!gitRoot) {
    return {
      gitRoot: null,
      histories: [],
      diagnostics: [`No Git repository found for ${rootDir}.`],
    };
  }

  const realRootDir = realpathSync(rootDir);
  const histories = files.map((file) => {
    const gitFile = toGitRootRelative(realRootDir, gitRoot, file);
    const result = spawnSync(
      GitCommand.Git,
      [GitArg.Directory, gitRoot, GitSubcommand.Log, GitArg.Follow, `--max-count=${limit}`, GitArg.DateShort, `--format=${GitLogFormat.FileHistory}`, GitArg.Separator, gitFile],
      { encoding: TextEncoding.Utf8, timeout: GitHistoryLimit.TimeoutMs, maxBuffer: GitHistoryLimit.MaxBuffer },
    );

    if (result.error || result.status !== 0) {
      return {
        file,
        commits: [],
        diagnostics: [(result.error?.message ?? result.stderr.trim()) || `Could not read git history for ${file}.`],
      };
    }

    return {
      file,
      commits: result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash = "", fullHash = "", date = "", author = "", ...subjectParts] = line.split("\t");
          return {
            hash,
            fullHash,
            date,
            author,
            subject: subjectParts.join("\t"),
          };
        }),
      diagnostics: [],
    };
  });

  return { gitRoot, histories, diagnostics: [] };
}

export function getGitFileDiff(rootDir: string, file: string, commit: string): GitFileDiff {
  const gitRoot = getGitRoot(rootDir);
  const requestedCommit = commit.trim();
  if (!gitRoot) {
    return {
      gitRoot: null,
      file,
      commit: requestedCommit,
      beforeContent: "",
      afterContent: "",
      diagnostics: [`No Git repository found for ${rootDir}.`],
    };
  }
  if (!requestedCommit) {
    return {
      gitRoot,
      file,
      commit: requestedCommit,
      beforeContent: "",
      afterContent: "",
      diagnostics: ["Commit is required."],
    };
  }

  const gitFile = toGitRootRelative(realpathSync(rootDir), gitRoot, file);
  const before = readGitBlob(gitRoot, `${requestedCommit}^:${gitFile}`);
  const after = readGitBlob(gitRoot, `${requestedCommit}:${gitFile}`);

  if (!before.ok && !after.ok) {
    return {
      gitRoot,
      file,
      commit: requestedCommit,
      beforeContent: "",
      afterContent: "",
      diagnostics: [after.diagnostic || before.diagnostic || `Could not read git snapshots for ${file} at ${requestedCommit}.`],
    };
  }

  return {
    gitRoot,
    file,
    commit: requestedCommit,
    beforeContent: before.ok ? before.content : "",
    afterContent: after.ok ? after.content : "",
    diagnostics: [],
  };
}

function readGitBlob(gitRoot: string, spec: string): { ok: true; content: string } | { ok: false; diagnostic: string } {
  const result = spawnSync(GitCommand.Git, [GitArg.Directory, gitRoot, GitSubcommand.Show, spec], {
    encoding: TextEncoding.Utf8,
    timeout: GitDiffLimit.TimeoutMs,
    maxBuffer: GitDiffLimit.MaxBuffer,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      diagnostic: (result.error?.message ?? result.stderr.trim()) || `Could not read git blob ${spec}.`,
    };
  }
  return { ok: true, content: result.stdout };
}

export function runGitFiles(gitRoot: string, args: readonly string[]): string[] {
  const result = spawnSync(GitCommand.Git, [GitArg.Directory, gitRoot, ...args], {
    encoding: TextEncoding.Utf8,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .map(normalizePath);
}

export function toRealRootRelative(rootDir: string, absolutePath: string): string {
  const realRoot = realpathSync(rootDir);
  const realFile = existsSync(absolutePath) ? realpathSync(absolutePath) : path.resolve(absolutePath);
  return normalizePath(path.relative(realRoot, realFile));
}

function toGitRootRelative(realRootDir: string, gitRoot: string, file: string): string {
  return normalizePath(path.relative(gitRoot, path.join(realRootDir, file)));
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
