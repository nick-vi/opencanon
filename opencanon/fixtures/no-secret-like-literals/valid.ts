import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/config.ts", `
      export const tokenPlaceholder = "<generated-token>";
      export const publicMode = "local-development";
    `),
    file.ts("packages/core/src/release-keys.ts", `
      export const trustedReleaseKeys = [
        {
          keyId: "35c13edde67e0599c6107376a48b2cd8ee09e4570d8afc8c329e7b4a75d852ce",
          publicKeySpkiBase64: "MCowBQYDK2VwAyEAe71w6rTamrI19nnyavUjeEEN2YLJj/h9rljD35sRLPE=",
        },
      ];
    `),
  ],
});
