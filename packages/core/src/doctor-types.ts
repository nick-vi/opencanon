import type { FixMode } from "./fixes.ts";
import type { SemanticIndexSnapshot } from "./contracts.ts";

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
    inferencePolicy?: {
      status: "valid" | "invalid";
      path: string;
      message: string;
      source?: "default" | "file";
      profileId?: string;
    };
  };
  project?: {
    status: string;
    message?: string;
    registered: boolean;
    lifecycleStatus?: string;
  };
};

export const DoctorKnowledgeInspectionKind = {
  Available: "available",
  Failed: "failed",
  NotInspected: "not-inspected",
} as const;

export type DoctorKnowledgeInspection =
  | { kind: typeof DoctorKnowledgeInspectionKind.Available; index: SemanticIndexSnapshot | null }
  | { kind: typeof DoctorKnowledgeInspectionKind.Failed; error: string }
  | { kind: typeof DoctorKnowledgeInspectionKind.NotInspected };

export type DoctorFixResult = {
  mode: FixMode;
  dryRun: boolean;
  selectedFixes: number;
  appliedFixes: number;
  diagnostics: string[];
  skipped: string[];
};
