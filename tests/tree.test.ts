import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { createValidationContext, tree, validateTreeDefinition } from "@opencanon/core";
import type { Finding, TreeDefinition, ValidationContext } from "@opencanon/core";

type SourceFiles = Record<string, string>;

const validator = {
  id: "tree-test",
  severity: "error" as const,
};

const serviceFileRules = {
  files: {
    match: "**/*.{ts,tsx}",
    suffix: [".service.ts", ".service.tsx"],
    allowNames: ["index.ts", "index.tsx"],
  },
};

const structureFolders = {
  folders: {
    denyNames: ["misc", "common"],
  },
};

test("file suffix rules support nested children and wildcard keys", () => {
  const findings = validate(
    {
      "src/services/company.ts": "export function getCompany() {}",
      "src/services/company.service.ts": "export function getCompany() {}",
      "src/services/index.ts": "export * from './company.service.ts';",
      "packages/billing/src/services/invoice.ts": "export function getInvoice() {}",
      "packages/billing/src/services/invoice.service.ts": "export function getInvoice() {}",
    },
    ["src/services/company.ts", "src/services/company.service.ts", "src/services/index.ts", "packages/billing/src/services/invoice.ts"],
    {
      src: {
        children: {
          services: serviceFileRules,
        },
      },
      "packages/*/src": {
        children: {
          services: serviceFileRules,
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["packages/billing/src/services/invoice.ts", "src/services/company.ts"]);
});

test("folder deny rules report matching target folders only", () => {
  const findings = validate(
    {
      "src/misc/company.ts": "export const company = {};",
      "src/services/company.service.ts": "export const company = {};",
      "packages/billing/src/common/invoice.ts": "export const invoice = {};",
    },
    ["src/misc/company.ts", "src/services/company.service.ts", "packages/billing/src/common/invoice.ts"],
    {
      src: structureFolders,
      "packages/*/src": structureFolders,
    },
  );

  assert.deepEqual(paths(findings), ["packages/billing/src/common", "src/misc"]);
});

test("import maxRelativeDepth reports deep relative imports", () => {
  const findings = validate(
    {
      "src/api/routes/companies.ts": "import { findCompany } from '../../db/dal/company.ts';\nexport { findCompany };",
      "src/db/dal/company.ts": "export function findCompany() {}",
      "src/features/company/index.ts": "import { format } from './format.ts';\nexport { format };",
      "src/features/company/format.ts": "export function format() {}",
    },
    ["src/api/routes/companies.ts", "src/features/company/index.ts"],
    {
      src: {
        imports: {
          maxRelativeDepth: 1,
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["src/api/routes/companies.ts"]);
});

test("path import deny rules report denied resolved imports", () => {
  const findings = validate(
    {
      "src/services/company.service.ts": "import { db } from '../db/client.ts';\nexport const company = db();",
      "src/db/client.ts": "export function db() { return {}; }",
    },
    ["src/services/company.service.ts"],
    {
      src: {
        children: {
          services: {
            imports: {
              deny: ["src/db/client.ts"],
            },
          },
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["src/services/company.service.ts"]);
});

test("path import allow rules report imports outside allowed globs", () => {
  const findings = validate(
    {
      "src/api/routes/companies.ts":
        "import { getCompany } from '../../services/company.service.ts';\nimport { findCompany } from '../../db/dal/company.ts';\nexport { getCompany, findCompany };",
      "src/services/company.service.ts": "export function getCompany() {}",
      "src/db/dal/company.ts": "export function findCompany() {}",
    },
    ["src/api/routes/companies.ts"],
    {
      src: {
        children: {
          "api/routes": {
            imports: {
              allow: ["src/services/**/*.{ts,tsx}"],
            },
          },
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["src/api/routes/companies.ts"]);
});

test("path import deny rules report unresolved source matches", () => {
  const findings = validate(
    {
      "src/services/company.service.ts": "import { db } from '@internal/db/client';\nexport const company = db();",
    },
    ["src/services/company.service.ts"],
    {
      "src/services": {
        imports: {
          deny: ["@internal/db/client"],
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["src/services/company.service.ts"]);
});

test("tree rule docs combine node docs and rule docs", () => {
  const findings = validate(
    {
      "src/services/company.ts": "export function getCompany() {}",
    },
    ["src/services/company.ts"],
    {
      "src/services": {
        docs: ["node-doc"],
        files: {
          suffix: [".service.ts"],
          docs: ["rule-doc"],
        },
      },
    },
  );

  assert.deepEqual(findings[0]?.docs, ["node-doc", "rule-doc"]);
});

test("named boundary deny rules report denied node imports", () => {
  const findings = validate(
    {
      "src/api/routes/companies.ts": "import { findCompany } from '../../db/dal/company.ts';\nexport { findCompany };",
      "src/db/dal/company.ts": "export function findCompany() {}",
    },
    ["src/api/routes/companies.ts"],
    {
      nodes: {
        routes: "src/api/routes/**/*.{ts,tsx}",
        dal: "src/db/dal/**/*.{ts,tsx}",
      },
      boundaries: [
        {
          from: "routes",
          deny: ["dal"],
        },
      ],
    },
  );

  assert.deepEqual(paths(findings), ["src/api/routes/companies.ts"]);
});

test("named boundary allow rules report imports outside allowed nodes", () => {
  const findings = validate(
    {
      "src/api/routes/companies.ts": "import { getCompany } from '../../services/company.service.ts';\nimport { findCompany } from '../../db/dal/company.ts';\nexport { getCompany, findCompany };",
      "src/services/company.service.ts": "export function getCompany() {}",
      "src/db/dal/company.ts": "export function findCompany() {}",
    },
    ["src/api/routes/companies.ts"],
    {
      nodes: {
        routes: "src/api/routes/**/*.{ts,tsx}",
        services: "src/services/**/*.{ts,tsx}",
      },
      boundaries: [
        {
          from: "routes",
          allow: ["services"],
        },
      ],
    },
  );

  assert.deepEqual(paths(findings), ["src/api/routes/companies.ts"]);
});

test("named boundary rules support monorepo wildcard nodes", () => {
  const findings = validate(
    {
      "packages/billing/src/api/routes/invoices.ts":
        "import { getInvoice } from '../../services/invoice.service.ts';\nimport { findInvoice } from '../../db/dal/invoice.ts';\nexport { getInvoice, findInvoice };",
      "packages/billing/src/services/invoice.service.ts": "export function getInvoice() {}",
      "packages/billing/src/db/dal/invoice.ts": "export function findInvoice() {}",
    },
    ["packages/billing/src/api/routes/invoices.ts"],
    {
      nodes: {
        routes: "packages/*/src/api/routes/**/*.{ts,tsx}",
        services: "packages/*/src/services/**/*.{ts,tsx}",
      },
      boundaries: [
        {
          from: "routes",
          allow: ["services"],
        },
      ],
    },
  );

  assert.deepEqual(paths(findings), ["packages/billing/src/api/routes/invoices.ts"]);
});

test("tree graph definitions support paths with named boundaries", () => {
  const findings = validate(
    {
      "src/api/routes/companies.ts": "import { findCompany } from '../../db/dal/company.ts';\nexport { findCompany };",
      "src/db/dal/company.ts": "export function findCompany() {}",
      "src/services/company.ts": "export function getCompany() {}",
    },
    ["src/api/routes/companies.ts", "src/services/company.ts"],
    {
      paths: {
        src: {
          children: {
            services: serviceFileRules,
          },
        },
      },
      nodes: {
        routes: "src/api/routes/**/*.{ts,tsx}",
        dal: "src/db/dal/**/*.{ts,tsx}",
      },
      boundaries: [
        {
          from: "routes",
          deny: ["dal"],
        },
      ],
    },
  );

  assert.deepEqual(paths(findings), ["src/api/routes/companies.ts", "src/services/company.ts"]);
});

test("tree helper can be used as a validator function", () => {
  const findings = withContext(
    {
      "src/services/company.ts": "export function getCompany() {}",
    },
    ["src/services/company.ts"],
    (ctx) =>
      tree({
        src: {
          children: {
            services: serviceFileRules,
          },
        },
      })({ ctx, runtime: {} as any }),
  );

  assert.deepEqual(paths(findings), ["src/services/company.ts"]);
});

test("tree rules only report target files", () => {
  const findings = validate(
    {
      "src/services/company.ts": "export function getCompany() {}",
      "src/services/invoice.ts": "export function getInvoice() {}",
    },
    ["src/services/company.ts"],
    {
      src: {
        children: {
          services: serviceFileRules,
        },
      },
    },
  );

  assert.deepEqual(paths(findings), ["src/services/company.ts"]);
});

test("tree definition diagnostics catch invalid shapes", () => {
  const diagnostics = validateTreeDefinition({
    nodes: {
      routes: [],
    },
    boundaries: [
      {
        from: "routes",
        deny: ["missing"],
      },
    ],
  });

  assert(diagnostics.includes("Tree node routes needs at least one glob pattern."));
  assert(diagnostics.includes("Tree boundary 1 deny references unknown tree node: missing."));
});

test("tree definition diagnostics catch graph shape errors", () => {
  const graphDiagnostics = validateTreeDefinition({
    paths: "bad",
    nodes: "bad",
    boundaries: "bad",
    unexpected: true,
  });

  assert(graphDiagnostics.includes("Unknown tree graph key: unexpected."));
  assert(graphDiagnostics.includes("Tree paths must be an object when present."));
  assert(graphDiagnostics.includes("Tree nodes must be an object when present."));
  assert(graphDiagnostics.includes("Tree boundaries must be an array when present."));

  const boundaryDiagnostics = validateTreeDefinition({
    nodes: {
      routes: "src/@(routes)/**",
    },
    boundaries: [
      {
        from: "missing",
        allow: ["routes"],
        deny: ["routes"],
      },
    ],
  });

  assert(boundaryDiagnostics.some((diagnostic) => diagnostic.includes("Extglob syntax is disabled: src/@(routes)/**")));
  assert(boundaryDiagnostics.includes("Tree boundary 1 from references unknown tree node: missing."));
  assert(boundaryDiagnostics.includes("Tree boundary 1 both allows and denies routes."));
});

test("tree definition diagnostics catch unknown rule keys", () => {
  const diagnostics = validateTreeDefinition({
    src: {
      files: {
        suffix: [".service.ts"],
        unexpected: true,
      },
      children: {
        services: {
          imports: {
            maxRelativeDepth: 1,
            unknownImportRule: true,
          },
        },
      },
    },
  });

  assert(diagnostics.includes("Tree path src files has unknown key: unexpected."));
  assert(diagnostics.includes("Tree path src/services imports has unknown key: unknownImportRule."));
});

test("invalid ctx.tree definitions emit validator findings", () => {
  const findings = validate(
    {
      "src/services/company.service.ts": "export function getCompany() {}",
    },
    ["src/services/company.service.ts"],
    {
      nodes: {
        services: "src/services/**/*.{ts,tsx}",
      },
      boundaries: [
        {
          from: "services",
          deny: ["unknown-node"],
        },
      ],
    },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "<tree-definition>");
  assert.match(findings[0]?.message ?? "", /unknown-node/);
});

function validate(files: SourceFiles, targetFiles: string[], definition: TreeDefinition): Finding[] {
  return withContext(files, targetFiles, (ctx) => ctx.tree(definition));
}

function withContext<T>(files: SourceFiles, targetFiles: string[], callback: (ctx: ValidationContext) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-tree-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      const absolutePath = path.join(rootDir, file);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, text);
    }

    const ctx = createValidationContext({
      rootDir,
      files: Object.keys(files),
      targetFiles,
      validator,
    });

    return callback(ctx);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function paths(findings: Finding[]): string[] {
  return findings.map((finding) => finding.file).sort();
}
