#!/usr/bin/env node
import { generateReleaseKeypair } from "./release-signing.ts";

// Generates an Ed25519 release-signing keypair. The PRIVATE key is printed once and
// never stored by this script — paste it into the GitHub Actions secret. The PUBLIC
// entry is committed into packages/core/src/release-keys.ts so shipped clients trust it.
const { privateKeyPem, publicKeySpkiBase64, keyId } = generateReleaseKeypair();

console.log(`# OpenCanon release signing keypair  (keyId: ${keyId})`);
console.log("#");
console.log("# 1) Store the PRIVATE key as the GitHub Actions secret OPENCANON_RELEASE_PRIVATE_KEY");
console.log("#    (Settings > Secrets and variables > Actions). Do NOT commit it.");
console.log("# ----- BEGIN PRIVATE KEY (secret) -----");
process.stdout.write(privateKeyPem.endsWith("\n") ? privateKeyPem : `${privateKeyPem}\n`);
console.log("# ----- END PRIVATE KEY (secret) -----");
console.log("#");
console.log("# 2) Add this entry to trustedReleaseKeys in packages/core/src/release-keys.ts:");
console.log(JSON.stringify({ keyId, publicKeySpkiBase64 }, null, 2));
