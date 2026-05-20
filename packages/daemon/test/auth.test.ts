import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { daemonAuthHeaders, normalizeDaemonPort, startOpenCanonDaemon } from "@opencanon/daemon";
import { daemonAuthCookieHeader, assertSafeDaemonHost, isAuthorizedDaemonRequest, usableDaemonAuthToken } from "../src/auth.ts";

test("daemon start accepts numeric and string port options", () => {
  assert.equal(normalizeDaemonPort(undefined), undefined);
  assert.equal(normalizeDaemonPort(4768), 4768);
  assert.equal(normalizeDaemonPort("4768"), 4768);
});

test("daemon start rejects unknown config fields", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-daemon-config-"));
  try {
    const staleField = "sections" + "Path";
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", [staleField]: "unused" }));

    await assert.rejects(() => startOpenCanonDaemon({ cwd: rootDir, port: 0, serveUi: false }), /Unknown config field/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon auth accepts bearer headers and limits query tokens to explicit opt-in", () => {
  const token = "test-token";
  const route = new URL("http://127.0.0.1:4767/api/snapshot");
  const bootstrap = new URL(`http://127.0.0.1:4767/?token=${token}`);

  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString()), route, token), false);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString(), { headers: daemonAuthHeaders(token) }), route, token), true);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString(), { headers: { cookie: daemonAuthCookieHeader(token, false) } }), route, token), true);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString(), { headers: { cookie: "opencanon_daemon_token=%E0%A4%A" } }), route, token), false);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString()), route, token, { allowQueryToken: true }), false);
  assert.equal(isAuthorizedDaemonRequest(new Request(bootstrap.toString()), bootstrap, token, { allowQueryToken: true }), true);
});

test("daemon auth rejects empty configured tokens", () => {
  const route = new URL("http://127.0.0.1:4767/api/snapshot?token=");

  assert.equal(usableDaemonAuthToken(""), undefined);
  assert.equal(usableDaemonAuthToken("   "), undefined);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString(), { headers: { authorization: "Bearer " } }), route, ""), false);
  assert.equal(isAuthorizedDaemonRequest(new Request(route.toString()), route, "", { allowQueryToken: true }), false);
});

test("daemon host binding requires explicit remote opt-in", () => {
  assert.doesNotThrow(() => assertSafeDaemonHost("127.0.0.1"));
  assert.doesNotThrow(() => assertSafeDaemonHost("::1"));
  assert.throws(() => assertSafeDaemonHost("0.0.0.0"), /allow-remote/);
  assert.doesNotThrow(() => assertSafeDaemonHost("0.0.0.0", true));
});
