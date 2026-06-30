import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { trustedReleaseKeys } from "./release-keys.ts";

/**
 * Authenticity layer for the self-hosted GitHub-Releases updater.
 *
 * The release manifest pins, per platform target, the bundle URL and its SHA-256. The
 * bootstrap already verifies the downloaded bundle against that SHA-256 (integrity).
 * This module adds AUTHENTICITY: a DETACHED Ed25519 signature over the EXACT manifest
 * bytes, published as a sibling `<manifest>.sig` release asset. A tampered or forged
 * manifest (e.g. an attacker who can write to the GitHub release) is rejected unless it
 * was signed with a private key whose PUBLIC key we ship baked into the installed runtime.
 *
 * Why sign raw bytes (not a canonical re-serialization): re-canonicalizing a parsed
 * object is a footgun — JSON `__proto__` keys, number/unicode normalization, dropped or
 * reshaped fields all let an attacker mutate something the signer never saw while the
 * recomputed bytes still match. Signing the bytes on the wire and verifying BEFORE
 * parsing eliminates that entire class (and the parser never touches unverified input).
 *
 * Trust rules (deliberately strict):
 *  - The signing algorithm is hardcoded to Ed25519. The sidecar does NOT get to choose.
 *  - `keyId` only SELECTS among the baked-in trusted keys; a key is never taken from the
 *    sidecar. Unknown keyId => reject.
 *  - Verification never throws on malformed input — it returns a reason so callers shape
 *    their own diagnostics and a crafted key/sig cannot bypass via an exception.
 *  - Rollback/downgrade is handled by the caller (monotonic runtimeVersion check) since the
 *    version lives inside the now-verified manifest.
 */

export type ManifestSignatureSidecar = {
  keyId: string;
  algorithm: "ed25519";
  value: string; // base64 detached Ed25519 signature over the raw manifest bytes
};

export type ManifestVerification = { ok: true } | { ok: false; reason: string };

/**
 * Whether a manifest source must carry a verified signature.
 *
 * The threat we defend is a tampered/forged manifest served over the network (e.g. a
 * compromised GitHub release). A `file:`/local-path manifest is provided directly by the
 * operator on their own machine — anyone who can plant that file already has local
 * filesystem access and could replace the runtime outright, so requiring a signature
 * there adds no security but breaks local/dev/test installs. So: enforce for http(s),
 * exempt for file/local.
 */
export function isRemoteManifestSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Location of the detached-signature sidecar for a manifest source. Shared by the updater
 * and manifest verifier so the two can't drift. For URLs the `.sig` suffix is appended to the
 * PATH (before any query/hash) so the sibling asset resolves even when the manifest URL
 * carries query parameters; for local paths it is a plain suffix.
 */
export function signatureSidecarLocation(source: string): string {
  try {
    const url = new URL(source);
    url.pathname = `${url.pathname}.sig`;
    return url.toString();
  } catch {
    return `${source}.sig`;
  }
}

/** Parse the `<manifest>.sig` sidecar JSON. Returns undefined (not throw) on any defect. */
export function parseSignatureSidecar(text: string): ManifestSignatureSidecar | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.algorithm !== "ed25519") return undefined;
  if (typeof candidate.keyId !== "string" || typeof candidate.value !== "string") return undefined;
  return { keyId: candidate.keyId, algorithm: "ed25519", value: candidate.value };
}

/**
 * Verify a detached Ed25519 signature over the exact `manifestBytes` against the
 * baked-in trusted keys. Pure and offline. MUST be called before the manifest bytes are
 * parsed or any field is trusted.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signature: ManifestSignatureSidecar | undefined,
  trustedKeys: readonly { keyId: string; publicKeySpkiBase64: string; revoked?: boolean }[] = trustedReleaseKeys,
): ManifestVerification {
  if (!signature) return { ok: false, reason: "manifest signature sidecar is missing or malformed" };
  if (signature.algorithm !== "ed25519") return { ok: false, reason: `unsupported signature algorithm: ${String(signature.algorithm)}` };

  const trusted = trustedKeys.find((key) => key.keyId === signature.keyId);
  if (!trusted) return { ok: false, reason: `signature keyId is not trusted: ${signature.keyId}` };
  if (trusted.revoked) return { ok: false, reason: `signature keyId is revoked: ${signature.keyId}` };

  try {
    const signatureBytes = Buffer.from(signature.value, "base64");
    if (signatureBytes.length !== 64) return { ok: false, reason: "signature has wrong length for Ed25519" };
    const publicKey = createPublicKey({ key: Buffer.from(trusted.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
    // Ed25519: the algorithm argument to crypto.verify MUST be null.
    const valid = cryptoVerify(null, manifestBytes, publicKey, signatureBytes);
    return valid ? { ok: true } : { ok: false, reason: "signature does not match any trusted key" };
  } catch (error) {
    return { ok: false, reason: `signature verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Apply the source-based policy: REMOTE (http/s) manifests must carry a valid signature;
 * local/file manifests are exempt (operator-trusted). Single entry point used by both the
 * installed runtime update path so local and remote policy can't drift.
 */
export function verifyManifestForSource(
  source: string,
  manifestBytes: Buffer,
  signature: ManifestSignatureSidecar | undefined,
  trustedKeys: readonly { keyId: string; publicKeySpkiBase64: string; revoked?: boolean }[] = trustedReleaseKeys,
): ManifestVerification {
  if (!isRemoteManifestSource(source)) return { ok: true };
  return verifyManifestSignature(manifestBytes, signature, trustedKeys);
}
