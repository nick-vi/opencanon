import { defineValidator } from "../../../.agents/skills/opencanon/index.ts";
import dalTransactionParam from "./dal-transaction-param.ts";
import deprecatedRequiresReplacement from "./deprecated-requires-replacement.ts";
import duplicateBoundaryLiterals from "./duplicate-boundary-literals.ts";
import folderFileNaming from "./folder-file-naming.ts";
import frameworkPackageBoundaries from "./framework-package-boundaries.ts";
import noDeepRelativeImports from "./no-deep-relative-imports.ts";
import noDbSchemaInContracts from "./no-db-schema-in-contracts.ts";
import noDumpsterFolders from "./no-dumpster-folders.ts";
import noHardcodedConfigValues from "./no-hardcoded-config-values.ts";
import noNativeEnums from "./no-native-enums.ts";
import noRouteDalImport from "./no-route-dal-import.ts";
import noSecretLikeLiterals from "./no-secret-like-literals.ts";
import noShimFiles from "./no-shim-files.ts";
import noStaleIntentComments from "./no-stale-intent-comments.ts";
import pythonNoBareExcept from "./python-no-bare-except.ts";
import pythonNoSysPathMutation from "./python-no-sys-path-mutation.ts";
import repeatedDomainLiterals from "./repeated-domain-literals.ts";
import sensitiveChangeRequiresDecision from "./sensitive-change-requires-decision.ts";
import shimRequiresExpiry from "./shim-requires-expiry.ts";
import serviceNoDbClient from "./service-no-db-client.ts";

export default defineValidator({
  id: "conventions",
  validators: [
    defineValidator({
      id: "backend",
      validators: [folderFileNaming, serviceNoDbClient, dalTransactionParam, noRouteDalImport, noDbSchemaInContracts],
    }),
    defineValidator({
      id: "typescript",
      applies: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      validators: [noNativeEnums, repeatedDomainLiterals, duplicateBoundaryLiterals, noDeepRelativeImports, frameworkPackageBoundaries],
    }),
    defineValidator({
      id: "hygiene",
      validators: [noStaleIntentComments, noShimFiles, shimRequiresExpiry, deprecatedRequiresReplacement, noDumpsterFolders, pythonNoSysPathMutation, pythonNoBareExcept],
    }),
    defineValidator({
      id: "impact",
      validators: [sensitiveChangeRequiresDecision],
    }),
    defineValidator({
      id: "security",
      validators: [noSecretLikeLiterals, noHardcodedConfigValues],
    }),
  ],
});
