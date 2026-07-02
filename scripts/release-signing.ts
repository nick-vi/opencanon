import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import type { ManifestSignatureSidecar } from "@opencanon/core/release-manifest";

/** Stable id for a public key: the full SHA-256 of its SPKI DER (hex). This MUST match
 * how `trustedReleaseKeys` entries are produced (gen-release-keypair) and is what the
 * verifier matches `signature.keyId` against. The id only SELECTS a candidate key — the
 * signature still has to verify cryptographically — but using the full digest removes
 * any theoretical collision concern outright. */
export function deriveKeyId(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("hex");
}

export function publicKeySpkiBase64(publicKey: KeyObject): string {
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
}

/** Produce the detached-signature sidecar for the EXACT manifest bytes. */
export function signManifestText(manifestText: string, privateKeyPem: string): ManifestSignatureSidecar {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey({ key: privateKey.export({ type: "pkcs8", format: "pem" }), format: "pem" });
  // Ed25519: the algorithm argument MUST be null.
  const signature = cryptoSign(null, Buffer.from(manifestText, "utf8"), { key: privateKey });
  return { keyId: deriveKeyId(publicKey), algorithm: "ed25519", value: signature.toString("base64") };
}

export function generateReleaseKeypair(): { privateKeyPem: string; publicKeySpkiBase64: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiBase64: publicKeySpkiBase64(publicKey),
    keyId: deriveKeyId(publicKey),
  };
}
