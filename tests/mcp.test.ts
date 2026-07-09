import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { test } from "vitest";
import { createAuthoringProject } from "../packages/runtime/test/support.ts";

test("opencanon mcp exposes project tools backed by the runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-mcp-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const billingSemanticAnchor = 'invoice search term';\n");
  const env = testEnv(rootDir);
  const index = spawnSync(process.execPath, [path.join(process.cwd(), "packages/cli/src/index.ts"), "project", "index", "--format", "json"], {
    cwd: rootDir,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  assert.equal(index.status, 0, index.stderr || index.stdout);

  const client = new Client({ name: "opencanon-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "packages/cli/src/index.ts"), "mcp", "--root", rootDir],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "opencanon_status"));
    assert(tools.tools.some((tool) => tool.name === "opencanon_context_search"));
    assert(tools.tools.find((tool) => tool.name === "opencanon_status")?.description?.includes("read-first"));
    assert(tools.tools.find((tool) => tool.name === "opencanon_validate")?.description?.includes("Dry-run proof"));
    assert(!tools.tools.some((tool) => /approve|install|setup/i.test(tool.name)));

    const search = await client.callTool({
      name: "opencanon_context_search",
      arguments: { query: "invoice search term", limit: 5 },
    });
    const payload = JSON.parse(textContent(search));
    assert.equal(payload.results[0]?.chunk.path, "src/company.ts");
    assert.equal(payload.results[0]?.file, "src/company.ts");
  } finally {
    await client.close().catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function testEnv(rootDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(rootDir, "global", "service.json");
  return env;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = contentItems(result)[0];
  if (!isTextContent(content)) throw new Error("Expected text MCP result.");
  return content.text;
}

function contentItems(result: Awaited<ReturnType<Client["callTool"]>>): unknown[] {
  if (!Array.isArray(result.content)) throw new Error("Expected MCP content array.");
  return result.content;
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
}
