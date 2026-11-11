import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchPattern } from "./glob.ts";
import { forbiddenReason, type ThemeManifest } from "./manifest.ts";
import {
  ThemeError,
  byPath,
  classifyRefs,
  listTree,
  sha256Of,
  svgProblems,
  treeDigest,
  type RefReport,
  type Tree,
  type TreeFile,
} from "./tree.ts";

/**
 * What the allow-list of 16.3 takes from the mockup. It reads, checks and writes nothing. Every
 * problem of one kind is collected before the error is thrown, so that one run shows them all.
 */
export function buildImportTree(
  sourceRoot: string,
  manifest: ThemeManifest,
): { tree: Tree; refs: RefReport } {
  const available = listTree(sourceRoot);
  const present = new Set(available);

  // path -> true when a row with `inline: true` chose it
  const chosen = new Map<string, boolean>();
  const unmatched: string[] = [];
  const mismatched: string[] = [];

  for (const row of manifest.shipped) {
    const inline = row.inline === true;
    const take = (path: string): void => {
      chosen.set(path, (chosen.get(path) ?? false) || inline);
    };
    if (row.only === undefined) {
      const matches = available.filter((path) => matchPattern(row.pattern, path));
      if (matches.length === 0) unmatched.push(row.pattern);
      for (const path of matches) take(path);
      continue;
    }
    for (const path of row.only) {
      if (!matchPattern(row.pattern, path))
        mismatched.push(`${path}: not matched by ${row.pattern}`);
      else if (!present.has(path)) mismatched.push(`${path}: not in the source`);
      else take(path);
    }
  }
  if (unmatched.length > 0)
    throw new ThemeError(
      "pattern_unmatched",
      "the allow-list has a pattern that matches no file",
      unmatched,
    );
  if (mismatched.length > 0)
    throw new ThemeError(
      "pattern_mismatch",
      "the allow-list lists a file that its pattern does not allow or the source lacks",
      mismatched.sort(),
    );

  const paths = [...chosen.keys()].sort();

  const forbidden: string[] = [];
  for (const path of paths) {
    const reason = forbiddenReason(path, manifest);
    if (reason !== null) forbidden.push(`${path}: ${reason}`);
  }
  if (forbidden.length > 0)
    throw new ThemeError(
      "forbidden_file",
      "the allow-list gives a file that must never be shipped",
      forbidden,
    );

  const bytesOf = new Map<string, Buffer>();
  for (const path of paths) bytesOf.set(path, readFileSync(join(sourceRoot, path)));

  const unsafe: string[] = [];
  for (const path of paths) {
    if (!path.endsWith(".svg")) continue;
    const text = (bytesOf.get(path) ?? Buffer.alloc(0)).toString("utf8");
    for (const problem of svgProblems(text)) unsafe.push(`${path}: ${problem}`);
  }
  if (unsafe.length > 0) throw new ThemeError("unsafe_svg", "a shipped SVG is not safe", unsafe);

  const stylesheets = paths
    .filter((path) => path.endsWith(".css"))
    .map((path) => ({
      path: `assets/${path}`,
      text: (bytesOf.get(path) ?? Buffer.alloc(0)).toString("utf8"),
    }));
  const refs = classifyRefs(stylesheets, new Set(paths.map((path) => `assets/${path}`)), manifest);

  const files: TreeFile[] = paths
    .map((path) => {
      const bytes = bytesOf.get(path) ?? Buffer.alloc(0);
      return {
        path,
        from: join(sourceRoot, path),
        sha256: sha256Of(bytes),
        bytes: bytes.length,
        inline: chosen.get(path) === true,
      };
    })
    .sort(byPath);
  return { tree: { files, digest: treeDigest(files) }, refs };
}
