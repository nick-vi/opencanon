# Runtime Update Security

How OpenCanon protects the self-hosted GitHub-Releases installer/updater, and the
deliberate boundaries of that protection. Implementation:
`packages/core/src/release-manifest.ts`, `packages/core/src/release-keys.ts`,
`scripts/opencanon-install.mjs`, the installed runtime, and the updater code under
`packages/distribution/src/update.ts`.

## Trust chain

An official remote install/update trusts a release only if **all** hold:

1. **Authenticity** — the manifest carries a detached Ed25519 signature
   (`<manifest>.sig`) made by a private key whose public half is baked into the installed
   runtime and release-rendered bootstrap installer (`trustedReleaseKeys`). Verified
   with `node:crypto`, over the EXACT manifest bytes, BEFORE the manifest is parsed.
2. **Integrity** — the downloaded bundle's SHA-256 matches the (now-authenticated)
   manifest.
3. **Safe extraction** — the installed updater extracts with a link/device-rejecting,
   traversal-safe extractor (`safeExtract`, node-tar). The standalone bootstrap
   installer preflights archive paths before system-tar extraction because it has no
   package dependencies.
4. **No downgrade** — `applyRuntimeUpdate` refuses an older `runtimeVersion` than the one
   already installed. First install has no prior marker, so there is nothing to
   downgrade from.
5. **No live runtime swap** — `opencanon update apply` refuses while the global service
   or any registered project runtime is running, so the runtime directory is not replaced
   underneath active OpenCanon processes.
6. **No implicit project mutation** — runtime update installs runtime assets only. When
   the runtime changes managed project artifacts, the apply result reports the explicit
   project action: run `opencanon doctor --fix` in initialized projects. Doctor remains
   the single writer for managed agent guidance, agent entry blocks, generated authoring
   files, and install metadata.

Signature verification policy is shared by the distribution module and mirrored in the
release-rendered standalone installer; `create-opencanon-release` injects the same
trusted public keys into the installer asset.

## Decided boundaries (not "TODO" — chosen)

### Remote signatures are mandatory; local `file:`/path manifests are exempt
The threat is a tampered manifest served over the network. A local manifest is provided
directly by the operator; anyone able to plant that file already has filesystem access and
could replace the runtime outright, so a signature there adds no protection while breaking
dev/test/CI installs. Enforcement keys on URL scheme (`isRemoteManifestSource`).

### No manifest expiry / not-before
Metadata expiry (TUF-style) only adds safety when paired with an **online** metadata
refresh that re-issues fresh signed timestamps. This updater verifies **offline**. An
expiry field with no refresh service is a footgun: it bricks every client the moment a
release cadence lapses, for zero attacker cost. We therefore do not add one. Downgrade is
handled by the monotonic version check instead.

### Freeze attacks are mitigated, not eliminated
An attacker who controls the network can serve an old-but-genuinely-signed manifest to
**stall** a client on a current-but-outdated version (without downgrading it). Fully
solving this needs a trusted online "latest version" signal (TUF timestamp role), which an
offline GH-Releases updater does not have. Mitigations in place: HTTPS-only fetch, the
monotonic-version downgrade block, and operator visibility via `opencanon project check` /
`update check`. Accepted residual for an offline updater.

### keyId is the full SHA-256 of the public key
It only selects a candidate key (the signature must still verify), but using the full
digest removes any collision question outright.

## Operator runbook

### One-time key setup (REQUIRED before the first real release)

`trustedReleaseKeys` ships **empty**, so remote installs **fail closed** until this is
done. The signing layer is dormant until then — and pushing a release without finishing
this makes remote installs fail (correctly, but they fail). Do all of it once:

1. **Generate two keypairs** — an active signer and an offline backup. Run twice:
   ```bash
   npm run release:keygen   # active
   npm run release:keygen   # backup (store private key OFFLINE, not in CI)
   ```
2. **Commit both public entries** to `trustedReleaseKeys` in
   `packages/core/src/release-keys.ts`. Shipping the backup pubkey from day one means a
   compromise of the active key is recoverable by signing with the backup — no flag-day,
   no client left stranded.
3. **Store only the ACTIVE private key** in CI as the `OPENCANON_RELEASE_PRIVATE_KEY`
   secret. The backup private key stays offline (paper / hardware / password manager).
4. **Protect the secret with a GitHub Environment.** The `publish-release` job already
   declares `environment: release`, so put `OPENCANON_RELEASE_PRIVATE_KEY` in a `release`
   Environment (repo Settings → Environments), not in plain repo secrets, and add
   **required reviewers** + a tag restriction. Each signed release then needs explicit
   human approval, shrinking the blast radius of a leaked token. (Until you configure it,
   the environment exists but is unprotected — harmless, just no gate.)
5. **Publish the public-key fingerprint out of band.** Each `release:keygen` prints a
   `keyId` (the full SHA-256 of the SPKI public key) — that IS the fingerprint. Put it in
   the README / docs site so users can confirm the baked-in key matches an
   independently-published value (TOFU mitigation against a poisoned runtime build).

### Rotation
1. Add the new public key to `trustedReleaseKeys` and ship a release (clients now trust
   both old and new).
2. Switch the `OPENCANON_RELEASE_PRIVATE_KEY` secret to the new private key.
3. Remove the old public entry only after every supported client has updated past step 1.

### Revocation (private key compromised)
1. Set `revoked: true` on the compromised entry (keep it listed for the audit trail) and
   start signing with a different key; ship that release.
2. Verification rejects a revoked key even if the sidecar presents it. Note this only
   protects clients that have **updated past** the revoking build — a client still running
   the compromised runtime trusts the key until it updates through a path you control.

## Build-side hardening
- `npm ci` (lockfile-enforced) in all workflows.
- `npm audit --omit=dev --audit-level=high` gates shipped dependencies (e.g. node-tar).
- `--require-signature` makes an unsigned release a hard CI failure.
- GitHub build-provenance attestation (`actions/attest`) ties release assets to the
  workflow + commit; verify with `gh attestation verify`.
- Release publishing resolves the pushed tag to its commit SHA and waits for the matching
  GitHub Actions run before watching it, so the script does not mistake GitHub's workflow
  visibility delay for a failed release.
