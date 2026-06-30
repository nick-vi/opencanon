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

export const trustedReleaseKeys: TrustedReleaseKey[] = [
  {
    keyId: "35c13edde67e0599c6107376a48b2cd8ee09e4570d8afc8c329e7b4a75d852ce",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAe71w6rTamrI19nnyavUjeEEN2YLJj/h9rljD35sRLPE=",
  },
  {
    keyId: "3233f3e584686557aa223d5f8f31fb253b956755a953b97dbe522794e3d695f0",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEA/vfmCppkYNCxN/GxZsfMI/WH5o+2mK1HvoU7iMsVGH0=",
  },
];
