export const InitStateFilePath = ".opencanon/init.json";

export const GeneratedStateIgnoreEntries = [
  ".opencanon/generated/",
  ".opencanon/runtime.json",
  ".opencanon/runtime.log",
  ".opencanon/worker.lock",
  InitStateFilePath,
  ".opencanon/*.sqlite",
  ".opencanon/*.sqlite-shm",
  ".opencanon/*.sqlite-wal",
  ".opencanon/semantic-index/",
];

export const CommitApprovalsIgnoreEntries = [".opencanon/commit-approvals.json"];

export const GeneratedStateIgnoreProbePaths = [
  ".opencanon/runtime.json",
  ".opencanon/runtime.log",
  ".opencanon/worker.lock",
  InitStateFilePath,
  ".opencanon/state.sqlite",
  ".opencanon/state.sqlite-shm",
  ".opencanon/state.sqlite-wal",
  ".opencanon/semantic-index/project/vectors.bin",
];
