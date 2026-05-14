import { useState } from "react";
import type { GitCommit } from "./types.ts";

export function commitKey(commit: GitCommit): string {
  return commit.fullHash || commit.hash;
}

export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return true;
  if (!(event.target instanceof HTMLElement)) return false;
  if (event.target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
}

export function useStoredBoolean(key: string, fallback: boolean): [boolean, (value: boolean | ((current: boolean) => boolean)) => void] {
  return useStoredValue(key, fallback, (value) => value === "true");
}

export function useStoredNumber(key: string, fallback: number): [number, (value: number | ((current: number) => number)) => void] {
  return useStoredValue(key, fallback, (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  });
}

export function useStoredValue<T>(key: string, fallback: T, parse: (value: string) => T): [T, (value: T | ((current: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : parse(stored);
    } catch {
      return fallback;
    }
  });

  function setStoredState(value: T | ((current: T) => T)): void {
    setState((current) => {
      const next = typeof value === "function" ? (value as (current: T) => T)(current) : value;
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        return next;
      }
      return next;
    });
  }

  return [state, setStoredState];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function basename(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? file : file.slice(index + 1);
}

export function dirname(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? "." : file.slice(0, index);
}
