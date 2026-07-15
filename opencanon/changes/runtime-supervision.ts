import { DefinitionTargetKind, defineChange } from "@opencanon/core";

export const runtimeSupervisionChanges = [
  defineChange({
    id: "runtime-health-confirmation",
    title: "Confirm runtime health failures before replacement",
    kind: "fix",
    summary: "Keep a live project runtime through one transient failed health probe before replacing it.",
    updates: {
      areas: ["local-service-and-runtimes"],
      specs: ["project-runtime-lifecycle-spec", "runtime-operations-spec"],
      surfaces: ["local-service-control", "project-canon-model", "release-update"],
    },
    scope: [
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-lifecycle.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-monitor.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-reconcile.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-render.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-storage.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-types.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/test/service-reconcile.test.ts" },
      { kind: DefinitionTargetKind.File, path: "opencanon/changes/runtime-supervision.ts" },
    ],
    intent: {
      problem: "One delayed health response can make the supervisor replace a live project runtime and interrupt an active Proof run.",
      outcome: "Dead runtimes still repair immediately, while a live but temporarily unresponsive runtime gets one reconciliation interval to recover before replacement.",
      why: "Liveness supervision must distinguish process death from transient event-loop pressure without hiding persistent failures.",
    },
    tasks: [
      {
        id: "confirm-live-runtime-health",
        title: "Add health confirmation hysteresis for live runtimes",
        files: [
          "packages/runtime/src/service-lifecycle.ts",
          "packages/runtime/src/service-monitor.ts",
          "packages/runtime/src/service-reconcile.ts",
          "packages/runtime/src/service-render.ts",
          "packages/runtime/src/service-storage.ts",
          "packages/runtime/src/service-types.ts",
          "packages/runtime/test/service-reconcile.test.ts",
        ],
        checks: ["service-reconcile-tests", "runtime-types", "process-steady-state"],
      },
    ],
    checks: [
      { id: "service-reconcile-tests", kind: "test", target: "packages/runtime/test/service-reconcile.test.ts" },
      { id: "runtime-types", kind: "command", command: "npm run check:types" },
      { id: "process-steady-state", kind: "command", command: "npm run check:test-processes" },
    ],
    render: { kind: "none" },
  }),
  defineChange({
    id: "registered-worker-lease-ownership",
    title: "Keep registered worker ownership authoritative",
    kind: "fix",
    summary: "Prevent delayed worker heartbeats from bypassing runtime health confirmation.",
    updates: {
      areas: ["local-service-and-runtimes"],
      specs: ["project-runtime-lifecycle-spec", "runtime-operations-spec"],
      surfaces: ["local-service-control", "project-canon-model"],
    },
    scope: [
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-process.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-reconcile.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-start.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service-storage.ts" },
      { kind: DefinitionTargetKind.File, path: "packages/runtime/test/service-reconcile.test.ts" },
      { kind: DefinitionTargetKind.File, path: "opencanon/changes/runtime-supervision.ts" },
    ],
    intent: {
      problem: "A delayed worker-lock heartbeat can make reconciliation retire the same live PID already owned by the runtime registry before health confirmation runs.",
      outcome: "The registry remains authoritative for its live worker PID; only dead or differently owned leases are retired as conflicts.",
      why: "Lease conflict repair and runtime health supervision must not make competing lifecycle decisions about the same registered process.",
    },
    tasks: [
      {
        id: "preserve-registered-worker",
        title: "Preserve registered workers through delayed heartbeats",
        files: [
          "packages/runtime/src/service-process.ts",
          "packages/runtime/src/service-reconcile.ts",
          "packages/runtime/src/service-start.ts",
          "packages/runtime/src/service-storage.ts",
          "packages/runtime/test/service-reconcile.test.ts",
        ],
        checks: ["service-reconcile-tests", "runtime-types", "process-steady-state"],
      },
    ],
    checks: [
      { id: "service-reconcile-tests", kind: "test", target: "packages/runtime/test/service-reconcile.test.ts" },
      { id: "runtime-types", kind: "command", command: "npm run check:types" },
      { id: "process-steady-state", kind: "command", command: "npm run check:test-processes" },
    ],
    render: { kind: "none" },
  }),
];
