import { createHash } from "node:crypto";
import { FileTreeError, listFiles } from "./glob.ts";
import { refKind, resolveRef, scanCssRefs } from "./css-refs.ts";
import { forbiddenReason, type ThemeManifest } from "./manifest.ts";

export type ThemeErrorCode =
  | "pattern_unmatched"
  | "pattern_mismatch"
  | "forbidden_file"
  | "symlink"
  | "missing_input"
  | "unsafe_svg"
  | "external_reference"
  | "unclassified_reference"
  | "usage";

/** A refusal of the theme tools. `details` holds paths and reasons, never file contents. */
export class ThemeError extends Error {
  readonly code: ThemeErrorCode;
  readonly details: readonly string[];

  constructor(code: ThemeErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "ThemeError";
    this.code = code;
    this.details = details;
  }
}

/** `path` is inside the tree with `/`; `from` is the absolute path of the bytes. */
export interface TreeFile {
  readonly path: string;
  readonly from: string;
  readonly sha256: string;
  readonly bytes: number;
  /** True for a file that is imported as inline SVG and never published. */
  readonly inline: boolean;
}

export interface Tree {
  readonly files: readonly TreeFile[];
  readonly digest: string;
}

/** Every list and count is of distinct targets; the lists are sorted by code unit. */
export interface RefReport {
  shipped: number;
  neverShipped: string[];
  knownMissing: string[];
  unshippedFallbacks: string[];
}

/** Order by code unit. */
export function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path < b.path) return -1;
  return a.path > b.path ? 1 : 0;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The sha256 of the lines `<path>\t<sha256>\n` in the order of `byPath`. */
export function treeDigest(files: readonly Pick<TreeFile, "path" | "sha256">[]): string {
  const lines = [...files].sort(byPath).map((file) => `${file.path}\t${file.sha256}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/** `listFiles`, with its refusals turned into `ThemeError`. */
export function listTree(root: string): string[] {
  try {
    return listFiles(root);
  } catch (error) {
    if (!(error instanceof FileTreeError)) throw error;
    if (error.problem === "symlink")
      throw new ThemeError("symlink", "a symbolic link is in the tree", [error.path]);
    throw new ThemeError("missing_input", "a folder or file of the tree cannot be read", [
      `${error.problem}: ${error.path}`,
    ]);
  }
}

// Only a reference counts as another origin: href/src, url() and @import.
const OTHER_ORIGIN = "(?:https?:)?\\/\\/";
const SVG_RULES: readonly (readonly [RegExp, string])[] = [
  [/<script\b/i, "contains a script element"],
  [/<foreignObject\b/i, "contains a foreignObject element"],
  [/\son[a-z]+\s*=/i, "contains an event handler attribute"],
  [/javascript:/i, "contains a javascript: URL"],
  [new RegExp(`(?:href|src)\\s*=\\s*["']\\s*${OTHER_ORIGIN}`, "i"), "refers to another origin"],
  [new RegExp(`url\\(\\s*["']?\\s*${OTHER_ORIGIN}`, "i"), "refers to another origin"],
  [
    new RegExp(`@import\\s+(?:url\\(\\s*)?["']?\\s*${OTHER_ORIGIN}`, "i"),
    "refers to another origin",
  ],
];

/** What makes an SVG unsafe to import inline, as a list of distinct short reasons. */
export function svgProblems(text: string): string[] {
  const problems = new Set<string>();
  for (const [pattern, problem] of SVG_RULES) if (pattern.test(text)) problems.add(problem);
  return [...problems];
}

const ASSETS_PREFIX = "assets/";

/**
 * Sorts every reference of the shipped stylesheets into the classes of 16.3. The stylesheet paths
 * and `treePaths` are inside a tree that keeps the folder `assets/`.
 */
export function classifyRefs(
  stylesheets: readonly { path: string; text: string }[],
  treePaths: ReadonlySet<string>,
  manifest: ThemeManifest,
): RefReport {
  const shipped = new Set<string>();
  const neverShipped = new Set<string>();
  const knownMissing = new Set<string>();
  const unshippedFallbacks = new Set<string>();
  const external = new Set<string>();
  const unclassified = new Set<string>();

  for (const sheet of stylesheets) {
    for (const ref of scanCssRefs(sheet.text)) {
      const kind = refKind(ref.raw);
      if (kind === "data") continue;
      if (kind === "external" || kind === "root-relative") {
        external.add(`${sheet.path}: ${ref.raw}`);
        continue;
      }
      if (ref.kind === "import") {
        unclassified.add(`${sheet.path}: @import ${ref.raw}`);
        continue;
      }
      const target = resolveRef(sheet.path, ref.raw);
      if (target === null) {
        unclassified.add(`${sheet.path}: ${ref.raw}`);
        continue;
      }
      if (treePaths.has(target)) {
        shipped.add(target);
        continue;
      }
      const inside = target.startsWith(ASSETS_PREFIX) ? target.slice(ASSETS_PREFIX.length) : target;
      if (manifest.knownMissing.includes(inside)) knownMissing.add(inside);
      else if (manifest.unshippedFallbacks.includes(inside)) unshippedFallbacks.add(inside);
      else if (forbiddenReason(inside, manifest) !== null) neverShipped.add(inside);
      else unclassified.add(inside);
    }
  }

  if (external.size > 0)
    throw new ThemeError(
      "external_reference",
      "a shipped stylesheet refers to another origin",
      [...external].sort(),
    );
  if (unclassified.size > 0)
    throw new ThemeError(
      "unclassified_reference",
      "a shipped stylesheet refers to a file in no class of 16.3",
      [...unclassified].sort(),
    );
  return {
    shipped: shipped.size,
    neverShipped: [...neverShipped].sort(),
    knownMissing: [...knownMissing].sort(),
    unshippedFallbacks: [...unshippedFallbacks].sort(),
  };
}
