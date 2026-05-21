export default {
  id: "security-hardcoding",
  description: "Adds validators and docs for committed secrets and environment-specific config literals.",
  topics: ["security", "configuration"],
  validators: ["no-secret-like-literals", "no-hardcoded-config-values"],
  options: {
    sourceGlobs: {
      type: "string[]",
      default: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      description: "Source globs checked by the validators.",
    },
    allowedLiterals: {
      type: "string[]",
      default: ["<generated-token>", "test-token", "localhost", "127.0.0.1"],
      description: "Literal values that are intentionally allowed.",
    },
    allowedFiles: {
      type: "string[]",
      default: ["tests/**", "examples/**"],
      description: "Files excluded from hardcoding checks.",
    },
  },
  docs: [
    {
      path: "docs/opencanon/canon/security.md",
      heading: "Hardcoded Secrets And Config",
      body: [
        "Secrets and environment-specific configuration stay out of source literals.",
        "",
        "Rules:",
        "",
        "- Do not commit API keys, bearer tokens, passwords, client secrets, private keys, or high-entropy credential strings.",
        "- Keep real secret values in a secret manager or environment variable.",
        "- Route URLs, hosts, and ports through named configuration unless they are documented local defaults or test fixtures.",
        "- Keep allowed placeholders clearly synthetic.",
      ].join("\n"),
    },
  ],
  decisions: [],
  files: [
    {
      path: ".agents/skills/opencanon/validators/security-hardcoding.ts",
      content: `import { noHardcodedConfigValues, noSecretLikeLiterals } from "../index.ts";

const sourceGlobs = "{{sourceGlobs}}".split(",").map((item) => item.trim()).filter(Boolean);
const allowedLiterals = "{{allowedLiterals}}".split(",").map((item) => item.trim()).filter(Boolean);
const allowedFiles = "{{allowedFiles}}".split(",").map((item) => item.trim()).filter(Boolean);

export const noSecretLikeLiteralsValidator = noSecretLikeLiterals({
  id: "no-secret-like-literals",
  topics: ["security", "configuration"],
  in: sourceGlobs,
  severity: "error",
  allow: allowedLiterals,
  allowFiles: allowedFiles,
  message: "Secret-like literals must not be committed.",
  docs: ["docs/opencanon/canon/security.md#hardcoded-secrets-and-config"],
});

export const noHardcodedConfigValuesValidator = noHardcodedConfigValues({
  id: "no-hardcoded-config-values",
  topics: ["configuration"],
  in: sourceGlobs,
  severity: "warning",
  kinds: ["url", "host", "port"],
  allow: allowedLiterals,
  allowFiles: allowedFiles,
  message: "Environment-specific config values should live behind named config.",
  docs: ["docs/opencanon/canon/security.md#hardcoded-secrets-and-config"],
});

export default [noSecretLikeLiteralsValidator, noHardcodedConfigValuesValidator];
`,
    },
    {
      path: ".agents/skills/opencanon/fixtures/no-secret-like-literals/valid/src/config.ts",
      content: "export const tokenPlaceholder = \"<generated-token>\";\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/no-secret-like-literals/invalid/src/config.ts",
      content: "export const apiKey = \"not-a-real-secret-value\";\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/no-hardcoded-config-values/valid/src/config.ts",
      content: "export const host = \"127.0.0.1\";\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/no-hardcoded-config-values/invalid/src/config.ts",
      content: "export const callbackUrl = \"https://api.example.com/callback\";\n",
    },
  ],
  impactSurfaces: [],
  externalTools: {},
};
