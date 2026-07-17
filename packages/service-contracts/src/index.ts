// Portable local-service contracts shared by runtime clients. Keep this module
// free of Node and framework imports so browser or native clients can consume it.

export * from "./inference.ts";

export const ServiceProjectStatusValue = {
  Discovered: "discovered",
  Failed: "failed",
  Recent: "recent",
  Running: "running",
  Starting: "starting",
  Stale: "stale",
  Unhealthy: "unhealthy",
} as const;
export type ServiceProjectStatus = (typeof ServiceProjectStatusValue)[keyof typeof ServiceProjectStatusValue];

export const ServiceActionId = {
  CheckUpdates: "service.checkUpdates",
  ExportDiagnostics: "service.exportDiagnostics",
  OpenLogs: "service.openLogs",
  OpenProject: "service.openProject",
  QuitClient: "client.quit",
  Settings: "service.settings",
  SwitchProject: "service.switchProject",
  ProjectDoctor: "project.doctor",
  ProjectReindex: "project.reindex",
  ProjectSelect: "project.select",
} as const;
export type ServiceActionId = (typeof ServiceActionId)[keyof typeof ServiceActionId];

export const ServiceActionCategory = {
  Service: "service",
  Diagnostics: "diagnostics",
  Navigation: "navigation",
  Project: "project",
} as const;
export type ServiceActionCategory = (typeof ServiceActionCategory)[keyof typeof ServiceActionCategory];

export const ServiceActionScope = {
  Service: "service",
  Project: "project",
} as const;
export type ServiceActionScope = (typeof ServiceActionScope)[keyof typeof ServiceActionScope];

export const ServiceActionSurface = {
  CommandPalette: "command-palette",
  Dashboard: "dashboard",
  StatusBar: "status-bar",
  StatusMenu: "status-menu",
} as const;
export type ServiceActionSurface = (typeof ServiceActionSurface)[keyof typeof ServiceActionSurface];

export const ServiceEffectKind = {
  CheckUpdates: "check-updates",
  ExportDiagnostics: "export-diagnostics",
  Navigate: "navigate",
  PickFolder: "pick-folder",
  QuitClient: "quit-client",
  RevealPath: "reveal-path",
  SelectProject: "select-project",
  ShowClient: "show-client",
} as const;
export type ServiceEffectKind = (typeof ServiceEffectKind)[keyof typeof ServiceEffectKind];

export const ServiceActionStatusValue = {
  Error: "error",
  Ok: "ok",
  Warning: "warning",
} as const;
export type ServiceActionStatus = (typeof ServiceActionStatusValue)[keyof typeof ServiceActionStatusValue];

export type ServiceClientEffect =
  | { kind: typeof ServiceEffectKind.CheckUpdates }
  | { kind: typeof ServiceEffectKind.ExportDiagnostics; rootDir?: string }
  | { kind: typeof ServiceEffectKind.Navigate; view: string }
  | { kind: typeof ServiceEffectKind.PickFolder }
  | { kind: typeof ServiceEffectKind.QuitClient }
  | { kind: typeof ServiceEffectKind.RevealPath; path: string }
  | { kind: typeof ServiceEffectKind.SelectProject; rootDir: string }
  | { kind: typeof ServiceEffectKind.ShowClient };

export type ServiceActionDefinition = {
  id: ServiceActionId;
  label: string;
  category: ServiceActionCategory;
  scope: ServiceActionScope;
  enabled: boolean;
  disabledReason?: string;
  surfaces: ServiceActionSurface[];
};

export type ServiceActionResult = {
  status: ServiceActionStatus;
  title: string;
  message: string;
  path?: string;
  details?: unknown;
  effects?: ServiceClientEffect[];
};
