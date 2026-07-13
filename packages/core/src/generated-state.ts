export const InitStateFilePath = ".opencanon/init.json";

export const GeneratedStateIgnoreEntries = [
  ".opencanon/generated/",
  ".opencanon/processes/",
  ".opencanon/check-*/",
  ".opencanon/*.log",
  InitStateFilePath,
  ".opencanon/*.sqlite",
  ".opencanon/*.sqlite-shm",
  ".opencanon/*.sqlite-wal",
  ".opencanon/semantic-index/",
];

export const CommitApprovalsIgnoreEntries = [".opencanon/commit-approvals.json"];

export const GeneratedStateIgnoreProbePaths = [
  ".opencanon/processes/stable/runtime.json",
  ".opencanon/processes/stable/runtime.log",
  ".opencanon/processes/stable/worker.lock",
  ".opencanon/check-example/owner.json",
  ".opencanon/diagnostic.log",
  InitStateFilePath,
  ".opencanon/state.sqlite",
  ".opencanon/state.sqlite-shm",
  ".opencanon/state.sqlite-wal",
  ".opencanon/semantic-index/project/vectors.bin",
];
