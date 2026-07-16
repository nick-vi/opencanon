import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runtimeAuthHeaders, normalizeRuntimePort, startOpenCanonRuntime } from "@opencanon/runtime";
import { runtimeAuthCookieHeader, assertSafeRuntimeHost, isAuthorizedRuntimeRequest, usableRuntimeAuthToken } from "../src/auth.ts";
import { createAuthoringProject } from "./support.ts";

test("runtime start accepts numeric and string port options", () => {
  assert.equal(normalizeRuntimePort(undefined), undefined);
  assert.equal(normalizeRuntimePort(4768), 4768);
  assert.equal(normalizeRuntimePort("4768"), 4768);
});

test("runtime start rejects unknown config fields", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-config-"));
  try {
    const staleField = "sections" + "Path";
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", [staleField]: "unused" }));

    await assert.rejects(() => startOpenCanonRuntime({ cwd: rootDir, port: 0 }), /Unknown config field/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime auth accepts bearer headers and limits query tokens to explicit opt-in", () => {
  const token = "test-token";
  const route = new URL("http://127.0.0.1:4767/api/snapshot");
  const bootstrap = new URL(`http://127.0.0.1:4767/?token=${token}`);

  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString()), route, token), false);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString(), { headers: runtimeAuthHeaders(token) }), route, token), true);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString(), { headers: { cookie: runtimeAuthCookieHeader(token, false) } }), route, token), true);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString(), { headers: { cookie: "opencanon_runtime_token=%E0%A4%A" } }), route, token), false);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString()), route, token, { allowQueryToken: true }), false);
  assert.equal(isAuthorizedRuntimeRequest(new Request(bootstrap.toString()), bootstrap, token, { allowQueryToken: true }), true);
});

test("runtime auth rejects empty configured tokens", () => {
  const route = new URL("http://127.0.0.1:4767/api/snapshot?token=");

  assert.equal(usableRuntimeAuthToken(""), undefined);
  assert.equal(usableRuntimeAuthToken("   "), undefined);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString(), { headers: { authorization: "Bearer " } }), route, ""), false);
  assert.equal(isAuthorizedRuntimeRequest(new Request(route.toString()), route, "", { allowQueryToken: true }), false);
});

test("runtime host binding requires explicit remote opt-in", () => {
  assert.doesNotThrow(() => assertSafeRuntimeHost("127.0.0.1"));
  assert.doesNotThrow(() => assertSafeRuntimeHost("::1"));
  assert.throws(() => assertSafeRuntimeHost("0.0.0.0"), /allow-remote/);
  assert.doesNotThrow(() => assertSafeRuntimeHost("0.0.0.0", true));
});

test("runtime node http server reports ephemeral ports and cancels SSE streams", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-sse-"));
  createAuthoringProject(rootDir);
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "",
      "export default defineConvention({",
      "  id: \"conventions\",",
      "  title: \"Conventions\",",
      "  topics: [\"test\"],",
      "  rule: \"Conventions.\",",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"none\" },",
      "  runtime: {",
      "    kind: \"validator\",",
      "    severity: \"warning\",",
      "    scope: \"project\",",
      "    facts: [],",
      "    validate() { return []; },",
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const boundUrl = new URL(server.url);
      assert.notEqual(boundUrl.port, "0");

      const abortController = new AbortController();
      const response = await fetch(`${server.url}/api/events/stream`, {
        headers: runtimeAuthHeaders(server.authToken),
        signal: abortController.signal,
      });
      assert.equal(response.status, 200);
      assert(response.headers.get("content-type")?.startsWith("text/event-stream"));
      assert(response.body, "SSE response should have a body");
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value).trim(), ": connected");
      await reader.cancel();
      abortController.abort();
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
