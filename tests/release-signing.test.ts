import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isRemoteManifestSource,
  parseSignatureSidecar,
  signatureSidecarLocation,
  verifyManifestForSource,
  verifyManifestSignature,
} from "@opencanon/core/release-manifest";
import { generateReleaseKeypair, signManifestText } from "../scripts/release-signing.ts";

const manifestText = `${JSON.stringify({ version: 1, channel: "stable", runtimeVersion: "0.4.0", requiredNode: ">=24.12.0", bundles: {} }, null, 2)}\n`;

test("a manifest signed by a trusted key verifies", () => {
  const key = generateReleaseKeypair();
  const sidecar = signManifestText(manifestText, key.privateKeyPem);
  assert.equal(sidecar.keyId, key.keyId, "signer keyId must match the generated keyId");
  const result = verifyManifestSignature(Buffer.from(manifestText, "utf8"), sidecar, [key]);
  assert.equal(result.ok, true);
});

test("tampered manifest bytes fail verification", () => {
  const key = generateReleaseKeypair();
  const sidecar = signManifestText(manifestText, key.privateKeyPem);
  const tampered = manifestText.replace("0.4.0", "9.9.9");
  const result = verifyManifestSignature(Buffer.from(tampered, "utf8"), sidecar, [key]);
  assert.equal(result.ok, false);
});

test("a signature from an untrusted key is rejected", () => {
  const signer = generateReleaseKeypair();
  const other = generateReleaseKeypair();
  const sidecar = signManifestText(manifestText, signer.privateKeyPem);
  const result = verifyManifestSignature(Buffer.from(manifestText, "utf8"), sidecar, [other]);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not trusted/);
});

test("multiple trusted keys coexist (rotation / backup): each verifies, by keyId", () => {
  const active = generateReleaseKeypair();
  const backup = generateReleaseKeypair();
  const trusted = [active, backup];
  // A manifest signed by EITHER trusted key verifies — this is what makes key rotation
  // (ship new pubkey, then switch signing key) and an offline backup key work.
  const signedByActive = signManifestText(manifestText, active.privateKeyPem);
  const signedByBackup = signManifestText(manifestText, backup.privateKeyPem);
  assert.equal(verifyManifestSignature(Buffer.from(manifestText, "utf8"), signedByActive, trusted).ok, true);
  assert.equal(verifyManifestSignature(Buffer.from(manifestText, "utf8"), signedByBackup, trusted).ok, true);
  // A third, untrusted key still fails even though two keys are trusted.
  const rogue = generateReleaseKeypair();
  assert.equal(verifyManifestSignature(Buffer.from(manifestText, "utf8"), signManifestText(manifestText, rogue.privateKeyPem), trusted).ok, false);
});

test("a revoked key is rejected even with a valid signature", () => {
  const key = generateReleaseKeypair();
  const sidecar = signManifestText(manifestText, key.privateKeyPem);
  const result = verifyManifestSignature(Buffer.from(manifestText, "utf8"), sidecar, [{ ...key, revoked: true }]);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /revoked/);
});

test("malformed / non-ed25519 sidecars are rejected without throwing", () => {
  assert.equal(parseSignatureSidecar("{ not json"), undefined);
  assert.equal(parseSignatureSidecar(JSON.stringify({ algorithm: "rsa", keyId: "x", value: "y" })), undefined);
  assert.equal(parseSignatureSidecar(JSON.stringify({ algorithm: "ed25519", keyId: 1, value: "y" })), undefined);
  const key = generateReleaseKeypair();
  const bad = verifyManifestSignature(Buffer.from(manifestText, "utf8"), { keyId: key.keyId, algorithm: "ed25519", value: "!!!notbase64!!!" }, [key]);
  assert.equal(bad.ok, false);
});

test("source policy: remote requires a valid signature, local files are exempt", () => {
  const key = generateReleaseKeypair();
  const bytes = Buffer.from(manifestText, "utf8");
  const sidecar = signManifestText(manifestText, key.privateKeyPem);

  // local/file: exempt even with no signature
  assert.equal(verifyManifestForSource("/tmp/manifest.json", bytes, undefined, [key]).ok, true);
  assert.equal(verifyManifestForSource("file:///tmp/manifest.json", bytes, undefined, [key]).ok, true);

  // remote: no signature => rejected
  assert.equal(verifyManifestForSource("https://example.com/manifest.json", bytes, undefined, [key]).ok, false);
  // remote: valid signature => accepted
  assert.equal(verifyManifestForSource("https://example.com/manifest.json", bytes, sidecar, [key]).ok, true);
  // remote: tampered => rejected
  assert.equal(verifyManifestForSource("https://example.com/manifest.json", Buffer.from(manifestText.replace("0.4.0", "1.2.3")), sidecar, [key]).ok, false);
});

test("signatureSidecarLocation appends .sig to the path, before any query", () => {
  assert.equal(signatureSidecarLocation("https://x.dev/m.json"), "https://x.dev/m.json.sig");
  assert.equal(signatureSidecarLocation("https://x.dev/m.json?token=abc"), "https://x.dev/m.json.sig?token=abc");
  assert.equal(signatureSidecarLocation("/abs/m.json"), "/abs/m.json.sig");
  assert.equal(signatureSidecarLocation("./m.json"), "./m.json.sig");
});

test("isRemoteManifestSource classifies sources", () => {
  assert.equal(isRemoteManifestSource("https://example.com/m.json"), true);
  assert.equal(isRemoteManifestSource("http://example.com/m.json"), true);
  assert.equal(isRemoteManifestSource("file:///tmp/m.json"), false);
  assert.equal(isRemoteManifestSource("./m.json"), false);
  assert.equal(isRemoteManifestSource("/abs/m.json"), false);
});
