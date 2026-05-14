#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

const VERSION = process.argv[2] ?? "12.17.0";
const VERSION_TAG = `v${VERSION}`;
const VSIX_URL = `https://open-vsx.org/api/vscode-icons-team/vscode-icons/${VERSION}/file/vscode-icons-team.vscode-icons-${VERSION}.vsix`;
const LANGUAGES_URL = `https://raw.githubusercontent.com/vscode-icons/vscode-icons/${VERSION_TAG}/src/iconsManifest/languages.ts`;

const REPO_ROOT = process.cwd();
const UI_SRC_DIR = path.join(REPO_ROOT, "packages/ui/src/generated");
const UI_PUBLIC_VERSION_DIR = path.join(REPO_ROOT, "packages/ui/public/vscode-icons", VERSION_TAG);
const PUBLIC_README_PATH = path.join(REPO_ROOT, "packages/ui/public/vscode-icons/README.md");
const MANIFEST_PATH = path.join(UI_SRC_DIR, "vscode-icons-manifest.json");
const ASSOCIATIONS_PATH = path.join(UI_SRC_DIR, "vscode-icons-language-associations.json");

const ManifestLookupSections = ["fileNames", "fileExtensions", "folderNames", "folderNamesExpanded", "languageIds"];
const MaxSpriteChunkBytes = 450_000;
const UnsupportedSpriteIconFiles = new Set(["file_type_shellcheck.svg"]);

function normalizeExtension(value) {
  return value.trim().toLowerCase().replace(/^\./, "");
}

function normalizeFileName(value) {
  return value.trim().toLowerCase();
}

function putIfAbsent(target, key, value) {
  if (!(key in target)) target[key] = value;
}

async function downloadVsix(tmpDir) {
  const vsixPath = path.join(tmpDir, `vscode-icons-${VERSION}.vsix`);
  const response = await fetch(VSIX_URL);
  if (!response.ok) throw new Error(`Failed to download VSIX: ${response.status} ${response.statusText}`);
  await fs.writeFile(vsixPath, Buffer.from(await response.arrayBuffer()));
  return vsixPath;
}

async function extractManifestFromVsix(vsixPath) {
  const { stdout } = await execFileAsync("unzip", ["-p", vsixPath, "extension/dist/src/vsicons-icon-theme.json"]);
  if (!stdout.trim()) throw new Error("Could not extract vsicons-icon-theme.json from VSIX");
  return JSON.parse(stdout);
}

function referencedIconDefinitionKeys(manifest) {
  const keys = new Set([manifest.file, manifest.folder, manifest.folderExpanded, manifest.rootFolder, manifest.rootFolderExpanded].filter(Boolean));

  for (const section of ManifestLookupSections) {
    for (const value of Object.values(manifest[section] ?? {})) keys.add(value);
  }

  return keys;
}

function iconFilenameForDefinition(manifest, definitionKey) {
  const iconPath = manifest.iconDefinitions?.[definitionKey]?.iconPath;
  if (typeof iconPath !== "string" || !iconPath) return null;
  return path.basename(iconPath);
}

function symbolIdForIconFile(iconFile) {
  return path.basename(iconFile, ".svg").replace(/[^A-Za-z0-9_-]/g, "_");
}

function escapeXmlAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixInternalReferences(svg, symbolId) {
  const ids = new Set([...svg.matchAll(/\sid=(["'])([^"']+)\1/g)].map((match) => match[2]));
  let output = svg;

  for (const id of ids) {
    const prefixedId = `${symbolId}__${id}`;
    const idSelectorPattern = new RegExp(`#${escapeRegExp(id)}(?![A-Za-z0-9_-])`, "g");
    output = output
      .replaceAll(`id="${id}"`, `id="${prefixedId}"`)
      .replaceAll(`id='${id}'`, `id='${prefixedId}'`)
      .replaceAll(`url(#${id})`, `url(#${prefixedId})`)
      .replaceAll(`href="#${id}"`, `href="#${prefixedId}"`)
      .replaceAll(`href='#${id}'`, `href='#${prefixedId}'`)
      .replaceAll(`xlink:href="#${id}"`, `xlink:href="#${prefixedId}"`)
      .replaceAll(`xlink:href='#${id}'`, `xlink:href='#${prefixedId}'`)
      .replace(idSelectorPattern, `#${prefixedId}`);
  }

  const classes = new Set();
  for (const match of output.matchAll(/\sclass=(["'])([^"']+)\1/g)) {
    for (const className of match[2].trim().split(/\s+/)) {
      if (className) classes.add(className);
    }
  }

  for (const className of classes) {
    const prefixedClassName = `${symbolId}__${className}`;
    const classSelectorPattern = new RegExp(`(?<![A-Za-z0-9_-])\\.${escapeRegExp(className)}(?![A-Za-z0-9_-])`, "g");
    output = output
      .replace(/\sclass=(["'])([^"']+)\1/g, (match, quote, rawClassNames) => {
        const classNames = rawClassNames
          .trim()
          .split(/\s+/)
          .map((value) => (value === className ? prefixedClassName : value));
        return ` class=${quote}${classNames.join(" ")}${quote}`;
      })
      .replace(classSelectorPattern, `.${prefixedClassName}`);
  }

  return output;
}

function stripGeneratedSvgMetadata(svg) {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, "")
    .replace(/<[A-Za-z][\w.-]*:namedview\b[^>]*(?:\/>|>[\s\S]*?<\/[A-Za-z][\w.-]*:namedview>)/gi, "");
}

function stripUnsupportedNamespaceAttributes(svg) {
  return svg.replace(
    /\s([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(=(["'])(?:(?!\4)[\s\S])*\4)?/g,
    (match, prefix) => (prefix === "xlink" || prefix === "xml" ? match : ""),
  );
}

function stripEmbeddedRasterImages(svg) {
  const imageIds = new Set([...svg.matchAll(/<image\b[^>]*\sid=(["'])([^"']+)\1[^>]*\/?>/gi)].map((match) => match[2]));
  let output = svg.replace(/<image\b[^>]*\/?>/gi, "");

  for (const imageId of imageIds) {
    const escapedImageId = escapeRegExp(imageId);
    output = output.replace(
      new RegExp(`<use\\b(?=[^>]*(?:href|xlink:href)=(["'])#${escapedImageId}\\1)[^>]*\\/?>(?:\\s*<\\/use>)?`, "gi"),
      "",
    );
  }

  return output;
}

function sanitizeIconSvgBody(svg) {
  return stripUnsupportedNamespaceAttributes(stripEmbeddedRasterImages(stripGeneratedSvgMetadata(svg)));
}

function formatIconSprite(symbols) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    ...symbols,
    "</svg>",
    "",
  ].join("\n");
}

async function buildIconSprites(sourceIconsDir, iconFiles) {
  const spriteFileByIconFile = new Map();
  let chunkIndex = 0;
  let chunkSize = 0;
  let symbols = [];

  for (const iconFile of [...iconFiles].sort()) {
    const source = path.join(sourceIconsDir, iconFile);
    const raw = await fs.readFile(source, "utf8");
    const svgMatch = raw.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>\s*$/i);
    if (!svgMatch) throw new Error(`Could not parse SVG wrapper for ${iconFile}`);

    const attributes = svgMatch[1];
    const viewBox = attributes.match(/\sviewBox=(["'])([^"']+)\1/i)?.[2] ?? "0 0 32 32";
    const symbolId = symbolIdForIconFile(iconFile);
    const body = prefixInternalReferences(sanitizeIconSvgBody(svgMatch[2]), symbolId);
    const symbol = `<symbol id="${escapeXmlAttribute(symbolId)}" viewBox="${escapeXmlAttribute(viewBox)}">${body}</symbol>`;

    if (symbols.length > 0 && chunkSize + symbol.length > MaxSpriteChunkBytes) {
      await fs.writeFile(path.join(UI_PUBLIC_VERSION_DIR, `sprite-${chunkIndex}.svg`), formatIconSprite(symbols), "utf8");
      chunkIndex += 1;
      chunkSize = 0;
      symbols = [];
    }

    const spriteFile = `sprite-${chunkIndex}.svg`;
    symbols.push(symbol);
    chunkSize += symbol.length;
    spriteFileByIconFile.set(iconFile, spriteFile);
  }

  if (symbols.length > 0) {
    await fs.writeFile(path.join(UI_PUBLIC_VERSION_DIR, `sprite-${chunkIndex}.svg`), formatIconSprite(symbols), "utf8");
  }

  return spriteFileByIconFile;
}

function pruneManifestForRuntime(manifest) {
  const definitionKeys = referencedIconDefinitionKeys(manifest);
  const iconDefinitions = {};

  for (const definitionKey of definitionKeys) {
    const iconFile = iconFilenameForDefinition(manifest, definitionKey);
    if (iconFile) iconDefinitions[definitionKey] = { iconFile };
  }

  return {
    file: manifest.file,
    folder: manifest.folder,
    folderExpanded: manifest.folderExpanded,
    rootFolder: manifest.rootFolder,
    rootFolderExpanded: manifest.rootFolderExpanded,
    fileNames: manifest.fileNames ?? {},
    fileExtensions: manifest.fileExtensions ?? {},
    folderNames: manifest.folderNames ?? {},
    folderNamesExpanded: manifest.folderNamesExpanded ?? {},
    languageIds: manifest.languageIds ?? {},
    iconDefinitions,
  };
}

async function extractIconsFromVsix(vsixPath, tmpDir, manifest) {
  const extractDir = path.join(tmpDir, "extracted");
  await fs.mkdir(extractDir, { recursive: true });
  await execFileAsync("unzip", ["-q", vsixPath, "extension/icons/*.svg", "-d", extractDir]);
  const sourceIconsDir = path.join(extractDir, "extension/icons");
  await fs.rm(UI_PUBLIC_VERSION_DIR, { recursive: true, force: true });
  await fs.mkdir(UI_PUBLIC_VERSION_DIR, { recursive: true });

  const iconFiles = new Set();
  for (const [definitionKey, definition] of Object.entries(manifest.iconDefinitions ?? {})) {
    const iconFile = definition?.iconFile;
    if (!iconFile) continue;
    if (UnsupportedSpriteIconFiles.has(iconFile)) {
      delete manifest.iconDefinitions[definitionKey];
      continue;
    }
    iconFiles.add(iconFile);
  }

  const spriteFileByIconFile = await buildIconSprites(sourceIconsDir, iconFiles);
  for (const definition of Object.values(manifest.iconDefinitions ?? {})) {
    const iconFile = definition?.iconFile;
    const spriteFile = iconFile ? spriteFileByIconFile.get(iconFile) : null;
    if (spriteFile) definition.spriteFile = spriteFile;
  }

  return iconFiles.size;
}

async function loadLanguagesCollection() {
  const response = await fetch(LANGUAGES_URL);
  if (!response.ok) throw new Error(`Failed to fetch languages.ts: ${response.status} ${response.statusText}`);
  const rawSource = await response.text();
  const source = rawSource
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/export const languages(?:\s*:\s*[^=]+)?\s*=/, "const languages =")
    .replace(/\}\s*satisfies\s*Record<[^;]+>;/, "};");

  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__languages = languages;`, context);
  const languages = context.__languages;
  if (!languages || typeof languages !== "object") throw new Error("Failed to parse languages.ts into a collection");
  return languages;
}

function buildLanguageAssociations(manifest, languages) {
  const availableLanguageIds = new Set(Object.keys(manifest.languageIds ?? {}));
  const extensionToLanguageId = {};
  const fileNameToLanguageId = {};

  for (const entry of Object.values(languages)) {
    if (!entry || typeof entry !== "object") continue;
    const idsRaw = entry.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw : [idsRaw];
    const knownExtensions = Array.isArray(entry.knownExtensions) ? entry.knownExtensions : [];
    const knownFilenames = Array.isArray(entry.knownFilenames) ? entry.knownFilenames : [];

    for (const idValue of ids) {
      if (typeof idValue !== "string") continue;
      const languageId = idValue.trim();
      if (!languageId || !availableLanguageIds.has(languageId)) continue;

      for (const extensionValue of knownExtensions) {
        if (typeof extensionValue !== "string") continue;
        const extension = normalizeExtension(extensionValue);
        if (extension) putIfAbsent(extensionToLanguageId, extension, languageId);
      }

      for (const fileNameValue of knownFilenames) {
        if (typeof fileNameValue !== "string") continue;
        const fileName = normalizeFileName(fileNameValue);
        if (fileName) putIfAbsent(fileNameToLanguageId, fileName, languageId);
      }
    }
  }

  return {
    version: VERSION,
    source: LANGUAGES_URL,
    generatedAt: new Date().toISOString(),
    extensionToLanguageId,
    fileNameToLanguageId,
  };
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencanon-vscode-icons-"));
  try {
    const vsixPath = await downloadVsix(tmpDir);
    const manifest = pruneManifestForRuntime(await extractManifestFromVsix(vsixPath));
    const iconCount = await extractIconsFromVsix(vsixPath, tmpDir, manifest);
    const associations = buildLanguageAssociations(manifest, await loadLanguagesCollection());

    await fs.mkdir(UI_SRC_DIR, { recursive: true });
    await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest)}\n`, "utf8");
    await fs.writeFile(ASSOCIATIONS_PATH, `${JSON.stringify(associations)}\n`, "utf8");
    await fs.writeFile(
      PUBLIC_README_PATH,
      [
        "# VSCode Icons",
        "",
        `Generated by \`bun run sync:vscode-icons -- ${VERSION}\`.`,
        "",
        `Source: ${VSIX_URL}`,
        "Project: https://github.com/vscode-icons/vscode-icons",
        "",
        "The icon sprites are vendored so the OpenCanon runtime UI works without network access.",
        "",
      ].join("\n"),
      "utf8",
    );

    process.stdout.write(
      [
        `Synced vscode-icons ${VERSION}`,
        `manifest: ${path.relative(REPO_ROOT, MANIFEST_PATH)}`,
        `language associations: ${path.relative(REPO_ROOT, ASSOCIATIONS_PATH)}`,
        `sprites: ${path.relative(REPO_ROOT, UI_PUBLIC_VERSION_DIR)}`,
        `icons: ${iconCount}`,
      ].join("\n") + "\n",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
