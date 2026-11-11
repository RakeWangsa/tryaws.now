import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileTreeError, listFiles, matchPattern } from "./glob.ts";

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("matchPattern", () => {
  it.each([
    ["css/theme.min.css", "css/theme.min.css", true],
    ["css/theme.min.css", "css/theme.css", false],
    ["a.b", "aXb", false],
    ["apps/*.svg", "apps/ubuntu.svg", true],
    ["apps/*.svg", "apps/x/ubuntu.svg", false],
    ["apps/*.svg", "apps/ubuntu.png", false],
    ["fonts/cloudicon/*", "fonts/cloudicon/Cloudicon.woff", true],
    ["img/topbanner*.jpg", "img/topbanner07.jpg", true],
    ["img/topbanner*.jpg", "img/topbanner07.png", false],
    ["js/**", "js/lib/i18next.min.js", true],
    ["js/**", "js/scripts.js", true],
    ["js/**", "js", false],
    ["whmcs-template/**/*.js", "whmcs-template/antler/js/x.js", true],
    ["whmcs-template/**/*.js", "whmcs-template/antler/js/x.css", false],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(matchPattern(pattern, path)).toBe(expected);
  });
});

describe("listFiles", () => {
  const make = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "glob-"));
    made.push(dir);
    return dir;
  };

  it("lists regular files with / separators, sorted by code unit", () => {
    const dir = make();
    mkdirSync(join(dir, "b/c"), { recursive: true });
    mkdirSync(join(dir, "empty"));
    for (const [path, text] of [
      ["b/c/z.txt", "z"],
      ["b/a.txt", "a"],
      ["B.txt", "B"],
      ["a.txt", "a"],
    ] as const)
      writeFileSync(join(dir, path), text);
    expect(listFiles(dir)).toEqual(["B.txt", "a.txt", "b/a.txt", "b/c/z.txt"]);
  });

  it("refuses a symbolic link and a folder that does not exist", () => {
    const dir = make();
    writeFileSync(join(dir, "real.txt"), "x");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    expect(() => listFiles(dir)).toThrow(FileTreeError);
    expect(() => listFiles(dir)).toThrow(/^symlink: link\.txt$/);
    expect(() => listFiles(join(make(), "nope"))).toThrow(FileTreeError);
  });
});
