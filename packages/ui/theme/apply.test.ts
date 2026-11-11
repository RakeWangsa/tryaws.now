import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diffTree, writeTree } from "./apply.ts";
import { listFiles } from "./glob.ts";
import { ThemeError, sha256Of, treeDigest, type Tree } from "./tree.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "apply-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
/** A Tree whose bytes sit in a new folder; no manifest is involved. */
function treeOf(files: Record<string, string>): Tree {
  const root = temp(files);
  const list = Object.keys(files)
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(root, path));
      return {
        path,
        from: join(root, path),
        sha256: sha256Of(bytes),
        bytes: bytes.length,
        inline: false,
      };
    });
  return { files: list, digest: treeDigest(list) };
}
const source = (): Tree =>
  treeOf({ "css/a.css": "a{color:red}", "css/b.css": "b{color:blue}", "img/x.svg": "<svg/>" });
const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof ThemeError ? error.code : "other error";
  }
  return "no error";
};

describe("diffTree", () => {
  it("calls everything missing when the folder does not exist, and writes nothing", () => {
    const dest = join(temp(), "out");
    expect(diffTree(source(), dest)).toEqual({
      missing: ["css/a.css", "css/b.css", "img/x.svg"],
      changed: [],
      stray: [],
      same: 0,
    });
    expect(existsSync(dest)).toBe(false);
  });

  it("finds a missing, a changed and a stray file", () => {
    const dest = temp({ "css/a.css": "a{color:red}", "css/b.css": "edited", "old/gone.txt": "x" });
    expect(diffTree(source(), dest)).toEqual({
      missing: ["img/x.svg"],
      changed: ["css/b.css"],
      stray: ["old/gone.txt"],
      same: 1,
    });
  });

  it("refuses a relative destination, the filesystem root and a symbolic link inside the folder", () => {
    expect(code(() => diffTree(source(), "out"))).toBe("usage");
    expect(code(() => diffTree(source(), "/"))).toBe("usage");
    const dest = temp({ "css/a.css": "a{color:red}" });
    symlinkSync(join(dest, "css/a.css"), join(dest, "css/link.css"));
    expect(code(() => diffTree(source(), dest))).toBe("symlink");
  });
});

describe("writeTree", () => {
  it("makes the folder equal to the tree: writes, replaces, removes, and drops empty folders", () => {
    const dest = temp({ "css/b.css": "edited", "old/deep/gone.txt": "x" });
    expect(writeTree(source(), dest)).toEqual({
      written: ["css/a.css", "css/b.css", "img/x.svg"],
      removed: ["old/deep/gone.txt"],
    });
    expect(listFiles(dest)).toEqual(["css/a.css", "css/b.css", "img/x.svg"]);
    expect(readFileSync(join(dest, "css/b.css"), "utf8")).toBe("b{color:blue}");
    expect(existsSync(join(dest, "old"))).toBe(false);
    expect(diffTree(source(), dest)).toMatchObject({
      missing: [],
      changed: [],
      stray: [],
      same: 3,
    });
  });

  it("writes files without the execute bit", () => {
    const dest = temp();
    writeTree(source(), dest);
    expect(statSync(join(dest, "css/a.css")).mode & 0o111).toBe(0);
  });

  it("Review Focus 5: a second run writes nothing, removes nothing and leaves every mtime alone", () => {
    const dest = temp({ "old/gone.txt": "x" });
    const tree = source();
    writeTree(tree, dest);
    const past = new Date("2020-01-01T00:00:00Z");
    for (const path of listFiles(dest)) utimesSync(join(dest, path), past, past);
    expect(writeTree(tree, dest)).toEqual({ written: [], removed: [] });
    for (const path of listFiles(dest))
      expect(statSync(join(dest, path)).mtimeMs, path).toBe(past.getTime());
  });
});
