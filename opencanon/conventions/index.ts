import docsOnlyConventions from "./docs-only-conventions.ts";
import dalTransactionParam from "./dal-transaction-param.ts";
import deprecatedRequiresReplacement from "./deprecated-requires-replacement.ts";
import duplicateBoundaryLiterals from "./duplicate-boundary-literals.ts";
import explicitErrorContracts from "./explicit-error-contracts.ts";
import folderFileNaming from "./folder-file-naming.ts";
import frameworkPackageBoundaries from "./framework-package-boundaries.ts";
import inlineSoftEnumLiteral from "./inline-soft-enum-literal.ts";
import noDeepRelativeImports from "./no-deep-relative-imports.ts";
import noDbSchemaInContracts from "./no-db-schema-in-contracts.ts";
import noDumpsterFolders from "./no-dumpster-folders.ts";
import noHardcodedConfigValues from "./no-hardcoded-config-values.ts";
import noNativeEnums from "./no-native-enums.ts";
import noRouteDalImport from "./no-route-dal-import.ts";
import noSecretLikeLiterals from "./no-secret-like-literals.ts";
import noShimFiles from "./no-shim-files.ts";
import noStaleIntentComments from "./no-stale-intent-comments.ts";
import noUnguardedJsonParse from "./no-unguarded-json-parse.ts";
import pythonNoBareExcept from "./python-no-bare-except.ts";
import pythonNoSysPathMutation from "./python-no-sys-path-mutation.ts";
import repeatedDomainLiterals from "./repeated-domain-literals.ts";
import sensitiveChangeRequiresApproval from "./sensitive-change-requires-approval.ts";
import shimRequiresExpiry from "./shim-requires-expiry.ts";
import serviceNoDbClient from "./service-no-db-client.ts";
import specDefinitionsAreEnforced from "./spec-definitions-are-enforced.ts";

export default [
  ...docsOnlyConventions,
  folderFileNaming,
  serviceNoDbClient,
  dalTransactionParam,
  noRouteDalImport,
  noDbSchemaInContracts,
  noNativeEnums,
  repeatedDomainLiterals,
  duplicateBoundaryLiterals,
  explicitErrorContracts,
  noDeepRelativeImports,
  frameworkPackageBoundaries,
  inlineSoftEnumLiteral,
  noStaleIntentComments,
  noShimFiles,
  shimRequiresExpiry,
  deprecatedRequiresReplacement,
  noDumpsterFolders,
  pythonNoSysPathMutation,
  pythonNoBareExcept,
  noUnguardedJsonParse,
  sensitiveChangeRequiresApproval,
  noSecretLikeLiterals,
  noHardcodedConfigValues,
  specDefinitionsAreEnforced,
];
