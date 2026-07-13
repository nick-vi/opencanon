export const InitStateFilePath = ".opencanon/init.json";

export const GeneratedStateIgnoreEntries = [
  ".opencanon/generated/",
  ".opencanon/processes/",
  ".opencanon/check-*/",
  ".opencanon/state/",
  ".opencanon/*.log",
  InitStateFilePath,
];

export const CommitApprovalsIgnoreEntries = [".opencanon/commit-approvals.json"];

export const GeneratedStateIgnoreProbePaths = [
  ".opencanon/processes/stable/runtime.json",
  ".opencanon/processes/stable/runtime.log",
  ".opencanon/processes/stable/worker.lock",
  ".opencanon/check-example/owner.json",
  ".opencanon/diagnostic.log",
  InitStateFilePath,
  ".opencanon/state/stable/state.sqlite",
  ".opencanon/state/stable/state.sqlite-shm",
  ".opencanon/state/stable/state.sqlite-wal",
  ".opencanon/state/stable/semantic-index/project/vectors.bin",
];
