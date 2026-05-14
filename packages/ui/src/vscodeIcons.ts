import languageAssociationsData from "./generated/vscode-icons-language-associations.json";
import vscodeIconsManifest from "./generated/vscode-icons-manifest.json";

export const VscodeEntryKind = {
  Directory: "directory",
  File: "file",
} as const;
export type VscodeEntryKind = (typeof VscodeEntryKind)[keyof typeof VscodeEntryKind];

const VscodeIconVersion = "v12.17.0";
const VscodeIconsBasePath = `/vscode-icons/${VscodeIconVersion}`;

type IconDefinition = {
  iconFile: string;
  spriteFile: string;
};

type IconLookupSection = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
};

type VscodeIconsManifest = IconLookupSection & {
  iconDefinitions: Record<string, IconDefinition>;
};

type LanguageAssociations = {
  version: string;
  extensionToLanguageId: Record<string, string>;
  fileNameToLanguageId: Record<string, string>;
};

export type VscodeIconResolution = {
  definitionKey: string;
  filename: string;
  href: string;
  spritePath: string;
  symbolId: string;
};

const manifest = vscodeIconsManifest as VscodeIconsManifest;
const languageAssociations = languageAssociationsData as LanguageAssociations;
const iconDefinitions = manifest.iconDefinitions;

const fileNames = toLowercaseLookup(manifest.fileNames);
const fileExtensions = toLowercaseLookup(manifest.fileExtensions);
const folderNames = toLowercaseLookup(manifest.folderNames);
const folderNamesExpanded = toLowercaseLookup(manifest.folderNamesExpanded ?? {});
const languageIds = toLowercaseLookup(manifest.languageIds ?? {});
const languageIdByExtension = toLowercaseLookup(languageAssociations.extensionToLanguageId);
const languageIdByFileName = toLowercaseLookup(languageAssociations.fileNameToLanguageId);

const localLanguageIdByExtensionOverrides = {
  html: "html",
  mdc: "markdown",
  yaml: "yaml",
  yml: "yaml",
} as const;

const localFolderDefinitionAliases = {
  ".agents": "_f_agents",
  ".codex": "_f_ai",
  ".opencode": "_f_agents",
  conventions: "_fd_config",
  examples: "_fd_docs",
  fixtures: "_fd_test",
  runtime: "_fd_library",
  static: "_fd_public",
  validators: "_fd_test",
} as const;

const localFolderExpandedDefinitionAliases = {
  conventions: "_fd_config_open",
  examples: "_fd_docs_open",
  fixtures: "_fd_test_open",
  runtime: "_fd_library_open",
  static: "_fd_public_open",
  validators: "_fd_test_open",
} as const;

const defaultFileIconDefinition = manifest.file ?? "_file";
const defaultFolderIconDefinition = manifest.folder ?? "_folder";
const defaultFolderExpandedIconDefinition = manifest.folderExpanded ?? defaultFolderIconDefinition;

function toLowercaseLookup(source: Record<string, string>): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) lookup[key.toLowerCase()] = value;
  return lookup;
}

function pathSegments(pathValue: string): string[] {
  return pathValue.split(/[\\/]+/).map((segment) => segment.trim().toLowerCase()).filter(Boolean);
}

export function basenameOfPath(pathValue: string): string {
  const slashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}

function extensionCandidates(fileName: string): string[] {
  const candidates = new Set<string>();
  if (fileName.includes(".")) candidates.add(fileName);

  let dotIndex = fileName.indexOf(".");
  while (dotIndex !== -1 && dotIndex < fileName.length - 1) {
    const candidate = fileName.slice(dotIndex + 1);
    if (candidate.length > 0) candidates.add(candidate);
    dotIndex = fileName.indexOf(".", dotIndex + 1);
  }

  return [...candidates];
}

function resolveLanguageFallbackDefinition(pathValue: string): string | null {
  const basename = basenameOfPath(pathValue).toLowerCase();

  const fromBasenameLanguage = languageIdByFileName[basename];
  if (fromBasenameLanguage) return languageIds[fromBasenameLanguage] ?? null;

  for (const candidate of extensionCandidates(basename)) {
    const languageId = localLanguageIdByExtensionOverrides[candidate as keyof typeof localLanguageIdByExtensionOverrides] ?? languageIdByExtension[candidate];
    if (!languageId) continue;
    return languageIds[languageId] ?? null;
  }

  return null;
}

function iconDefinitionForKey(definitionKey: string | undefined): IconDefinition | null {
  if (!definitionKey) return null;
  return iconDefinitions[definitionKey] ?? null;
}

function symbolIdForIconFile(filename: string): string {
  return filename.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function resolveFileDefinition(pathValue: string): string {
  const basename = basenameOfPath(pathValue).toLowerCase();

  const fromFileName = fileNames[basename];
  if (fromFileName) return fromFileName;

  for (const candidate of extensionCandidates(basename)) {
    const fromExtension = fileExtensions[candidate];
    if (fromExtension) return fromExtension;
  }

  const fromLanguage = resolveLanguageFallbackDefinition(pathValue);
  if (fromLanguage) return fromLanguage;

  return defaultFileIconDefinition;
}

function resolveFolderDefinition(pathValue: string, expanded: boolean): string {
  const basename = basenameOfPath(pathValue).toLowerCase();
  const fromBasename = folderDefinitionForName(basename, expanded);
  if (fromBasename) return fromBasename;

  for (const segment of pathSegments(pathValue)) {
    if (segment === basename) continue;
    const fromSegment = folderDefinitionForName(segment, expanded);
    if (fromSegment) return fromSegment;
  }

  return expanded ? defaultFolderExpandedIconDefinition : defaultFolderIconDefinition;
}

function folderDefinitionForName(folderName: string, expanded: boolean): string | null {
  if (!folderName) return null;
  if (!expanded) return folderNames[folderName] ?? localFolderDefinitionAliases[folderName as keyof typeof localFolderDefinitionAliases] ?? null;
  return (
    folderNamesExpanded[folderName] ??
    folderNames[folderName] ??
    localFolderExpandedDefinitionAliases[folderName as keyof typeof localFolderExpandedDefinitionAliases] ??
    localFolderDefinitionAliases[folderName as keyof typeof localFolderDefinitionAliases] ??
    null
  );
}

export function resolveVscodeIconForEntry(pathValue: string, kind: VscodeEntryKind, expanded = false): VscodeIconResolution {
  const definitionKey = kind === VscodeEntryKind.Directory ? resolveFolderDefinition(pathValue, expanded) : resolveFileDefinition(pathValue);
  const fallbackDefinitionKey = kind === VscodeEntryKind.Directory ? defaultFolderIconDefinition : defaultFileIconDefinition;
  const fallbackFilename = kind === VscodeEntryKind.Directory ? "default_folder.svg" : "default_file.svg";
  const definition = iconDefinitionForKey(definitionKey) ?? iconDefinitionForKey(fallbackDefinitionKey);
  const filename = definition?.iconFile ?? fallbackFilename;
  const symbolId = symbolIdForIconFile(filename);
  const spritePath = definition ? `${VscodeIconsBasePath}/${definition.spriteFile}` : `${VscodeIconsBasePath}/sprite-0.svg`;

  return {
    definitionKey,
    filename,
    href: `${spritePath}#${symbolId}`,
    spritePath,
    symbolId,
  };
}
