import type { FixMode } from "./fixes.ts";

export const DoctorStatus = {
  Pass: "pass",
  Warn: "warn",
  Fail: "fail",
} as const;
export type DoctorStatus = (typeof DoctorStatus)[keyof typeof DoctorStatus];

export const DoctorCheckGroup = {
  App: "app",
  GeneratedState: "generated-state",
  Install: "install",
  Project: "project",
  ProjectMap: "project-map",
} as const;
export type DoctorCheckGroup = (typeof DoctorCheckGroup)[keyof typeof DoctorCheckGroup];

export type DoctorCheck = {
  id: string;
  group: DoctorCheckGroup;
  status: DoctorStatus;
  message: string;
  details?: string[];
};

export type DoctorReport = {
  status: DoctorStatus;
  checks: DoctorCheck[];
};

export type DoctorRuntimeHealth = {
  service?: {
    status: string;
    message?: string;
    registered: boolean;
  };
  project?: {
    status: string;
    message?: string;
    registered: boolean;
    lifecycleStatus?: string;
  };
};

export type DoctorFixResult = {
  mode: FixMode;
  dryRun: boolean;
  selectedFixes: number;
  appliedFixes: number;
  diagnostics: string[];
  skipped: string[];
};
