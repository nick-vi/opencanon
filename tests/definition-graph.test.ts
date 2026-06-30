import { describe, expect, it } from "vitest";
import { DefinitionTargetKind, buildDefinitionGraph, defineArea, defineChange, defineConvention, defineSpec } from "@opencanon/core";

describe("definition graph", () => {
  it("derives impact-surface backlinks and warnings from definition scopes", () => {
    const graph = buildDefinitionGraph({
      areas: [
        defineArea({
          id: "company-profile",
          title: "Company Profile",
          summary: "Users can inspect company information.",
          owns: [{ kind: DefinitionTargetKind.File, path: "src/api/routes/companies.ts" }],
          checks: [{ id: "doctor", kind: "doctor" }],
          render: { kind: "none" },
        }),
      ],
      specs: [
        defineSpec({
          id: "company-profile-spec",
          title: "Company Profile Spec",
          summary: "Company profile reads stay visible and checked.",
          scope: [{ kind: DefinitionTargetKind.File, path: "src/api/routes/companies.ts" }],
          checks: [{ id: "doctor", kind: "doctor" }],
          governedBy: { conventions: ["impact-surfaces-current"] },
          render: { kind: "none" },
        }),
      ],
      changes: [
        defineChange({
          id: "company-profile-filter",
          title: "Company Profile Filter",
          kind: "feature",
          intent: {
            problem: "Company reads cannot be filtered.",
            outcome: "Company reads can be filtered safely.",
          },
          scope: [{ kind: DefinitionTargetKind.File, path: "src/api/routes/companies.ts" }],
          checks: [{ id: "doctor", kind: "doctor" }],
          render: { kind: "none" },
        }),
      ],
      conventions: [
        defineConvention({
          id: "impact-surfaces-current",
          title: "Impact Surfaces Current",
          rule: "Sensitive surfaces must be declared.",
          applies: { kind: "files", globs: ["src/**/*.ts"] },
          impactSurfaces: ["company-read-model"],
          render: { kind: "none" },
          runtime: { kind: "none" },
        }),
      ],
      impactSurfaces: [
        {
          id: "company-read-model",
          applies: ["src/api/routes/companies.ts"],
          docs: ["docs/opencanon/canon/impact.md#impact-surfaces"],
          conventionIds: ["impact-surfaces-current"],
        },
      ],
    });

    expect(graph.backlinks.surfaceToAreas["company-read-model"]).toEqual(["company-profile"]);
    expect(graph.backlinks.surfaceToSpecs["company-read-model"]).toEqual(["company-profile-spec"]);
    expect(graph.backlinks.surfaceToChanges["company-read-model"]).toEqual(["company-profile-filter"]);
    expect(graph.backlinks.specToSurfaces["company-profile-spec"]).toEqual(["company-read-model"]);
    expect(graph.backlinks.surfaceToConventions["company-read-model"]).toEqual(["impact-surfaces-current"]);
    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain("area-implicit-impact-surface");
    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain("spec-implicit-impact-surface");
    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toContain("change-implicit-impact-surface");
  });

  it("links conventions to definition-scope targets", () => {
    const graph = buildDefinitionGraph({
      specs: [
        defineSpec({
          id: "service-health-spec",
          title: "Service Health Spec",
          summary: "Service health stays visible.",
          render: { kind: "none" },
        }),
      ],
      conventions: [
        defineConvention({
          id: "spec-governance",
          title: "Spec Governance",
          rule: "Specs declare checks.",
          applies: { kind: "definitions", definitions: [{ kind: "spec", ids: ["service-health-spec"] }] },
          render: { kind: "none" },
          runtime: { kind: "none" },
        }),
      ],
      areas: [],
      changes: [],
      impactSurfaces: [],
    });

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "convention:spec-governance",
          to: "spec:service-health-spec",
          kind: "governs",
        }),
      ]),
    );
  });

  it("links change tasks, dependencies, and task check references", () => {
    const graph = buildDefinitionGraph({
      areas: [],
      specs: [],
      conventions: [],
      impactSurfaces: [{ id: "model-surface", title: "Model Surface", applies: ["src/model.ts"], proposed: true }],
      changes: [
        defineChange({
          id: "task-graph-change",
          title: "Task Graph Change",
          kind: "feature",
          intent: {
            problem: "Tasks are not mapped.",
            outcome: "Tasks are visible in the Project Map.",
          },
          checks: [{ id: "smoke", kind: "command", command: "npm test" }],
          tasks: [
            { id: "model", title: "Model task", checks: ["smoke"], files: ["src/model.ts"], surfaces: ["model-surface"] },
            { id: "cli", title: "CLI task", checks: ["missing"], dependsOn: ["model"], files: ["src/cli.ts"] },
          ],
          render: { kind: "none" },
        }),
      ],
    });

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "change:task-graph-change:task:model", kind: "task" }),
        expect.objectContaining({ id: "change:task-graph-change:task:cli", kind: "task" }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "change:task-graph-change", to: "change:task-graph-change:task:model", kind: "contains" }),
        expect.objectContaining({ from: "change:task-graph-change:task:cli", to: "change:task-graph-change:task:model", kind: "depends-on" }),
        expect.objectContaining({ from: "change:task-graph-change:task:model", kind: "requires-check" }),
        expect.objectContaining({ from: "change:task-graph-change:task:model", to: "impact-surface:model-surface", kind: "touches" }),
      ]),
    );
    expect(graph.backlinks.surfaceToChanges["model-surface"]).toEqual(["task-graph-change"]);
    expect(graph.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-check-reference" })]));
    expect(graph.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "change-implicit-impact-surface" })]));
  });

  it("reports duplicate area ownership and missing check references", () => {
    const graph = buildDefinitionGraph({
      areas: [
        defineArea({
          id: "one",
          title: "One",
          summary: "First area.",
          owns: [{ kind: DefinitionTargetKind.Endpoint, path: "/api/company" }],
          stories: [{ id: "story", as: "user", want: "one", so: "value", acceptance: ["changes"], checks: ["missing"] }],
          checks: [{ id: "doctor", kind: "doctor" }],
          render: { kind: "none" },
        }),
        defineArea({
          id: "two",
          title: "Two",
          summary: "Second area.",
          owns: [{ kind: DefinitionTargetKind.Endpoint, path: "/api/company" }],
          render: { kind: "none" },
        }),
      ],
      changes: [],
      conventions: [],
      impactSurfaces: [],
    });

    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "duplicate-area-ownership" }),
        expect.objectContaining({ severity: "error", code: "missing-check-reference" }),
      ]),
    );
  });
});
