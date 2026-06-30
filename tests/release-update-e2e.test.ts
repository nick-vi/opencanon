import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { applyRuntimeUpdate, checkRuntimeUpdate, currentEngineTarget, engineRuntimePathForTarget, type UpdateSafetyGuard } from "@opencanon/distribution";
// Reach into the source list directly — it is intentionally NOT part of the public API
// (a mutable trust root must not be exposed); the test injects a key for the duration.
import { trustedReleaseKeys } from "../packages/core/src/release-keys.ts";
import { generateReleaseKeypair, signManifestText } from "../scripts/release-signing.ts";

// End-to-end proof of the ENFORCED remote-signed install path: a real HTTPS server serves
// a signed manifest + sidecar + bundle, and the runtime's update path is driven over the
// wire (fetchTrusted -> sidecar fetch -> verify-before-parse -> sha256 -> safeExtract).

const target = currentEngineTarget();
let server: Server;
let baseUrl: string;
let workDir: string;
const key = generateReleaseKeypair();
let tlsRejectBefore: string | undefined;
let registryPathBefore: string | undefined;
const routes = new Map<string, { body: Buffer; type: string }>();
const updateSafety: UpdateSafetyGuard = {
  assertSafeToUpdate() {},
};

function buildBundle(): Buffer {
  const stage = path.join(workDir, "stage");
  const enginePath = engineRuntimePathForTarget(stage, target);
  mkdirSync(path.dirname(enginePath), { recursive: true });
  writeFileSync(path.join(stage, "cli.js"), "export const runtime = true;\n");
  writeFileSync(path.join(stage, "validators.js"), "export const validators = true;\n");
  writeFileSync(enginePath, "engine");
  const archivePath = path.join(workDir, "bundle.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", stage, "."]).status, 0, "could not build bundle");
  return readFileSync(archivePath);
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "opencanon-e2e-"));
  // Self-signed cert for the loopback server; accept it for the duration of this file.
  const keyPath = path.join(workDir, "tls.key");
  const certPath = path.join(workDir, "tls.crt");
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost",
  ], { encoding: "utf8" });
  assert.equal(openssl.status, 0, `openssl failed: ${openssl.stderr}`);
  tlsRejectBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  registryPathBefore = process.env.OPENCANON_SERVICE_REGISTRY_PATH;
  process.env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(workDir, "service.json");

  // Trust the test signing key for the duration of this file.
  trustedReleaseKeys.push({ keyId: key.keyId, publicKeySpkiBase64: key.publicKeySpkiBase64 });

  const bundle = buildBundle();
  const manifestText = `${JSON.stringify({
    version: 1,
    channel: "stable",
    runtimeVersion: "9.9.9",
    requiredNode: ">=24.12.0",
    bundles: { [target]: { url: "bundle.tar.gz", sha256: createHash("sha256").update(bundle).digest("hex") } },
  }, null, 2)}\n`;
  const sidecar = `${JSON.stringify(signManifestText(manifestText, key.privateKeyPem), null, 2)}\n`;

  routes.set("/opencanon-runtime-manifest.json", { body: Buffer.from(manifestText), type: "application/json" });
  routes.set("/opencanon-runtime-manifest.json.sig", { body: Buffer.from(sidecar), type: "application/json" });
  routes.set("/bundle.tar.gz", { body: bundle, type: "application/gzip" });
  // A manifest whose bytes were tampered after signing (sidecar no longer matches).
  routes.set("/tampered.json", { body: Buffer.from(manifestText.replace("9.9.9", "9.9.8")), type: "application/json" });
  routes.set("/tampered.json.sig", { body: Buffer.from(sidecar), type: "application/json" });
  // A manifest with no sidecar at all.
  routes.set("/unsigned.json", { body: Buffer.from(manifestText), type: "application/json" });

  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const route = routes.get(new URL(req.url ?? "/", "https://localhost").pathname);
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.type }).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  baseUrl = `https://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  trustedReleaseKeys.length = 0;
  if (tlsRejectBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsRejectBefore;
  if (registryPathBefore === undefined) delete process.env.OPENCANON_SERVICE_REGISTRY_PATH;
  else process.env.OPENCANON_SERVICE_REGISTRY_PATH = registryPathBefore;
  rmSync(workDir, { recursive: true, force: true });
});

test("a signed remote manifest installs over HTTPS end to end", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencanon-e2e-install-"));
  const runtimeRoot = path.join(root, "runtime");
  try {
    const result = await applyRuntimeUpdate({
      manifestSource: `${baseUrl}/opencanon-runtime-manifest.json`,
      cwd: root,
      runtimeRoot,
      safety: updateSafety,
    });
    assert.equal(result.status, "installed");
    assert(existsSync(path.join(runtimeRoot, "cli.js")), "bundle should be extracted");
    assert(existsSync(engineRuntimePathForTarget(runtimeRoot, target)), "engine binary should be present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remote manifest with no signature sidecar is rejected", async () => {
  await assert.rejects(
    () => checkRuntimeUpdate({ manifestSource: `${baseUrl}/unsigned.json` }),
    /signature could not be verified/,
  );
});

test("a tampered remote manifest (sidecar no longer matches) is rejected", async () => {
  await assert.rejects(
    () => checkRuntimeUpdate({ manifestSource: `${baseUrl}/tampered.json` }),
    /signature could not be verified/,
  );
});
