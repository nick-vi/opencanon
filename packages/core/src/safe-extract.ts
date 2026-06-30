import path from "node:path";
import { extract as tarExtract, list as tarList } from "tar";

/** Entry types that must never appear in an OpenCanon runtime bundle. Links are the
 * classic tarball attack vector (symlink/hardlink path traversal); device/FIFO nodes
 * have no business in a JS runtime bundle. We allow only regular files and
 * directories — anything else is rejected before a single byte is extracted. */
const deniedEntryTypes = new Set(["SymbolicLink", "Link", "BlockDevice", "CharacterDevice", "FIFO"]);

/**
 * Extract a `.tar.gz` to `destDir`, safe by construction.
 *
 * The authoritative path-safety boundary is node-tar's extraction with
 * `preservePaths: false`, which strips absolute paths, `..` traversal, and Windows
 * drive-relative/absolute roots (`C:/`, `C:..`, `//server`) on every platform. So we
 * do not hand-parse `tar` listings.
 *
 * The validation pass that runs FIRST exists for the one thing node-tar does NOT do by
 * default: reject link and device entries outright — our bundles only ever contain
 * files and directories. Running it before extraction means link entries never reach
 * node-tar's link handling at all, keeping us clear of the link-traversal CVE class
 * even if the extractor regresses. Its absolute/`..` checks are belt-and-suspenders on
 * top of the extractor (we use `path.win32.isAbsolute`, a superset of POSIX, so the
 * fast-fail is not host-platform-dependent); the extractor remains the real guard.
 *
 * Throws a plain `Error` (prefixed `unsafe archive entry` for policy violations) so it
 * can be used from the standalone launcher; callers that need structured diagnostics
 * wrap it at their boundary.
 */
export function safeExtract(archivePath: string, destDir: string): void {
  let violation: string | undefined;
  tarList({
    file: archivePath,
    sync: true,
    onentry: (entry) => {
      if (violation) return;
      const entryPath = String(entry.path);
      // win32.isAbsolute is a superset of posix.isAbsolute — catches `/x`, `C:/x`, and
      // `//server/share` regardless of the host OS running this check.
      if (path.win32.isAbsolute(entryPath) || entryPath.split(/[\\/]/u).includes("..")) {
        violation = `unsafe archive entry (path traversal): ${entryPath}`;
        return;
      }
      if (deniedEntryTypes.has(String(entry.type))) {
        violation = `unsafe archive entry (${String(entry.type)} not allowed): ${entryPath}`;
      }
    },
  });
  if (violation) throw new Error(violation);

  tarExtract({ file: archivePath, cwd: destDir, sync: true, preservePaths: false });
}
