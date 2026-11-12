import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchPattern } from "./glob.ts";
import { TC_FONTS, TC_OWN_FONTS, forbiddenReason, type ThemeManifest } from "./manifest.ts";
import {
  ThemeError,
  byPath,
  classifyRefs,
  listTree,
  sha256Of,
  treeDigest,
  type RefReport,
  type Tree,
  type TreeFile,
} from "./tree.ts";

export interface PublishInputs {
  /** The committed copy of the allow-list (`packages/ui/theme/assets`). */
  vendoredRoot: string;
  /** `packages/ui/styles/tc.css`. */
  tcCssFile: string;
  /** The folder of an installed Fontsource package. */
  fontPackageDir(packageName: string): string;
  /** The repository root, where the fonts of `TC_OWN_FONTS` sit. */
  repoRoot: string;
  manifest: ThemeManifest;
}

/** A file of the vendored copy that a row with `inline: true` chose: it is imported, never published. */
function isInline(path: string, manifest: ThemeManifest): boolean {
  return manifest.shipped.some(
    (row) =>
      row.inline === true &&
      matchPattern(row.pattern, path) &&
      (row.only === undefined || row.only.includes(path)),
  );
}

/**
 * What `public/theme/` of an app holds: the vendored files under `assets/`, `tc.css`, the font
 * files of `TC_FONTS` and their licences under `fonts/`. It reads, checks and writes nothing.
 * Problems of one kind are collected before the error is thrown (R16).
 */
export function buildPublishTree(input: PublishInputs): { tree: Tree; refs: RefReport } {
  const { manifest } = input;
  const vendored = listTree(input.vendoredRoot);

  const forbidden: string[] = [];
  for (const path of vendored) {
    const reason = forbiddenReason(path, manifest);
    if (reason !== null) forbidden.push(`${path}: ${reason}`);
  }
  if (forbidden.length > 0)
    throw new ThemeError(
      "forbidden_file",
      "the vendored copy holds a file that must never be shipped",
      forbidden,
    );

  // path in the output -> file with the bytes
  const sources = new Map<string, string>();
  for (const path of vendored)
    if (!isInline(path, manifest)) sources.set(`assets/${path}`, join(input.vendoredRoot, path));
  sources.set("tc.css", input.tcCssFile);

  const unreadable: string[] = [];
  for (const font of TC_FONTS) {
    let dir: string | null = null;
    try {
      dir = input.fontPackageDir(font.package);
    } catch {
      unreadable.push(`${font.package}: not installed`);
    }
    if (dir === null) continue;
    for (const file of font.files) sources.set(`fonts/${file}`, join(dir, "files", file));
    sources.set(`fonts/LICENSE-${font.id}.txt`, join(dir, "LICENSE"));
  }

  for (const font of TC_OWN_FONTS) {
    const dir = join(input.repoRoot, font.dir);
    for (const file of font.files) sources.set(`fonts/${file}`, join(dir, file));
    sources.set(`fonts/LICENSE-${font.id}.txt`, join(dir, font.license));
  }

  const bytesOf = new Map<string, Buffer>();
  for (const [path, from] of sources) {
    try {
      bytesOf.set(path, readFileSync(from));
    } catch {
      unreadable.push(`${path}: cannot read ${from}`);
    }
  }
  if (unreadable.length > 0)
    throw new ThemeError(
      "missing_input",
      "a file of the publish tree cannot be read",
      unreadable.sort(),
    );

  const files: TreeFile[] = [...sources.entries()]
    .map(([path, from]) => {
      const bytes = bytesOf.get(path) ?? Buffer.alloc(0);
      return { path, from, sha256: sha256Of(bytes), bytes: bytes.length, inline: false };
    })
    .sort(byPath);

  const stylesheets = files
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => ({
      path: file.path,
      text: (bytesOf.get(file.path) ?? Buffer.alloc(0)).toString("utf8"),
    }));
  const refs = classifyRefs(stylesheets, new Set(files.map((file) => file.path)), manifest);
  return { tree: { files, digest: treeDigest(files) }, refs };
}
