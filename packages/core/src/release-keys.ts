/**
 * Baked-in PUBLIC keys trusted to sign OpenCanon release manifests.
 *
 * These are shipped in the installed OpenCanon runtime and are the root of trust
 * for the self-hosted GitHub-Releases updater. Only the PUBLIC half lives
 * here; the matching PRIVATE key is held as a protected GitHub Actions secret and never
 * enters the repo.
 *
 * Key rotation: add the new public key to this array and ship it (so clients trust both)
 * BEFORE switching the release workflow to sign with the new private key. Remove a
 * retired key only after every supported client has updated past it.
 *
 * Generate a keypair with:
 *   node scripts/gen-release-keypair.ts
 * then paste the printed PRIVATE key into the `OPENCANON_RELEASE_PRIVATE_KEY` GitHub
 * Actions secret and the PUBLIC entry below.
 */
export type TrustedReleaseKey = {
  /** Stable id selecting this key during verification: the SHA-256 of the SPKI DER
   * public key, hex. */
  keyId: string;
  /** Ed25519 public key, SPKI DER, base64-encoded. */
  publicKeySpkiBase64: string;
  /** Set true to REVOKE a key whose private half is compromised. Verification rejects a
   * revoked key even though it is still listed (keep the entry for an audit trail until
   * every client has shipped a build without it). Revoking a baked-in key only protects
   * clients that have updated past it — sign new releases with a different key and ship a
   * runtime build that drops the revoked entry. */
  revoked?: boolean;
};

export const trustedReleaseKeys: TrustedReleaseKey[] = [];
