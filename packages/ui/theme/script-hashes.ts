import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchPattern } from "./glob.ts";
import { ThemeError, byPath, listTree, sha256Of } from "./tree.ts";

/** Relative to `design/mockup`. */
export const SCRIPT_SOURCES: readonly string[] = [
  "template/assets/js/**",
  "template/assets/fonts/fontawesome/js/**",
  "template/assets/php/**",
  "order-form/**/*.js",
  "whmcs-template/**/*.js",
];

/** Smaller files are not compared: a comment-only script could equal an innocent file. */
export const MIN_HASHED_BYTES = 100;

/** Relative to the repository root. */
export const SCRIPT_HASH_FILE = "packages/ui/theme/script-hashes.txt";

/** `path` is relative to `design/mockup`. */
export interface ScriptEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Every file of `SCRIPT_SOURCES` below `mockupRoot`, sorted. It reads only. A list that would be
 * empty is refused: without the scripts there is nothing to compare with (R16).
 */
export function buildScriptList(mockupRoot: string): ScriptEntry[] {
  const entries = listTree(mockupRoot)
    .filter((path) => SCRIPT_SOURCES.some((pattern) => matchPattern(pattern, path)))
    .map((path) => {
      const bytes = readFileSync(join(mockupRoot, path));
      return { path, bytes: bytes.length, sha256: sha256Of(bytes) };
    })
    .sort(byPath);
  if (entries.length === 0)
    throw new ThemeError("missing_input", "the mockup has no theme script to list", [mockupRoot]);
  return entries;
}

/** One line per file: `<sha256>  <bytes>  <path>`, in the order given. No file contents. */
export function formatScriptList(entries: readonly ScriptEntry[]): string {
  return entries.map((entry) => `${entry.sha256}  ${entry.bytes}  ${entry.path}\n`).join("");
}

const LINE = /^([0-9a-f]{64}) {2}(\d+) {2}(\S.*)$/;

/** The inverse of `formatScriptList`; the details of a refusal are line numbers. */
export function parseScriptList(text: string): ScriptEntry[] {
  if (text === "")
    throw new ThemeError("missing_input", "the list of the theme's scripts is empty", []);
  const lines = text.split("\n");
  const entries: ScriptEntry[] = [];
  const problems: string[] = [];
  // The text ends with a newline, so the last element is empty; anything else there is a bad line.
  lines.forEach((line, index) => {
    const number = index + 1;
    if (index === lines.length - 1 && line === "" && lines.length > 1) return;
    const match = LINE.exec(line);
    if (match === null) {
      problems.push(`line ${number}: not of the form <sha256>  <bytes>  <path>`);
      return;
    }
    const entry = { path: match[3] ?? "", bytes: Number(match[2]), sha256: match[1] ?? "" };
    const previous = entries[entries.length - 1];
    if (previous !== undefined && byPath(previous, entry) >= 0)
      problems.push(`line ${number}: not sorted by path`);
    entries.push(entry);
  });
  if (problems.length > 0)
    throw new ThemeError("missing_input", "the list of the theme's scripts is not valid", problems);
  return entries;
}

export function readScriptList(file: string): ScriptEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ThemeError("missing_input", "the list of the theme's scripts cannot be read", [file]);
  }
  return parseScriptList(text);
}

/** The sha256 of the entries that are big enough to be compared. */
export function scriptHashSet(entries: readonly ScriptEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.bytes >= MIN_HASHED_BYTES).map((e) => e.sha256));
}
