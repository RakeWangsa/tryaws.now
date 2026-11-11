import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { ThemeError, listTree, sha256Of, type Tree } from "./tree.ts";

/** `missing`: in the tree, not on disk. `changed`: on disk with other bytes. `stray`: on disk, not in the tree. */
export interface TreeDiff {
  missing: string[];
  changed: string[];
  stray: string[];
  same: number;
}

const FILE_MODE = 0o644;

/** A tool that deletes strays must not run against a folder it guessed. */
function checkDestination(destRoot: string): string {
  if (!isAbsolute(destRoot) || resolve(destRoot) === parse(destRoot).root)
    throw new ThemeError("usage", "the destination must be an absolute path other than /", [
      destRoot,
    ]);
  const root = resolve(destRoot);
  if (existsSync(root) && !statSync(root).isDirectory())
    throw new ThemeError("missing_input", "the destination is not a folder", [root]);
  return root;
}

/** Reads, never writes. A `destRoot` that does not exist is an empty folder. */
export function diffTree(tree: Tree, destRoot: string): TreeDiff {
  const root = checkDestination(destRoot);
  const onDisk = existsSync(root) ? listTree(root) : [];
  const present = new Set(onDisk);
  const wanted = new Set(tree.files.map((file) => file.path));
  const diff: TreeDiff = { missing: [], changed: [], stray: [], same: 0 };
  for (const file of tree.files) {
    if (!present.has(file.path)) diff.missing.push(file.path);
    else if (sha256Of(readFileSync(join(root, file.path))) !== file.sha256)
      diff.changed.push(file.path);
    else diff.same++;
  }
  for (const path of onDisk) if (!wanted.has(path)) diff.stray.push(path);
  diff.missing.sort();
  diff.changed.sort();
  diff.stray.sort();
  return diff;
}

/** Removes the folders above `path` that are empty, up to but never including `root`. */
function removeEmptyParents(root: string, path: string): void {
  let dir = dirname(join(root, path));
  while (dir !== root && dir.startsWith(`${root}/`) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

/**
 * Makes `destRoot` equal to the tree: writes the missing and changed files, then removes the
 * stray files, then the folders that this left empty. A file that is already right is not touched.
 */
export function writeTree(tree: Tree, destRoot: string): { written: string[]; removed: string[] } {
  const root = checkDestination(destRoot);
  const diff = diffTree(tree, root);
  const from = new Map(tree.files.map((file) => [file.path, file.from]));
  const written = [...diff.missing, ...diff.changed].sort();
  for (const path of written) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(from.get(path) ?? ""), { mode: FILE_MODE });
    chmodSync(target, FILE_MODE);
  }
  for (const path of diff.stray) unlinkSync(join(root, path));
  if (diff.stray.length > 0) for (const path of diff.stray) removeEmptyParents(root, path);
  return { written, removed: diff.stray };
}
