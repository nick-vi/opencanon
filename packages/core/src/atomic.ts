import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const TextEncoding = {
  Utf8: "utf8",
} as const;

export function writeAtomicTextFileSync(filePath: string, content: string): void {
  writeAtomicFileSync(filePath, content, TextEncoding.Utf8);
}

export function writeAtomicBinaryFileSync(filePath: string, content: NodeJS.ArrayBufferView): void {
  writeAtomicFileSync(filePath, content);
}

function writeAtomicFileSync(filePath: string, content: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(fd, content, encoding);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function writeAtomicJsonFileSync(filePath: string, value: unknown): void {
  writeAtomicTextFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
