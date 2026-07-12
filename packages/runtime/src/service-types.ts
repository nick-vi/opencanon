import type { RuntimeHealth, RuntimeState } from "@opencanon/core";
import type { ServiceActionDefinition, ServiceProjectStatus } from "@opencanon/service-contracts";
import type { LocalTransportKind } from "./local-protocol.ts";
import { HiddenServiceRegistryArg } from "./service-peer-discovery.ts";

export type RuntimeRegistryEntry = {
  rootDir: string;
  host: string;
  port: number;
  url: string;
  pipeEndpoint: string;
  pid: number;
  leaseId: string;
  startedAt: string;
  logPath: string;
  authToken: string;
  lifecycle: ProcessLifecycleState;
  transport: LocalTransportKind;
  protocolVersion: number;
  runtimeVersion: string;
  runtimeFingerprint: string;
  cliPath: string;
};

export type ServiceRegistryEntry = {
  host: string;
  port: number;
  url: string;
  pipeEndpoint: string;
  pid: number;
  leaseId: string;
  startedAt: string;
  logPath: string;
  authToken: string;
  lifecycle: ProcessLifecycleState;
  transport: LocalTransportKind;
  protocolVersion: number;
  runtimeVersion: string;
  runtimeFingerprint: string;
  cliPath: string;
  ownerPid?: number;
};

// Single source of truth for runtime inspection statuses; reference members instead of inlining the strings.
export const RuntimeStatus = { Busy: "busy", Running: "running", Starting: "starting", Unhealthy: "unhealthy", Stale: "stale" } as const;
export type RuntimeStatus = (typeof RuntimeStatus)[keyof typeof RuntimeStatus];

export type ServiceRecentProject = {
  rootDir: string;
  openedAt?: string;
};

export type ServiceOverviewRequest = {
  discoveryRoots?: string[];
  recentProjects?: ServiceRecentProject[];
  currentRootDir?: string;
};

export type ServiceSummary = {
  url: string;
  status: RuntimeStatus | "unavailable";
  pipeEndpoint?: string;
  transport?: LocalTransportKind;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
  cliPath?: string;
};

export type ServiceProjectSummary = {
  id: string;
  rootDir: string;
  url: string;
  status: ServiceProjectStatus;
  pid?: number;
  port?: number;
  pipeEndpoint?: string;
  transport?: LocalTransportKind;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
  cliPath?: string;
  files?: number;
  findings?: number;
};

export type ServiceActivityItem = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail?: string;
  rootDir?: string;
};

export type ServiceOverview = {
  service: ServiceSummary;
  currentRootDir?: string;
  projects: ServiceProjectSummary[];
  activity: ServiceActivityItem[];
  actions: ServiceActionDefinition[];
  diagnostics: string[];
};

export type RuntimeInspection = {
  entry: RuntimeRegistryEntry;
  status: RuntimeStatus;
  message: string;
  health?: RuntimeHealth;
  state?: RuntimeState;
};

export type ReadyRuntimeInspection = RuntimeInspection & { status: typeof RuntimeStatus.Running };

export type StartProjectRuntimeResult = {
  status: "started" | "already-running";
  entry: RuntimeRegistryEntry;
  message: string;
};

export type StartServiceResult = {
  status: "started" | "already-running";
  entry: ServiceRegistryEntry;
  message: string;
};

export type EnsureProjectRuntimeResult = {
  service: ServiceRegistryEntry;
  project: StartProjectRuntimeResult;
};

export type StopProjectRuntimeResult = {
  status: "stopped" | "not-running" | "stale" | "unhealthy";
  rootDir: string;
  message: string;
};

export type StopServiceResult = {
  status: "stopped" | "not-running" | "stale" | "unhealthy";
  message: string;
};

export type ServiceRepairResult = {
  retiredServiceProcesses: number;
  retiredProjectRuntimes: number;
  removedPipeEndpoints: number;
  diagnostics: string[];
};

export type ServiceInspection = {
  entry: ServiceRegistryEntry;
  status: RuntimeStatus;
  message: string;
  health?: ServiceHealth;
};

export type ServiceServer = {
  url: string;
  pipeEndpoint: string;
  port: number;
  authToken: string;
  leaseId: string;
  stop(): Promise<void>;
};

export const ProcessLifecycleStatus = {
  Starting: "starting",
  Busy: "busy",
  Running: "running",
  BackingOff: "backing-off",
  Failed: "failed",
  Stopping: "stopping",
  Stopped: "stopped",
  Stale: "stale",
  Unhealthy: "unhealthy",
} as const;
export type ProcessLifecycleStatus = (typeof ProcessLifecycleStatus)[keyof typeof ProcessLifecycleStatus];

export const ProcessLifecycleEventKind = {
  ServiceStarted: "service-started",
  ServiceStopped: "service-stopped",
  ServiceStartupFailed: "service-startup-failed",
  RuntimeStarted: "runtime-started",
  RuntimeStopped: "runtime-stopped",
  RuntimeStartupFailed: "runtime-startup-failed",
  RuntimeUnhealthy: "runtime-unhealthy",
  RuntimeStale: "runtime-stale",
  RuntimeRestartScheduled: "runtime-restart-scheduled",
  RuntimeRestartSkipped: "runtime-restart-skipped",
} as const;
export type ProcessLifecycleEventKind = (typeof ProcessLifecycleEventKind)[keyof typeof ProcessLifecycleEventKind];

export const ProcessLifecycleScope = {
  Service: "service",
  Runtime: "runtime",
} as const;
export type ProcessLifecycleScope = (typeof ProcessLifecycleScope)[keyof typeof ProcessLifecycleScope];

export type ProcessRestartState = {
  attempts: number;
  firstFailureAt?: string;
  lastFailureAt?: string;
  nextRestartAt?: string;
  lastReason?: string;
};

export type ProcessLifecycleState = {
  status: ProcessLifecycleStatus;
  updatedAt: string;
  message?: string;
  restart: ProcessRestartState;
};

export type ProcessLifecycleEvent = {
  id: string;
  at: string;
  kind: ProcessLifecycleEventKind;
  scope: ProcessLifecycleScope;
  rootDir?: string;
  pid?: number;
  leaseId?: string;
  message?: string;
};

export type ServiceHealth = {
  status: "ready";
  protocolVersion: number;
  runtimeVersion: string;
  process: {
    kind: "service";
    pid: number;
    leaseId: string;
  };
};

export type ReconcileProjectRuntimesResult = {
  inspected: number;
  busy: number;
  running: number;
  starting: number;
  restarted: number;
  backingOff: number;
  failed: number;
  stale: number;
  unhealthy: number;
  repair: ServiceRepairResult;
};

export type RegistryFile = {
  version: 1;
  runtimes: RuntimeRegistryEntry[];
  service?: ServiceRegistryEntry;
  events: ProcessLifecycleEvent[];
};

export type RegistryReadResult = {
  entries: RuntimeRegistryEntry[];
  service?: ServiceRegistryEntry;
  events: ProcessLifecycleEvent[];
  diagnostics: string[];
};

export type RuntimeProcessLease = {
  rootDir: string;
  pid: number;
  source: string;
};

export type ServiceProcessLease = {
  pid: number;
  source: string;
};

export type ProjectWorkerLease = {
  rootDir: string;
  pid: number;
  leaseId: string;
  acquiredAt: string;
  heartbeatAt: string;
  registryPath?: string;
};

export type ProjectWorkerLeaseHandle = {
  lease: ProjectWorkerLease;
  path: string;
  release(): void;
};

export const LocalControlProtocolVersion = 1;
export const registryVersion = 1;
export const defaultServicePort = 4766;
export const defaultRuntimePort = 4767;
export const maxPortOffset = 1000;
export const AutoPortStartupAttempts = 3;
export const defaultProjectRuntimeIdleTimeoutMs = 10 * 60 * 1000;
export const maxServiceRequestBodyBytes = 1024 * 1024;
export const discoveryRootChildLimit = 200;
export const serviceCommandOutputLimit = 16_384;
export const ServiceArg = {
  AllowRemote: "--allow-remote",
} as const;

export const ServiceEnv = {
  AuthToken: "OPENCANON_SERVICE_TOKEN",
  LeaseId: "OPENCANON_SERVICE_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  OwnerPid: "OPENCANON_SERVICE_OWNER_PID",
  PipeEndpoint: "OPENCANON_SERVICE_PIPE_ENDPOINT",
} as const;

export const ProjectRuntimeEnv = {
  AuthToken: "OPENCANON_RUNTIME_TOKEN",
  LeaseId: "OPENCANON_RUNTIME_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  PipeEndpoint: "OPENCANON_RUNTIME_PIPE_ENDPOINT",
  StartupResultPath: "OPENCANON_RUNTIME_STARTUP_RESULT_PATH",
} as const;

export const LocalHealthWaitFailure = {
  ProcessExited: "process-exited",
  Timeout: "timeout",
} as const;
export type LocalHealthWaitFailure = (typeof LocalHealthWaitFailure)[keyof typeof LocalHealthWaitFailure];
export type RuntimeHealthWaitResult = { ready: true } | { ready: false; reason: LocalHealthWaitFailure };
export type ServiceHealthWaitResult = { ready: true } | { ready: false; reason: LocalHealthWaitFailure };

export const ServiceApiRoute = {
  ActionInvoke: "/api/actions/invoke",
  EnsureProject: "/api/projects/ensure",
  EventsStream: "/api/projects/events/stream",
  Health: "/api/health",
  Overview: "/api/overview",
  Request: "/api/projects/request",
  SetupProject: "/api/projects/setup",
  StopProject: "/api/projects/stop",
  Summary: "/api/projects/summary",
} as const;

export const PlatformName = {
  Darwin: "darwin",
  Win32: "win32",
} as const;

export const HiddenRegistryArg = HiddenServiceRegistryArg;
export const LocalPipeCleanupAgeMs = 60_000;
